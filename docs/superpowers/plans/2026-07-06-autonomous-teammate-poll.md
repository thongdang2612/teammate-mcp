# Autonomous Teammate-Job Polling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an orchestrator's polling of a background teammate job evade DeerFlow's loop guard by giving every poll a unique `pollToken` argument (plus longer per-call block windows), so multi-minute relays finish without a "say continue" prompt.

**Architecture:** All changes live in `src/tools/conversation.ts`. Add two pure helpers (`makePollToken`/`parsePollToken`) that encode a rotating poll counter into the id the orchestrator passes back (`<jobId>::p<N>`). `get_teammate_reply` accepts a raw jobId OR a token, resolves the real id, and on a still-working job returns a fresh token + elapsed time + poll number so consecutive calls differ. `message_teammate`/`relay_teammates` seed the first token and steer the model to keep polling. Block windows increase toward (but stay under) the 30s proxy cap.

**Tech Stack:** TypeScript (ESM/NodeNext), `@modelcontextprotocol/sdk`, Zod v4, Vitest.

## Global Constraints

- Every inbound-blocking window stays strictly **under the 30s Diaflow proxy cap** (`GRACE_MS`=24000, `REPLY_WAIT_MS`=26000 — leaving ~4–6s headroom; a tuning constant, dial back to 22000/24000 if a call ever exceeds 30s).
- Token format is exactly `<jobId>::p<N>` (N = 1-based next poll number).
- A raw jobId (no `::p<N>` suffix) must still resolve correctly (poll number 0) — backward compatible.
- No changes to `src/teammate/job-store.ts` or `src/teammate/runner.ts`; no reference-repo (`diaflow-backend`/`diaflow-expo`) changes; no secrets.
- Vitest mocks whose `.mock.calls` are inspected use typed params `(_a?: ..., _b?: ...)` per repo convention (strict tsc includes tests).
- `Job.createdAt` is epoch **ms** (`number`); `deps.now()` returns a `Date`. Elapsed = `now().getTime() - job.createdAt`.

## File Structure

- **Modify only** `src/tools/conversation.ts` — add helpers; change `GRACE_MS`/`REPLY_WAIT_MS`; rewire `get_teammate_reply`, `message_teammate`, `relay_teammates` working responses + descriptions.
- **Modify** `tests/tools/conversation.test.ts` — add helper + behavior tests; adjust existing working-branch assertions to the new shape.

## Current code being changed (for reference — do not re-derive)

`src/tools/conversation.ts:13-16`:
```ts
const GRACE_MS = 8000;
const REPLY_WAIT_MS = 20000;
```
`get_teammate_reply` handler (`:126-141`):
```ts
async (args) => {
  if (!store.get(args.jobId)) {
    return asText({ status: "unknown", note: "No job with that id — it may have expired or the server restarted. Start again with message_teammate or relay_teammates." });
  }
  const job = (await awaitJob(store, args.jobId, replyWaitMs))!;
  if (job.status === "completed") return asText(job.reply ?? "");
  if (job.status === "failed") return asText(`The teammate's run failed: ${job.error ?? "unknown error"}`);
  return asText({
    status: "working",
    jobId: job.id,
    progress: job.progress,
    note: `Still running server-side. Call get_teammate_reply with jobId "${job.id}" again shortly — it will finish even if you wait.`,
  });
}
```
`message_teammate` working return (`:75-79`) and `relay_teammates` working return (`:106-110`) currently return `{ status:"working", jobId, note }`.
`now` is available in the handler scope as `const now = deps.now ?? (() => new Date());` (`:35`).

---

### Task 1: pollToken helpers

**Files:**
- Modify: `src/tools/conversation.ts` (add two exported helpers near the top, after `asText`)
- Test: `tests/tools/conversation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `makePollToken(jobId: string, nextPoll: number): string` → `"<jobId>::p<nextPoll>"`.
  - `parsePollToken(raw: string): { jobId: string; pollNumber: number }` — if `raw` ends with a `::p<digits>` suffix, returns the id before `::` and that number; otherwise returns `{ jobId: raw, pollNumber: 0 }`.

