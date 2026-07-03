# Teammate Reply — SSE Long-Poll & Reconnect (Design)

**Date:** 2026-07-03
**Status:** Approved — ready for implementation plan
**Supersedes the retrieval half of:** `2026-07-03-async-message-teammate-design.md`

## Problem

When teammate A orchestrates teammate B via `message_teammate`, long B runs freeze A.

Root cause, verified against `diaflow-backend`:

- `POST /agent-runtime/completions` with `stream:false` runs `run_agent` **inline in the
  request handler** (`completions.py:1478`). It blocks HTTP until the entire run finishes.
  A multi-minute B run therefore holds our tool→backend call open past Diaflow's proxy
  ceiling (~100s), and the runtime kills it → A freezes.
- The current async workaround (abort at 25s → poll `/sessions` + `/history`) cannot work
  reliably: **neither `/sessions` nor `/history` carries any run-status field**
  (`session.py:946-958`, `agent_message.py:25`). There is no way to tell *running* from
  *completed* from *failed* off those endpoints.
- A **failed** `stream:false` run is invisible: `run_agent` catches the error, yields an
  `EventType.ERROR` that the non-streaming branch silently drops (`completions.py:1493-1522`),
  returns HTTP 200 with empty content, and persists **nothing** to history
  (`agent.py:1023-1064`). A poller sees the conversation frozen at the previous turn.

## Backend mechanism we will use instead

The backend already has a designed "start → disconnect → resume" path — on the **SSE
(`stream:true`)** transport, not the endpoints we use today.

- `POST /agent-runtime/completions` with `stream:true` → `_stream_sse_buffered`
  (`completions.py:679-784`). The httpx→DeerFlow stream runs in a **detached background task**
  (`asyncio.create_task`). When the client disconnects, "the forwarder task keeps the httpx
  connection to DeerFlow alive, continues pushing events into Redis" (`completions.py:693-698`,
  verbatim). Every SSE frame is buffered to Redis `agent-runtime:thread:{thread_id}:events`,
  and `:active` is set (`TTL 600s`).
- `GET /agent-runtime/threads/{thread_id}/stream` → `_replay_and_follow`
  (`thread_stream.py:639,671`). Replays the buffered `:events` (so we catch `final`/`error`
  frames that fired while we were disconnected) then follows live.
- `GET /agent-runtime/threads/{thread_id}/state` (`thread_stream.py:298`) → derived
  `status ∈ {running, completed, interrupted}` (`thread_stream.py:225-244,356-360`). No
  `error`/`failed` status exists. Durable beyond the 600s buffer TTL (reads DeerFlow state).

### Exact SSE frame contract (`completions.py:874-879`, verbatim)

| Frame | Payload | Meaning |
|-------|---------|---------|
| `event: metadata` | `{thread_id, session_id}` | Emitted once, early. Source of the thread id for new runs. |
| `event: final`    | `{content}`             | Terminal — the assistant reply. |
| `event: error`    | `{error}`               | Terminal — run failed. |
| `event: cancelled`| `{...}`                 | Terminal — run was `/stop`-ped. |

All other frames (`thinking`, `skill`, `title`, `usage`, `tool_progress`, `todos`, `openui`,
`tool_confirmation`) are ignored.

## Design

Switch the conversation layer from `stream:false` polling to **`stream:true` start + SSE
reconnect**, with a single reusable SSE reader.

### Components

1. **SSE reader** (`src/diaflow/sse.ts`, new) — given a `Response` whose body is an SSE stream,
   parse frames (`event:` + `data:` lines separated by a blank line) and yield
   `{ event: string, data: unknown }`. Bounded by an `AbortSignal`. Tolerates multi-line
   `data:` and keep-alive comments.

2. **`ConversationsApi.sendMessage`** (rewrite) — `POST /agent-runtime/completions` with
   `stream:true`, consume frames up to `waitMs`:
   - `metadata` → capture `threadId` (always available thereafter, even for new runs).
   - `final`  → `{ status: "completed", threadId, reply }`.
   - `error`  → `{ status: "failed", threadId, error }`.
   - budget elapsed (abort) → `{ status: "working", threadId }`; the detached forwarder keeps
     the run alive server-side.

