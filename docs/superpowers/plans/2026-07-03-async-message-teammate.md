# Async `message_teammate` (bounded wait + poll) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `message_teammate` non-blocking for long target runs — return the reply directly if it lands within a bounded wait, otherwise hand back a `thread_id` the orchestrator polls via a new `get_teammate_reply` tool — so a long sub-agent task no longer freezes the orchestrator.

**Architecture:** `sendMessage` sends a client-supplied `thread_id`, races the `stream:false` completions call against `MESSAGE_TEAMMATE_WAIT_MS` via `AbortController`; on timeout it returns `{status:"working", threadId}` (the run continues server-side, Redis-buffered). `get_teammate_reply(threadId)` fetches run state + latest assistant message. A Task-0 live probe verifies the backend honors a client `thread_id` and pins the retrieval shapes before code depends on them.

**Tech Stack:** TypeScript (ESM/NodeNext, Node ≥20), `@modelcontextprotocol/sdk`, Zod v4, Vitest, `node:crypto` (`randomUUID`), `AbortController` (global, Node ≥20).

## Global Constraints

- Node ≥ 20; ESM only; NodeNext imports use explicit `.js` extensions.
- No mutation of existing objects — return new copies.
- No `console.log` in production code. Tests are in the strict `tsc` build (tsconfig include=["src","tests"]).
- Strict-TS `vi.fn` fetch mocks read via `.mock.calls` need typed params: `vi.fn(async (_url?: string, _init?: RequestInit) => …)`.
- Diaflow envelope is `{ data, message, status }`; `DiaflowClient.request` returns the parsed body; errors become `DiaflowHttpError`.
- `session_id === thread_id` in the agent-runtime; runs are Redis-buffered with `agent-runtime:thread:{thread_id}:active` = `"1"` (TTL 600s).
- Default bounded wait `MESSAGE_TEAMMATE_WAIT_MS = 25000`.
- Timeout/abort is a NORMAL outcome (`status:"working"`), never surfaced as an error; genuine 4xx/5xx still throw `DiaflowHttpError`.

## File Structure

- **`src/config.ts`** (modify) — add `MESSAGE_TEAMMATE_WAIT_MS`; expose `messageWaitMs`.
- **`src/diaflow/types.ts`** (modify) — extend `CompletionResult`; add `RunResult`.
- **`src/diaflow/client.ts`** (modify) — `request` accepts an optional `signal: AbortSignal`.
- **`src/diaflow/conversations.ts`** (modify) — `ConversationsApi` takes `waitMs`; `sendMessage` does bounded wait + client `thread_id`; add `getRunResult`.
- **`src/tools/context.ts`** (modify) — pass `cfg.messageWaitMs` into `ConversationsApi`.
- **`src/tools/conversation.ts`** (modify) — `message_teammate` returns the hybrid result + hand-off note; add `get_teammate_reply` tool.
- **`README.md`** (modify) — tool inventory + note.
- Tests: `tests/diaflow/conversations.test.ts` (create/extend), `tests/tools/conversation.test.ts` (create/extend), `tests/config.test.ts` (extend).

---

## Task 0: Live probe — confirm client `thread_id` + retrieval shapes (verification gate)

**Files:** none (records findings). This gates Tasks 3–4.

**Why:** the design's primary mechanism assumes the backend (a) honors a caller-supplied new `thread_id` and (b) exposes the run's status + final reply under it. Confirm before building.

- [ ] **Step 1: Obtain a real seal + workspace** for `api-dev` (from the operator; a WorkOS sealed session `gAAAA…` valid on `https://api-dev.diaflow.io`, workspace id e.g. `1564`, and a target teammate `uniqueId`).

- [ ] **Step 2: Probe — does a client-supplied `thread_id` get honored?**