- [ ] **Step 1: Write the failing test** — add to `tests/tools/conversation.test.ts` (top-level, after the existing imports add `makePollToken, parsePollToken` to the import from `../../src/tools/conversation.js`):

```ts
describe("pollToken helpers", () => {
  it("makePollToken encodes the job id and next poll number", () => {
    expect(makePollToken("abc", 1)).toBe("abc::p1");
    expect(makePollToken("abc", 7)).toBe("abc::p7");
  });

  it("parsePollToken returns poll 0 for a raw job id", () => {
    expect(parsePollToken("abc-123")).toEqual({ jobId: "abc-123", pollNumber: 0 });
  });

  it("parsePollToken extracts the id and poll number from a token", () => {
    expect(parsePollToken("abc-123::p4")).toEqual({ jobId: "abc-123", pollNumber: 4 });
  });

  it("parsePollToken treats a malformed suffix as a raw id (poll 0)", () => {
    expect(parsePollToken("abc::pX")).toEqual({ jobId: "abc::pX", pollNumber: 0 });
    expect(parsePollToken("abc::")).toEqual({ jobId: "abc::", pollNumber: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/conversation.test.ts -t "pollToken helpers"`
Expected: FAIL — `makePollToken`/`parsePollToken` not exported.

- [ ] **Step 3: Add the helpers** to `src/tools/conversation.ts`, immediately after the `asText` definition (`:11`):

```ts
/** Encode the next poll number into the id the orchestrator passes back, so each poll's args differ. */
export function makePollToken(jobId: string, nextPoll: number): string {
  return `${jobId}::p${nextPoll}`;
}

/** Recover the real job id + current poll number from a raw jobId or a "<jobId>::p<N>" token. */
export function parsePollToken(raw: string): { jobId: string; pollNumber: number } {
  const idx = raw.lastIndexOf("::p");
  if (idx > 0) {
    const suffix = raw.slice(idx + 3);
    if (/^\d+$/.test(suffix)) return { jobId: raw.slice(0, idx), pollNumber: Number(suffix) };
  }
  return { jobId: raw, pollNumber: 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/conversation.test.ts -t "pollToken helpers"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tools/conversation.ts tests/tools/conversation.test.ts
git commit -m "feat(conversation): pollToken helpers for rotating poll ids"
```

---

### Task 2: rotating-token polling + longer windows in the three tools

**Files:**
- Modify: `src/tools/conversation.ts` (`GRACE_MS`, `REPLY_WAIT_MS`, `get_teammate_reply`, `message_teammate`/`relay_teammates` working responses + descriptions)
- Test: `tests/tools/conversation.test.ts`

**Interfaces:**
- Consumes: `makePollToken`, `parsePollToken` (Task 1); `awaitJob`, `startJob`, `raceGrace` (existing); `store.get`, `job.createdAt`, `job.id` (existing); `now(): Date` (handler scope).
- Produces: `get_teammate_reply` working response shape `{ status:"working", jobId, pollToken, pollNumber, elapsedSeconds, note }`; `message_teammate`/`relay_teammates` working responses gain `pollToken`.

- [ ] **Step 1: Write the failing tests** — add to `tests/tools/conversation.test.ts`:

```ts
describe("get_teammate_reply rotating token", () => {
  it("returns a fresh pollToken + elapsed for a still-working job (raw jobId → poll 1)", async () => {
    const store = new JobStore(() => 1_000_000);          // createdAt = 1_000_000 ms
    const job = store.create("message");                  // still "working"
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, {
      conversations: {} as any, client: {} as any,
      jobStore: store, replyWaitMs: 5, now: () => new Date(1_042_000), // 42s later
    } as any);
    const out = await tools["get_teammate_reply"]({ jobId: job.id });
    const body = JSON.parse(out.content[0].text);
    expect(body.status).toBe("working");
    expect(body.pollNumber).toBe(0);
    expect(body.pollToken).toBe(`${job.id}::p1`);
    expect(body.elapsedSeconds).toBe(42);
    expect(body.note).toContain("not a loop");
  });

  it("accepts a token and increments the poll number", async () => {
    const store = new JobStore(() => 0);
    const job = store.create("message");
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, {
      conversations: {} as any, client: {} as any,
      jobStore: store, replyWaitMs: 5, now: () => new Date(0),
    } as any);
    const out = await tools["get_teammate_reply"]({ jobId: `${job.id}::p2` });
    const body = JSON.parse(out.content[0].text);
    expect(body.pollNumber).toBe(2);
    expect(body.pollToken).toBe(`${job.id}::p3`);
  });

  it("resolves a completed job even when addressed by token", async () => {
    const store = new JobStore(() => 0);
    const job = store.create("message");
    store.update(job.id, { status: "completed", reply: "done!" });
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations: {} as any, client: {} as any, jobStore: store, replyWaitMs: 5 } as any);
    const out = await tools["get_teammate_reply"]({ jobId: `${job.id}::p5` });
    expect(out.content[0].text).toBe("done!");
  });

  it("message_teammate working response includes a p1 pollToken", async () => {
    const conversations = { sendMessage: vi.fn(async () => ({ status: "working" as const, threadId: "T" })), waitForReply: vi.fn(async () => ({ status: "working" as const, threadId: "T" })) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any, uploadChatAttachment: vi.fn(), jobStore: new JobStore(), graceMs: 5 } as any);
    const out = await tools["message_teammate"]({ teammateId: "u1", message: "long" });
    const body = JSON.parse(out.content[0].text);
    expect(body.status).toBe("working");
    expect(body.pollToken).toBe(`${body.jobId}::p1`);
  });
});
```