3. **`ConversationsApi.waitForReply(threadId, budgetMs)`** (new) — `GET /threads/{threadId}/stream`,
   consume the replay+live frames up to `budgetMs`:
   - `final`  → `{ status: "completed", threadId, reply }`.
   - `error`  → `{ status: "failed", threadId, error }`.
   - `cancelled` → `{ status: "interrupted", threadId }`.
   - budget elapsed → `{ status: "working", threadId }`.
   - On a `404` (thread unknown / buffer expired) fall back to `GET /threads/{threadId}/state`:
     `completed` → return its final message as the reply; `interrupted` → interrupted; else
     `working`.

4. **Tools** (`src/tools/conversation.ts`)
   - `message_teammate` — unchanged inputs; on `working`, the hand-off note now instructs
     calling `get_teammate_reply` **with the returned `threadId`** (not the teammateId).
   - `get_teammate_reply` — input becomes `threadId` (was `teammateId`). Calls `waitForReply`.
     Description: "still running → call again with the same threadId; unlimited."
   - `stop_conversation` — unchanged; now genuinely functional (only ever worked for
     `stream:true` runs).

### Config (`src/config.ts`)

- Reuse `MESSAGE_TEAMMATE_WAIT_MS` as the per-call SSE budget; **default `25000 → 90000`**
  (safely under the ~100s proxy ceiling).
- No poll-interval knob is needed — SSE is event-driven, not interval-polled.

### Types (`src/diaflow/types.ts`)

- `RunStatus = "completed" | "working" | "failed" | "interrupted" | "unknown"`.
- `CompletionResult` / `RunResult` gain an optional `error?: string`.

## Data flow

```
message_teammate ──POST /completions stream:true──▶ [detached forwarder → Redis :events]
   │  read frames ≤ waitMs
   ├─ final  → completed(reply)
   ├─ error  → failed(error)
   └─ (timeout) → working(threadId)  ── run continues server-side ──┐
                                                                     │
get_teammate_reply(threadId) ──GET /threads/{id}/stream (replay+follow) ≤ waitMs
   ├─ final → completed(reply)   ├─ error → failed(error)
   ├─ cancelled → interrupted    └─ (timeout) → working → "call again"
   (404 / buffer expired) → GET /threads/{id}/state → completed | interrupted | working
```

## Error handling

- A `failed` run returns structured `{ status: "failed", error }` to A — never a thrown tool
  error — so A can react.
- Transient network errors mid-stream: the SSE reader surfaces the error; `waitForReply`
  treats a dropped connection before any terminal frame as `working` (A retries), not `failed`.
- Backstop: **none by time** (per decision — unlimited resumes). The only terminal exits are
  `final`/`error`/`cancelled`. Budget elapsing yields `working` → resume.

## Testing

Unit tests, mocked `fetch` returning canned SSE bodies (a `ReadableStream` of frame strings):

- SSE reader: single frame; multi-line `data:`; multiple frames; blank-line separation;
  abort mid-stream stops iteration.
- `sendMessage`: `metadata`+`final` → completed; `metadata`+`error` → failed; `metadata` only,
  then abort → `working` with captured threadId; request body has `stream:true` and
  `agent_unique_id` (new) / `thread_id` (continuation) exactly as today.
- `waitForReply`: replay containing `final` → completed; `error` → failed; `cancelled` →
  interrupted; no terminal frame before abort → working; `404` → falls back to `/state`
  (`completed` / `interrupted` / `running`→working).
- Tool wiring: `get_teammate_reply` passes `threadId`; `message_teammate` working-note names
  the returned threadId.

Injected/fake abort timing keeps tests instant. Target ≥80% coverage on `sse.ts` and
`conversations.ts`.

## Residual caveats (backend limitations — documented, not fixable here)

1. **600s TTL window for failure detection.** `:events` and `:active` expire after 600s and
   errors are never persisted. Reliable `failed` detection lives inside that window;
   `completed` is durable (via `/state` or `/history`). A resume >10 min after a *failure*
   degrades to "completed, empty reply."
2. **Recursion-limit failures** are persisted as a normal (partial) assistant message
   (`agent.py:1077-1085`) — indistinguishable from success.
3. **Thread ownership.** `/threads/{id}/state` and `/stream` require the caller's
   `workspace_id + user_id` to match the run's `:owner` (`thread_stream.py:90-114`). Our seal
   is the run initiator's, so ownership holds — including per-user OAuth mode, where each
   user's token maps to their own seal.

## Out of scope

- No change to auth, transport (stateless HTTP stays), or non-conversation tools.
- No SSRF/hardening follow-ups (tracked separately in CLAUDE.md).
