# Background Teammate Jobs (Design)

**Date:** 2026-07-04
**Status:** Approved (design agreed in conversation) — ready for plan

## Problem

Multi-minute teammate work can't be delivered through a chat-driven poll loop: Diaflow's MCP
proxy caps any single tool call at 30s (`diaflow-backend/modules/mcp/proxy.py`
`_FORWARD_MAX_SECONDS`), so long runs need dozens of ~25s polls, and (a) the orchestrator LLM
won't poll 40+ times, (b) the run's `recursion_limit=225` and per-poll context growth make it
worse. A sequential relay (A→B→C) multiplies this. Result: long tasks stall into "still working."

## Key insight

The 30s cap applies only to the **inbound** path (DeerFlow → our MCP tool call). Our server's
**outbound** calls to Diaflow (`/agent-runtime/completions`, `/agent-runtime/threads/{id}/stream`)
are direct HTTPS with the seal — **not proxied, not capped.** So our server can do a plain
multi-minute `await` (exactly like the Workflow Builder's flow engine) — as long as it happens
**off the tool-call request path**, in a background task. The MCP tools become "start job"
(instant) + "fetch result" (instant), and our server is the deterministic orchestrator.

## Architecture

```
message_teammate / relay_teammates
   → start an in-process background Job, return { status:"working", jobId } fast (< grace)
   → the Job runs runToCompletion() (single) or the A→B→C chain (relay) via plain awaits,
     reconnecting to /threads/{id}/stream through the 60s upstream cuts until each run finishes,
     writing the result into an in-memory JobStore.
get_teammate_reply(jobId)
   → instant JobStore lookup: completed(reply) | working(progress) | failed(error) | unknown
```

The LLM makes ~2 calls (start + fetch), not 40. The work completes server-side regardless of
whether the LLM keeps checking; if it gives up, the result is still retrievable by jobId later.

## Components

1. **`src/teammate/job-store.ts` (new)** — module-singleton `JobStore`.
   - `Job = { id, kind:"message"|"relay", status:"working"|"completed"|"failed", reply?, error?, progress?, createdAt, updatedAt }`.
   - `create(kind) → jobId` (uuid); `get(id)`; `update(id, patch)`; `sweep()` (drop terminal jobs older than `JOB_TTL_MS`, default 30 min; drop working jobs older than a hard max).
   - Concurrency cap: `activeCount()` of `working` jobs; `startJob` rejects over `MAX_ACTIVE_JOBS` (default 8) with a clear error result (protects the free-tier instance).
   - A single unref'd `setInterval` sweep (like the OAuth store), started lazily.

2. **`ConversationsApi.waitForReply(threadId, budgetMs?)`** — add an optional budget param
   (default `this.waitMs`). Background loop passes ~50s (under the 60s LB cut); the tool path is
   unaffected. No other change to its reconnect/`/state`-fallback logic.

3. **`src/teammate/runner.ts` (new)** — deterministic orchestration, no LLM.
   - `runToCompletion(conversations, params, deadline): Promise<RunResult>` — `sendMessage` then
     loop `waitForReply(threadId, RECONNECT_MS)` until `completed`/`failed`/`interrupted` or the
     overall `deadline` (default `JOB_MAX_MS`, 12 min) → returns the terminal result (or `working`
     if the deadline hits). Tracks a coarse progress counter.
   - `runRelay(conversations, steps, message, deadline)` — `let out = message; for step in steps:
     out = (await runToCompletion(step.teammateId, joinInstruction(step, out))).reply`. Each hop's
     reply feeds the next. Returns the final hop's reply; on any hop failure, returns
     `{status:"failed", error, atStep}`.

4. **`src/tools/conversation.ts`** — rewire:
   - `message_teammate(teammateId, message, threadId?, attachmentUrls?, webSearch?)` → `startJob`
     a single run; **race a short grace** (`GRACE_MS`, ~8s): if the job completes within the
     grace, return the plain reply (nice one-call UX for quick tasks); else return
     `{ status:"working", jobId, note }`. The job keeps running.
   - `relay_teammates(steps, message)` (new) — `steps: [{ teammateId, instruction? }]`,
     `message` (initial). Starts a relay job; returns `{ status:"working", jobId, note }`.
   - `get_teammate_reply(jobId)` — re-keyed from threadId to **jobId**; instant `JobStore` lookup.
     `completed` → plain reply; `failed` → error text; `working` → structured `{status, jobId,
     progress}` with a "call again / it will finish server-side" note; unknown jobId → clear error.

5. **`src/config.ts`** — add `MESSAGE_TEAMMATE_JOB_MAX_MS` (720000), keep `MESSAGE_TEAMMATE_WAIT_MS`
   for the tool-path reconnect budget. `GRACE_MS`, `RECONNECT_MS`, `JOB_TTL_MS`, `MAX_ACTIVE_JOBS`
   as module constants (not every knob needs an env var).

## Seal / lifetime

The background job captures the request's `ConversationsApi` (its `DiaflowClient` closes over the
per-user `SealTokenProvider`, which persists `X-Diaflow-Session` rotation into the token store).
The client stays valid after the request returns, and rotation keeps the seal fresh across the
job's many calls. A retrieval request builds a fresh context from the (possibly rotated) stored
seal — consistent. Documented risk: a job longer than the seal's own lifetime could fail late;
`JOB_MAX_MS` (12 min) is well within a WorkOS session.

## Error handling

- Concurrency-cap hit → `message_teammate`/`relay_teammates` return a `failed`-style structured
  result explaining the server is busy (never throw an unhandled error).
- A hop failure in a relay stops the chain and reports which step failed + the error.
- Job not found in `get_teammate_reply` → `{ status:"unknown" }` with guidance.
- Background job exceptions are caught and stored as `failed` (never crash the process).

## Testing

Unit tests with a mocked `ConversationsApi`/fetch:
- JobStore: create/get/update; sweep drops terminal jobs past TTL; concurrency cap.
- runToCompletion: sendMessage completed → done; working→waitForReply loop→completed; deadline →
  working; failed propagates.
- runRelay: 2-step chain feeds hop1 reply into hop2; hop failure stops + reports step.
- Tools: message_teammate completes within grace → plain reply; exceeds grace → {working, jobId};
  relay_teammates → {working, jobId}; get_teammate_reply(jobId) returns store state; unknown jobId.
- Background timing injected (fake timers / injected clock) so tests stay instant.

## Honest limits (unchanged by this design)

- The LLM still makes a **retrieval** call (or two) to pull the finished result into chat; if it
  gives up, the user fetches later by jobId. Not 100% hands-off, but the *work* always completes.
- **Render free tier spins down on ~15 min idle** — an in-flight job can die if no inbound
  requests keep the instance warm (keepalive cron + the orchestrator's own polls mitigate; a paid
  instance removes it). Multi-minute jobs are usually fine; multi-hour are not.
- In-memory store → jobs lost on redeploy (same as tokens).

## Out of scope

- Persistent (Redis/DB) job store; push/callback into the orchestrator run; parallel fan-out to
  many teammates in one call (separate follow-up); changes to auth/transport.