```bash
BASE=https://api-dev.diaflow.io ; SEAL='<seal>' ; WS=1564 ; TARGET='<teammate uniqueId>'
TID=$(uuidgen)
echo "sent thread_id=$TID"
curl -sS -X POST "$BASE/api/v1/agent-runtime/completions" \
  -H "X-Client: native" -H "Authorization: Bearer $SEAL" -H "Workspace-Id: $WS" \
  -H "Content-Type: application/json" \
  -d "{\"agent_unique_id\":\"$TARGET\",\"thread_id\":\"$TID\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: pong\"}]}" \
  --max-time 60 | python3 -c 'import sys,json;d=json.load(sys.stdin);print("returned thread_id:",d.get("thread_id") or d.get("session_id"));print("reply:",(d.get("choices") or [{}])[0].get("message",{}).get("content"))'
```
Expected: the returned `thread_id`/`session_id` **equals** the `$TID` we sent. Record: does it match? (If not → the client-supplied-id primary path is invalid; use the fallback in Step 4.)

- [ ] **Step 3: Probe — fetch status + reply by that `thread_id`.**

```bash
curl -sS "$BASE/api/v1/agent-runtime/sessions/$TID/history?limit=10" \
  -H "X-Client: native" -H "Authorization: Bearer $SEAL" -H "Workspace-Id: $WS" --max-time 30 \
  | python3 -m json.tool | head -60
curl -sS -o /dev/null -w "state endpoint: %{http_code}\n" "$BASE/api/v1/threads/$TID/state" \
  -H "X-Client: native" -H "Authorization: Bearer $SEAL" -H "Workspace-Id: $WS" --max-time 30
```
Record verbatim: the JSON path to the message list and to each message's `role`/`content`, and whether a status/`active` signal is available (history shape vs `/threads/{id}/state`). Tasks 3–4 use exactly these paths.

- [ ] **Step 4: Decide the branch and record it in `.git/sdd/progress.md`:**
  - **PRIMARY (client id honored):** Task 3 sends `thread_id` = a generated UUID.
  - **FALLBACK (backend assigns its own id):** Task 3 instead issues `stream:true`, reads the SSE until the first event carrying the real `thread_id`, captures it, and (fast path) keeps reading up to the bound for the final message. Record the SSE event name/shape that carries `thread_id`.
  - Record the exact history JSON path for the latest assistant message and the status signal chosen for `getRunResult`.

- [ ] **Step 5: Commit the recorded findings** (append to the progress ledger; no source changes in this task).

> The tasks below are written for the PRIMARY branch. If Step 4 selects FALLBACK, adjust only Task 3's `sendMessage` id-acquisition (send `stream:true`, capture id from the first SSE event) — the return shapes, config, types, tool layer, and tests are identical.

---

## Task 1: Config — `MESSAGE_TEAMMATE_WAIT_MS`

**Files:** Modify `src/config.ts`; Test `tests/config.test.ts`.

**Interfaces:**
- Produces: `AppConfig.messageWaitMs: number` (default 25000).

- [ ] **Step 1: Write the failing test**

```ts
// tests/config.test.ts (add)
it("messageWaitMs defaults to 25000 and honors override", () => {
  const base = { DIAFLOW_API_BASE: "https://api-dev.diaflow.io", MCP_TRANSPORT: "stdio" };
  expect(loadConfig({ ...base }).messageWaitMs).toBe(25000);
  expect(loadConfig({ ...base, MESSAGE_TEAMMATE_WAIT_MS: "40000" }).messageWaitMs).toBe(40000);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL (`messageWaitMs` undefined).

- [ ] **Step 3: Implement**

In `src/config.ts` add to the zod schema (next to `MCP_HTTP_PORT`):
```ts
MESSAGE_TEAMMATE_WAIT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(25000)),
```
Add to the object returned by `loadConfig`:
```ts
messageWaitMs: parsed.MESSAGE_TEAMMATE_WAIT_MS,
```
Add to the `AppConfig` interface:
```ts
messageWaitMs: number;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/config.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add MESSAGE_TEAMMATE_WAIT_MS (default 25s)"
```

---

## Task 2: Types — hybrid `CompletionResult` + `RunResult`

**Files:** Modify `src/diaflow/types.ts`; Test `tests/diaflow/types-compile.test.ts` (create — a compile/shape guard).

**Interfaces:**
- Produces:
  - `type RunStatus = "completed" | "working" | "unknown"`
  - `interface CompletionResult { status: RunStatus; threadId: string; reply?: string; usage?: { totalTokens?: number } }`
  - `interface RunResult { status: RunStatus; threadId: string; reply?: string }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/diaflow/types-compile.test.ts