(`fakeServer`, `JobStore`, `vi` are already imported in this file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tools/conversation.test.ts -t "rotating token"`
Expected: FAIL — no `pollToken`/`pollNumber`/`elapsedSeconds` fields; token-addressed lookup returns "unknown".

- [ ] **Step 3: Bump the block windows** — `src/tools/conversation.ts:13-16`:

```ts
/** How long message_teammate holds the tool response, hoping a quick task finishes in one call. Under the 30s proxy cap. */
const GRACE_MS = 24000;
/** How long get_teammate_reply blocks waiting for a job — under Diaflow's 30s MCP-proxy cap. */
const REPLY_WAIT_MS = 26000;
```

- [ ] **Step 4: Rewire `get_teammate_reply`** — replace its handler (`:126-141`) with:

```ts
    async (args) => {
      const { jobId: realId, pollNumber } = parsePollToken(args.jobId);
      if (!store.get(realId)) {
        return asText({ status: "unknown", note: "No job with that id — it may have expired or the server restarted. Start again with message_teammate or relay_teammates." });
      }
      // Block for a real window (under the 30s proxy cap) so this poll WAITS for the job.
      const job = (await awaitJob(store, realId, replyWaitMs))!;
      if (job.status === "completed") return asText(job.reply ?? "");
      if (job.status === "failed") return asText(`The teammate's run failed: ${job.error ?? "unknown error"}`);
      // Hand back a FRESH token so the next poll's args differ (evades the orchestrator
      // runtime's repeated-identical-call loop guard) and surface progress so the model keeps going.
      const elapsedSeconds = Math.round((now().getTime() - job.createdAt) / 1000);
      const pollToken = makePollToken(job.id, pollNumber + 1);
      return asText({
        status: "working",
        jobId: job.id,
        pollToken,
        pollNumber,
        elapsedSeconds,
        note: `Background job still running (${elapsedSeconds}s elapsed, poll ${pollNumber}). This is a polling PROTOCOL, not a loop — call get_teammate_reply again with pollToken "${pollToken}" until status is "completed". Do NOT stop or ask the user to continue.`,
      });
    },
```

Also update its description + input schema (`:117-124`) to:

```ts
      description:
        "Fetch the result of a background teammate job started by message_teammate or relay_teammates. " +
        "Pass the pollToken from the previous response (or the jobId on the first call). Returns the reply " +
        "as plain text when done. While it runs it returns { status: \"working\", pollToken, elapsedSeconds } — " +
        "call this tool AGAIN with the new pollToken. Repeated polling with the rotating pollToken is the " +
        "REQUIRED protocol and is NOT a loop; keep going until status is \"completed\". Never stop or ask the " +
        "user to continue.",
      inputSchema: {
        jobId: z.string().min(1).describe("The pollToken from the previous get_teammate_reply response, or the jobId from message_teammate/relay_teammates on the first call."),
      },
```

- [ ] **Step 5: Seed the token in `message_teammate`** — replace its working return (`:75-79`) with:

```ts
      return asText({
        status: "working",
        jobId,
        pollToken: makePollToken(jobId, 1),
        note: `The teammate is working in the background. Call get_teammate_reply with pollToken "${makePollToken(jobId, 1)}" to fetch the result. Keep calling get_teammate_reply with each new pollToken it returns until status is "completed" — this is the expected protocol, not a loop; do NOT stop or ask the user to continue.`,
      });
```

- [ ] **Step 6: Seed the token in `relay_teammates`** — replace its working return (`:106-110`) with:

```ts
      return asText({
        status: "working",
        jobId,
        pollToken: makePollToken(jobId, 1),
        note: `Relay started across ${steps.length} teammate(s), running in the background. Call get_teammate_reply with pollToken "${makePollToken(jobId, 1)}", then keep calling it with each new pollToken it returns until status is "completed" — this is the expected protocol, not a loop; do NOT stop or ask the user to continue.`,
      });
```

- [ ] **Step 7: Fix any existing working-branch assertions.** Run the whole file and update any pre-existing test that asserted the OLD working note/shape. The `jobId` and `status:"working"` fields remain, so assertions using `.toContain("working")` / the jobId still pass; only a test that pinned the exact old note string (`"Still running server-side"` or `"working in the background. Call get_teammate_reply with jobId"`) needs its expectation changed to match the new note (which references `pollToken`).

Run: `npx vitest run tests/tools/conversation.test.ts`
Expected: PASS (all — new rotating-token tests + previously-existing tests, adjusted if needed).

- [ ] **Step 8: Type-check + full suite**

Run: `npm run build && npm test`
Expected: build clean; full suite passes.

- [ ] **Step 9: Commit**

```bash
git add src/tools/conversation.ts tests/tools/conversation.test.ts
git commit -m "feat(conversation): rotating pollToken + longer windows to evade the orchestrator loop guard"
```

---

## Self-Review

**1. Spec coverage:**
- Rotating pollToken (§Approach 1) → Task 1 (helpers) + Task 2 Step 4/5/6. ✅
- Vary working response w/ elapsed + poll number (§2) → Task 2 Step 4 (elapsedSeconds, pollNumber, pollToken, note). ✅
- Longer block windows under cap (§3) → Task 2 Step 3 (24000/26000). ✅
- Guidance on message_teammate/relay (§4) → Task 2 Steps 5/6 + get_teammate_reply description Step 4. ✅
- Backward compatible raw jobId → parsePollToken poll-0 path (Task 1) + completed-by-token test (Task 2). ✅
- Error handling (unknown/completed/failed unchanged; malformed token → whole string → unknown) → parsePollToken malformed test (Task 1) + get_teammate_reply guard uses parsed id (Task 2 Step 4). ✅
- Testing list (§Testing) → Task 1 + Task 2 tests cover parse (raw/token/malformed), make, raw→p1, token→increment, completed-by-token, message_teammate p1. ✅

**2. Placeholder scan:** No TBD/TODO; every code step shows full code. Step 7 references concrete old-note strings to search for rather than a vague "update tests." ✅

**3. Type consistency:** `makePollToken(jobId, nextPoll)` / `parsePollToken(raw) → {jobId, pollNumber}` identical across Task 1 and Task 2. `job.createdAt` (number ms) minus `now().getTime()` — consistent with Global Constraints. `JobStore(() => n)` constructor takes a `() => number` (matches `job-store.ts:34`). ✅
