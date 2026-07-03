# Design: Async `message_teammate` (bounded wait + poll)

- **Date:** 2026-07-03
- **Status:** Approved (design), pending implementation plan
- **Area:** `src/diaflow/conversations.ts`, `src/tools/conversation.ts`, `src/config.ts`, `src/diaflow/types.ts`

## Problem

`message_teammate` calls `POST /agent-runtime/completions` with `stream:false` and **awaits the full run** before returning the reply to the orchestrator teammate. This works for short replies ("say hello to B") but **freezes the orchestrator on long agentic tasks**: the target's run outlives the HTTP/proxy timeout between the MCP server and Diaflow (onrender/Cloudflare cap long requests ~100s; multi-minute agentic runs exceed it). The target finishes server-side (visible in its own chat), but our blocking call never receives a closing response, so `message_teammate` never returns — the orchestrator hangs "in process," and no `tools/call:message_teammate` finish line is ever logged (the request is stuck in flight).

Confirmed via server logs: short task → `rpc=tools/call:message_teammate -> 200`; long task → no finish line, orchestrator frozen.

## Backend facts that make this fixable

The agent-runtime is stream + Redis-buffer based (`modules/agent_runtime/thread_stream.py`):
- A run streams SSE; events are buffered in Redis under `agent-runtime:thread:{thread_id}:events`.
- `agent-runtime:thread:{thread_id}:active` = `"1"` while a run is in progress (TTL 600s).
- Resume/read endpoints exist: `GET /threads/{thread_id}/state`, `GET /threads/{thread_id}/stream`; history via `GET /agent-runtime/sessions/{id}/history`.

So a run **continues server-side after our request ends**, and its state + result can be fetched later by `thread_id`. (`session_id == thread_id` in this runtime.)

## Goal

Make `message_teammate` non-blocking for long tasks while keeping short pings instant, using a **hybrid bounded-wait + poll** model. No change to how the MCP authenticates or how the run itself executes on Diaflow.

## Behavior

`message_teammate({ teammateId?, message, threadId?, files?, webSearch? })` blocks up to a bounded wait `MESSAGE_TEAMMATE_WAIT_MS` (default 25000):

- **Reply within the bound** → `{ status: "completed", threadId, reply, usage? }` (today's instant behavior for short tasks — preserved).
- **Exceeds the bound** → `{ status: "working", threadId, note: "Target teammate is still processing. Call get_teammate_reply with this threadId to fetch the result once ready." }`. The target's run continues server-side.

New tool `get_teammate_reply({ threadId, waitMs? })` polls one run:
- Still running → `{ status: "working", threadId }`.
- Done → `{ status: "completed", threadId, reply }`.
- Unknown/expired thread (past the 600s TTL, or never existed) → `{ status: "unknown", threadId, note: "..." }`.

The orchestrator calls `get_teammate_reply` (optionally repeatedly) until `completed`. Tool descriptions explicitly instruct this hand-off (same technique that fixed the earlier id-resolution loop): `message_teammate`'s description states that a `working` result means it must follow up with `get_teammate_reply`.

## Mechanism — obtaining a `threadId` before the run finishes

The core requirement: return a valid `threadId` to poll on **even when the run hasn't finished**. Today `thread_id` is only known once the blocking call returns.

**Primary approach — client-supplied `thread_id`:** generate a UUID client-side, send it as `thread_id` in the completions request, and race the request against the wait bound via `AbortController`:
- Request resolves first → return `{ status: "completed", ... }` with the reply.
- Wait bound fires first → abort our read and return `{ status: "working", threadId }` (the generated id). The run continues server-side (confirmed behavior).

**Verification gate (plan Task 0):** the primary approach requires the backend to **honor a caller-supplied new `thread_id`** (create the thread under that id) and expose the result under it. This is unverified. The implementation plan's first task is a **live probe** against `api-dev` (with a real seal) to confirm:
1. `POST /agent-runtime/completions` with a client `thread_id` uses that id (echoes it back / the run is retrievable under it).
2. The run's state + final reply are fetchable by that id via `getHistory` and/or `GET /threads/{id}/state`.

**Fallback (if the backend assigns its own id):** issue the request with `stream:true`, read the SSE until the early event carrying the real `thread_id`, capture it, then either keep reading up to the bound for the final assistant message (fast path) or stop and return `{ working, threadId }`. Same external behavior; only the id-acquisition differs. The plan picks the branch based on Task 0's result.

## Result retrieval (`getRunResult`)

`getRunResult(threadId)` determines status + reply, using whichever Task 0 confirms reliable:
- **Status:** running vs done — via `GET /threads/{threadId}/state` (or absence of an in-progress marker / presence of a final assistant message in history).
- **Reply:** the latest assistant message from `GET /agent-runtime/sessions/{threadId}/history`.

Returns `{ status: "working" | "completed" | "unknown", reply? }`.

## Components (small, focused)

- **`src/config.ts`** — add `MESSAGE_TEAMMATE_WAIT_MS` (zod, default 25000, positive int).
- **`src/diaflow/conversations.ts`** — `sendMessage` gains a bounded wait + client-supplied `thread_id` + `AbortController`, returning the hybrid `CompletionResult`. Add `getRunResult(threadId)`.
- **`src/diaflow/types.ts`** — extend `CompletionResult`: `status: "completed" | "working"`, `threadId`, `reply?`, `usage?`; add `RunResult` for `getRunResult`.
- **`src/tools/conversation.ts`** — `message_teammate` returns the hybrid shape with a hand-off note; add `get_teammate_reply` tool (schema `{ threadId: string, waitMs?: number }`) with a description telling the orchestrator to poll until completed.

## Error handling

- Timeout/abort is a **normal** outcome (→ `working`), never surfaced as an error.
- Genuine Diaflow failures (4xx/5xx) still throw `DiaflowHttpError` and surface to the caller.
- `get_teammate_reply` on an unknown/expired thread → `{ status: "unknown" }` with a clear note (600s TTL means very old handles may be gone).
- The bounded wait uses a real timer + `AbortController`; aborting must not leak the fetch or crash the stateless request handler.

## Testing

Vitest, mocked `fetch` (no live backend), matching existing style + ~80% bar:
- Fast path: mocked completions resolves before the bound → `status:"completed"` + reply.
- Slow path: mocked completions never resolves within the bound → `status:"working"` + the client-supplied `threadId`, and the abort fires.
- `get_teammate_reply`: mocked state/history → `working`, then `completed` with reply; unknown thread → `unknown`.
- Config: `MESSAGE_TEAMMATE_WAIT_MS` default + override.
- Tool wiring: `message_teammate` returns the hand-off note on `working`; `get_teammate_reply` registered and forwards `threadId`.

The live-backend confirmations (Task 0) are one-time manual probes recorded in the plan, not automated tests.

## Non-goals / trade-offs

- No streaming of partial output to the orchestrator — only start + poll for the final reply.
- The orchestrator must *choose* to poll; we guide it via tool descriptions but can't force model behavior.
- 600s `:active` TTL bounds how long a handle stays pollable; extremely long runs beyond that are out of scope for v1.
- No persistence of thread handles in the MCP (stateless; the handle is just the Diaflow `thread_id` returned to the caller).