import { describe, it, expect } from "vitest";
import type { CompletionResult, RunResult, RunStatus } from "../../src/diaflow/types.js";

describe("async conversation types", () => {
  it("allow working (no reply) and completed (with reply) shapes", () => {
    const working: CompletionResult = { status: "working", threadId: "t1" };
    const done: CompletionResult = { status: "completed", threadId: "t1", reply: "hi" };
    const run: RunResult = { status: "unknown", threadId: "t1" };
    const s: RunStatus = "completed";
    expect([working.status, done.reply, run.status, s]).toEqual(["working", "hi", "unknown", "completed"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/diaflow/types-compile.test.ts`
Expected: FAIL (tsc: `status` not on `CompletionResult`, `RunResult`/`RunStatus` missing).

- [ ] **Step 3: Implement**

In `src/diaflow/types.ts` replace the existing `CompletionResult` (currently `{ threadId; reply; usage? }`) with:
```ts
export type RunStatus = "completed" | "working" | "unknown";

export interface CompletionResult {
  status: RunStatus;
  threadId: string;
  reply?: string;
  usage?: { totalTokens?: number };
}

export interface RunResult {
  status: RunStatus;
  threadId: string;
  reply?: string;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/diaflow/types-compile.test.ts` → PASS. Then `npm run build` — expect tsc errors ONLY in `conversations.ts` (its old `sendMessage` return no longer matches). Those are fixed in Task 3; note them and proceed.

- [ ] **Step 5: Commit**

```bash
git add src/diaflow/types.ts tests/diaflow/types-compile.test.ts
git commit -m "feat(types): hybrid CompletionResult status + RunResult"
```

---

## Task 3: `conversations.ts` bounded wait + client `thread_id` + `getRunResult` (+ client signal)

**Files:** Modify `src/diaflow/client.ts`, `src/diaflow/conversations.ts`, `src/tools/context.ts`; Test `tests/diaflow/conversations.test.ts`.

**Interfaces:**
- Consumes: `CompletionResult`, `RunResult`, `RunStatus` (Task 2); `AppConfig.messageWaitMs` (Task 1).
- Produces:
  - `DiaflowClient.request(method, path, opts?)` where `opts` gains `signal?: AbortSignal`.
  - `new ConversationsApi(client, waitMs)` (waitMs defaults to 25000 if omitted, so existing callers/tests without it still compile).
  - `sendMessage(params): Promise<CompletionResult>` — returns `{status:"completed",…}` if the run finishes within `waitMs`, else `{status:"working", threadId}`.
  - `getRunResult(threadId: string): Promise<RunResult>`.

- [ ] **Step 1: Write the failing tests**

> Injecting a mock fetch: the test below passes `fetchImpl` to `DiaflowClient`. First confirm `DiaflowClient`'s constructor accepts a `fetchImpl` option (check `src/diaflow/client.ts` — mirror how existing client tests stub fetch). If it does NOT, replace `clientWith(fetchImpl)` with a real `DiaflowClient({ baseUrl, getToken, getWorkspaceId, onRotate })` and stub the global via `vi.stubGlobal("fetch", fetchImpl)` (typed `(_url?: string, _init?: RequestInit)`), `vi.unstubAllGlobals()` in `afterEach`.

```ts
// tests/diaflow/conversations.test.ts
import { describe, it, expect, vi } from "vitest";
import { ConversationsApi } from "../../src/diaflow/conversations.js";
import { DiaflowClient } from "../../src/diaflow/client.js";

function clientWith(fetchImpl: typeof fetch): DiaflowClient {
  return new DiaflowClient({
    baseUrl: "https://api-dev.diaflow.io",
    getToken: async () => "seal",
    getWorkspaceId: () => 1564,
    onRotate: () => {},
    fetchImpl,
  });
}
const okJson = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("ConversationsApi.sendMessage (hybrid)", () => {
  it("returns completed with the reply when the run finishes within the wait bound", async () => {
    const fetchImpl = vi.fn(async (_url?: string, _init?: RequestInit) =>
      okJson({ thread_id: "server-tid", choices: [{ message: { content: "pong" } }], usage: { total_tokens: 5 } })) as unknown as typeof fetch;
    const api = new ConversationsApi(clientWith(fetchImpl), 25000);
    const r = await api.sendMessage({ teammateId: "B", message: "hi" });
    expect(r).toMatchObject({ status: "completed", reply: "pong" });
    expect(r.threadId).toBeTruthy();
  });

  it("returns working with the client thread_id when the run exceeds the wait bound", async () => {
    // fetch that respects the abort signal: rejects with an AbortError when aborted, never resolves otherwise.
    const fetchImpl = vi.fn((_url?: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })) as unknown as typeof fetch;
    const api = new ConversationsApi(clientWith(fetchImpl), 20); // tiny bound
    const r = await api.sendMessage({ teammateId: "B", message: "long task" });
    expect(r.status).toBe("working");
    expect(r.threadId).toMatch(/[0-9a-f-]{36}/); // client-generated uuid
    expect(r.reply).toBeUndefined();
  });

  it("getRunResult reports working while active and completed with the latest assistant reply", async () => {
    // First call: still running (no assistant message yet); second: has an assistant reply.
    const responses = [
      okJson({ data: { results: [{ role: "user", content: "long task" }] } }),
      okJson({ data: { results: [{ role: "user", content: "long task" }, { role: "assistant", content: "done: analysis" }] } }),
    ];
    const fetchImpl = vi.fn(async (_url?: string, _init?: RequestInit) => responses.shift()!) as unknown as typeof fetch;
    const api = new ConversationsApi(clientWith(fetchImpl), 25000);
    expect((await api.getRunResult("t1")).status).toBe("working");
    const done = await api.getRunResult("t1");
    expect(done).toMatchObject({ status: "completed", reply: "done: analysis" });
  });
});
```

> The `getRunResult` test encodes the assumed history shape `{ data: { results: [{role, content}] } }`. **Adjust the fetched JSON path in Step 3 and this test to the EXACT shape recorded in Task 0, Step 3** (both must agree). The status rule is: completed iff there is an assistant message after the last user message; otherwise working.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/diaflow/conversations.test.ts`
Expected: FAIL (constructor arity / `status` missing / `getRunResult` undefined).

- [ ] **Step 3: Implement**

**(a) `src/diaflow/client.ts`** — add `signal` passthrough. In the options type for `request`, add `signal?: AbortSignal;` and include it in the `fetch` call:
```ts
const res = await this.fetchImpl(url, { method, headers, body, signal: opts.signal });
```
(Leave all existing behavior — headers, error mapping, rotation — unchanged.)

**(b) `src/diaflow/conversations.ts`** — rewrite `sendMessage`, add `getRunResult`, take `waitMs`:
```ts
import { randomUUID } from "node:crypto";
import type { DiaflowClient } from "./client.js";
import type { CompletionResult, RunResult, FileRef } from "./types.js";

interface CompletionResponse {
  thread_id?: string;
  session_id?: string;
  choices?: { message?: { role?: string; content?: string } }[];
  usage?: { total_tokens?: number };
}
interface HistoryResponse {
  // Shape per Task 0 Step 3. Assumed here; confirm/adjust to the recorded path.
  data?: { results?: { role?: string; content?: string }[] };
  results?: { role?: string; content?: string }[];
}

const DEFAULT_WAIT_MS = 25000;

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

export class ConversationsApi {
  constructor(private readonly client: DiaflowClient, private readonly waitMs: number = DEFAULT_WAIT_MS) {}

  async sendMessage(params: {
    teammateId?: string;
    message: string;
    threadId?: string;
    files?: FileRef[];
    webSearch?: boolean;
  }): Promise<CompletionResult> {
    const threadId = params.threadId ?? randomUUID();
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: params.message }],
      stream: false,
      thread_id: threadId,
    };
    if (params.teammateId) body.agent_unique_id = params.teammateId;
    if (params.files?.length) body.files = params.files;
    if (params.webSearch !== undefined) body.web_search_enabled = params.webSearch;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.waitMs);
    try {
      const res = await this.client.request<CompletionResponse>("POST", "/agent-runtime/completions", { body, signal: controller.signal });
      return {
        status: "completed",
        threadId: res.thread_id ?? res.session_id ?? threadId,
        reply: res.choices?.[0]?.message?.content ?? "",
        usage: res.usage ? { totalTokens: res.usage.total_tokens } : undefined,
      };
    } catch (e) {
      if (isAbortError(e)) return { status: "working", threadId };
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async getRunResult(threadId: string): Promise<RunResult> {
    const res = await this.client.request<HistoryResponse>(
      "GET",
      `/agent-runtime/sessions/${encodeURIComponent(threadId)}/history`,
      { query: { limit: 20 } },
    );
    const msgs = res.data?.results ?? res.results ?? [];
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant" && (m.content ?? "").length > 0);
    if (lastAssistant) return { status: "completed", threadId, reply: lastAssistant.content ?? "" };
    return { status: "working", threadId };
  }

  listSessions(params: { agentId?: string; page?: number; pageSize?: number } = {}): Promise<unknown> {
    return this.client.request<unknown>("GET", "/agent-runtime/sessions", {
      query: { agent_id: params.agentId, page: params.page, pageSize: params.pageSize },
    });
  }
  getHistory(sessionId: string, opts: { limit?: number; beforeSequence?: number } = {}): Promise<unknown> {
    return this.client.request<unknown>("GET", `/agent-runtime/sessions/${encodeURIComponent(sessionId)}/history`, {
      query: { limit: opts.limit ?? 50, before_sequence: opts.beforeSequence },
    });
  }
  stop(sessionId: string): Promise<void> {
    return this.client.request<void>("POST", `/agent-runtime/sessions/${encodeURIComponent(sessionId)}/stop`);
  }
}
```
> If Task 0 chose an `unknown` signal (e.g. `/threads/{id}/state` returns 404 for an expired/never-existed thread), have `getRunResult` catch a `DiaflowHttpError` with status 404 and return `{ status: "unknown", threadId }`.

**(c) `src/tools/context.ts`** — pass the wait bound:
```ts
conversations: new ConversationsApi(client, cfg.messageWaitMs),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/diaflow/conversations.test.ts` → PASS. Then `npm test` (full) and `npm run build` — green. (Fixes the tsc errors Task 2 introduced.)

- [ ] **Step 5: Commit**

```bash
git add src/diaflow/client.ts src/diaflow/conversations.ts src/tools/context.ts tests/diaflow/conversations.test.ts
git commit -m "feat(conversations): bounded-wait sendMessage + getRunResult (async handoff)"
```

---

## Task 4: Tools — hybrid `message_teammate` + `get_teammate_reply`

**Files:** Modify `src/tools/conversation.ts`; Test `tests/tools/conversation.test.ts`.

**Interfaces:**
- Consumes: `ConversationsApi.sendMessage` (returns `CompletionResult` with `status`), `ConversationsApi.getRunResult`.
- Produces: `message_teammate` returns the `CompletionResult`; when `status:"working"` it appends a `note` instructing the follow-up. New tool `get_teammate_reply` `{ threadId: string, waitMs?: number }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools/conversation.test.ts (add; reuse existing fakeServer pattern)
import { describe, it, expect, vi } from "vitest";
import { registerConversationTools } from "../../src/tools/conversation.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("message_teammate hybrid + get_teammate_reply", () => {
  it("message_teammate returns completed reply directly", async () => {
    const conversations = { sendMessage: vi.fn(async () => ({ status: "completed", threadId: "t1", reply: "pong" })) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} } as any);
    const res = await tools["message_teammate"]({ teammateId: "B", message: "hi" });
    expect(res.content[0].text).toContain("pong");
  });

  it("message_teammate on working adds a hand-off note pointing to get_teammate_reply", async () => {
    const conversations = { sendMessage: vi.fn(async () => ({ status: "working", threadId: "t9" })) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} } as any);
    const res = await tools["message_teammate"]({ teammateId: "B", message: "long" });
    expect(res.content[0].text).toContain("t9");
    expect(res.content[0].text).toContain("get_teammate_reply");
  });

  it("get_teammate_reply forwards the threadId and returns the run result", async () => {
    const conversations = { getRunResult: vi.fn(async () => ({ status: "completed", threadId: "t9", reply: "analysis done" })) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} } as any);
    const res = await tools["get_teammate_reply"]({ threadId: "t9" });
    expect(conversations.getRunResult).toHaveBeenCalledWith("t9");
    expect(res.content[0].text).toContain("analysis done");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/tools/conversation.test.ts`
Expected: FAIL (note not added / `get_teammate_reply` not registered).

- [ ] **Step 3: Implement**

In `src/tools/conversation.ts`, update the `message_teammate` handler's return and description, and register `get_teammate_reply`:
```ts
// description:
"Post a message to a teammate. Returns { status } — \"completed\" with the reply for quick tasks, " +
"or \"working\" with a threadId for long tasks (the target keeps running). If status is \"working\", " +
"you MUST call get_teammate_reply with that threadId (polling until it returns \"completed\") to get the result. " +
"Omit teammateId only to continue an existing thread. Use for agent-to-agent orchestration."
```
Replace the handler's final `return asText(r);` with:
```ts
      const r = await deps.conversations.sendMessage({
        teammateId: args.teammateId,
        message: args.message,
        threadId: args.threadId,
        files,
        webSearch: args.webSearch,
      });
      if (r.status === "working") {
        return asText({
          ...r,
          note: `The teammate is still working. Call get_teammate_reply with threadId "${r.threadId}" (poll until status is "completed") to retrieve the result.`,
        });
      }
      return asText(r);
```
Register the new tool (after `message_teammate`):
```ts
  server.registerTool(
    "get_teammate_reply",
    {
      description:
        "Fetch the result of a message_teammate call that returned status \"working\". Pass the threadId from that result. " +
        "Returns { status: \"working\" | \"completed\" | \"unknown\", reply? }. If \"working\", call again shortly to poll.",
      inputSchema: {
        threadId: z.string().min(1).describe("The threadId returned by message_teammate when it responded with status \"working\"."),
        waitMs: z.number().int().positive().optional().describe("Reserved for future server-side wait; currently informational."),
      },
    },
    async (args) => asText(await deps.conversations.getRunResult(args.threadId)),
  );
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- tests/tools/conversation.test.ts` → PASS. Then `npm test` (full) + `npm run build` — green.

- [ ] **Step 5: Commit**

```bash
git add src/tools/conversation.ts tests/tools/conversation.test.ts
git commit -m "feat(tools): hybrid message_teammate + get_teammate_reply poll tool"
```

---

## Task 5: Docs + final verification

**Files:** Modify `README.md` (and `CLAUDE.md` architecture note if present). No new test file.

- [ ] **Step 1: Update `README.md`** — in the conversation/sub-agent tool inventory, document that `message_teammate` may return `status:"working"` with a `threadId`, and add `get_teammate_reply` (poll for the result). One paragraph explaining the bounded-wait (`MESSAGE_TEAMMATE_WAIT_MS`, default 25s) + poll model for long agent-to-agent tasks.

- [ ] **Step 2: Full verification**

Run: `npm test -- --coverage` → all pass, coverage ≥ ~80% (new `src/diaflow/conversations.ts` + `src/tools/conversation.ts` covered).
Run: `npm run build` → clean tsc.

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document async message_teammate + get_teammate_reply"
```

---

## Post-implementation manual verification (not a code task)

Deploy, then in Diaflow have orchestrator A run a long task via `message_teammate` against B:
1. Server logs show `rpc=tools/call:message_teammate -> 200` quickly (within ~25s) with a `working` result.
2. A then calls `get_teammate_reply` (`rpc=tools/call:get_teammate_reply -> 200`), polling until `completed`, and produces the final answer — no freeze.
3. A short "say hello" still returns `completed` in one shot.
