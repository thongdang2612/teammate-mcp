# Teammate Reply — SSE Long-Poll & Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make teammate A reliably wait for a long-running teammate B by switching the conversation layer from blocking `stream:false` polling to the backend's `stream:true` + `/threads/{id}/stream` reconnect machinery.

**Architecture:** A new SSE reader parses `event:`/`data:` frames off a raw `Response` body. `sendMessage` starts the run with `stream:true`, reads frames up to a per-call budget (returns `completed`/`failed` early, else `working` with the captured `threadId`; the run keeps going in the backend's detached forwarder). `waitForReply(threadId)` reconnects to `/threads/{id}/stream` (replay + follow) to catch terminal frames that fired while disconnected, with a `/threads/{id}/state` fallback when the event buffer has expired.

**Tech Stack:** TypeScript (ESM/NodeNext, Node ≥20), `@modelcontextprotocol/sdk`, Zod v4, Vitest. Node's global `fetch`/`ReadableStream`/`TextDecoder`.

**Spec:** `docs/superpowers/specs/2026-07-03-teammate-reply-sse-longpoll-design.md`

## Global Constraints

- **Per-call budget stays under the ~100s Diaflow proxy ceiling.** `MESSAGE_TEAMMATE_WAIT_MS` default is `90000`; it bounds every SSE read via `AbortController`.
- **Exact SSE frame contract** (from `diaflow-backend/modules/agent_runtime/completions.py:874-879`): `event: metadata` → `{thread_id, session_id}`; `event: final` → `{content}`; `event: error` → `{error}`; `event: cancelled` → terminal. All other frames are ignored.
- **Backend paths** (prefix `/api/v1`): `POST /agent-runtime/completions` (body `stream:true`), `GET /agent-runtime/threads/{thread_id}/stream`, `GET /agent-runtime/threads/{thread_id}/state` (returns `{status: "running"|"completed"|"interrupted", messages, values}`).
- **No time backstop.** The only terminal exits are `completed`/`failed`/`interrupted`; budget elapsing yields `working` (caller resumes, unlimited).
- **A `failed` run is data, never a thrown tool error.** Structured `{ status: "failed", error }` flows back to the caller.
- **Immutability, no `any`, explicit types on exported APIs, no `console.log`** (per repo rules). Narrow `unknown` from parsed JSON.
- **Do not modify** `diaflow-backend/` or `diaflow-expo/` (read-only reference).

---

### Task 1: Raw streaming request on `DiaflowClient`

**Files:**
- Modify: `src/diaflow/client.ts`
- Test: `tests/diaflow/client.test.ts`

**Interfaces:**
- Consumes: existing `DiaflowClientOptions`, `RequestOptions`, `DiaflowHttpError`.
- Produces: `DiaflowClient.stream(method: string, path: string, options?: RequestOptions): Promise<Response>` — returns the raw `Response` (unparsed body) for SSE consumption; applies the same auth/workspace headers, `Accept: text/event-stream`, session-rotation writeback, and `DiaflowHttpError` on non-2xx as `request()`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/diaflow/client.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { DiaflowHttpError } from "../../src/diaflow/errors.js";

const mk = (f: any, extra: Record<string, unknown> = {}) =>
  new DiaflowClient({ baseUrl: "https://x", getToken: async () => "seal", getWorkspaceId: () => 7, fetchImpl: f, ...extra });

describe("DiaflowClient.stream", () => {
  it("returns the raw Response with auth + event-stream headers", async () => {
    const res = new Response("event: ping\ndata: {}\n\n", { status: 200 });
    const f = vi.fn(async () => res);
    const out = await mk(f).stream("POST", "/agent-runtime/completions", { body: { stream: true } });
    expect(out).toBe(res); // body left unread
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agent-runtime/completions");
    const h = new Headers((init as RequestInit).headers);
    expect(h.get("authorization")).toBe("Bearer seal");
    expect(h.get("workspace-id")).toBe("7");
    expect(h.get("accept")).toBe("text/event-stream");
    expect((init as RequestInit).body).toBe(JSON.stringify({ stream: true }));
  });

  it("writes back a rotated session seal", async () => {
    const onRotate = vi.fn();
    const res = new Response("data: {}\n\n", { status: 200, headers: { "x-diaflow-session": "gAAAA-new" } });
    await mk(async () => res, { onRotate }).stream("GET", "/agent-runtime/threads/T1/stream");
    expect(onRotate).toHaveBeenCalledWith("gAAAA-new");
  });

  it("throws DiaflowHttpError on a non-2xx status", async () => {
    const res = new Response(JSON.stringify({ message: "Thread not found" }), { status: 404 });
    await expect(mk(async () => res).stream("GET", "/agent-runtime/threads/T1/stream")).rejects.toMatchObject({
      status: 404,
      message: "Thread not found",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/diaflow/client.test.ts`
Expected: FAIL — `stream` is not a function.

- [ ] **Step 3: Implement `stream()` (refactor shared prep to stay DRY)**

Rewrite `src/diaflow/client.ts` so `request` and `stream` share header/URL/body construction and rotation writeback:

```typescript
import { DiaflowHttpError } from "./errors.js";

export interface DiaflowClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  getWorkspaceId: () => number | null;
  onRotate?: (seal: string) => void;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  workspaceId?: number | null;
  signal?: AbortSignal;
}

export class DiaflowClient {
  constructor(private readonly opts: DiaflowClientOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  private async send(method: string, path: string, options: RequestOptions, accept: string): Promise<Response> {
    const url = new URL(`${this.opts.baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers = new Headers({ "X-Client": "native", Accept: accept });
    const token = await this.opts.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const ws = options.workspaceId ?? this.opts.getWorkspaceId();
    if (ws != null) headers.set("Workspace-Id", String(ws));

    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }

    const res = await this.fetchImpl(url.toString(), { method, headers, body, signal: options.signal });
    const rotated = res.headers.get("x-diaflow-session");
    if (rotated) this.opts.onRotate?.(rotated);
    return res;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.send(method, path, options, "application/json");
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;
    if (!res.ok) throw toHttpError(res.status, parsed, text);
    return parsed as T;
  }

  /** Raw streaming request: returns the unread Response for SSE consumption. Throws on non-2xx. */
  async stream(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const res = await this.send(method, path, options, "text/event-stream");
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw toHttpError(res.status, text ? safeJson(text) : undefined, text);
    }
    return res;
  }
}

function toHttpError(status: number, parsed: unknown, text: string): DiaflowHttpError {
  const code = pickString(parsed, "code");
  const message = pickString(parsed, "message") ?? pickString(parsed, "detail") ?? `HTTP ${status}`;
  return new DiaflowHttpError(status, message, { code, detail: parsed ?? text });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pickString(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/diaflow/client.test.ts`
Expected: PASS (new `stream` cases + all pre-existing `request` cases still green).

- [ ] **Step 5: Commit**

```bash
git add src/diaflow/client.ts tests/diaflow/client.test.ts
git commit -m "feat(client): raw stream() request for SSE consumption"
```

---

### Task 2: SSE frame reader

**Files:**
- Create: `src/diaflow/sse.ts`
- Test: `tests/diaflow/sse.test.ts`

**Interfaces:**
- Produces:
  - `interface SseFrame { event: string; data: unknown }`
  - `async function* readSse(res: Response, signal?: AbortSignal): AsyncGenerator<SseFrame>` — yields one frame per SSE block (blank-line separated). `event:` sets the type (default `"message"`); `data:` lines are joined with `\n` and JSON-parsed when possible (raw string otherwise); comment lines (`:`-prefixed) are ignored. Ends when the stream closes or `signal` aborts.

- [ ] **Step 1: Write the failing tests**

Create `tests/diaflow/sse.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readSse } from "../../src/diaflow/sse.js";

const streamOf = (chunks: string[]): Response => {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
};

const collect = async (res: Response, signal?: AbortSignal) => {
  const out = [];
  for await (const f of readSse(res, signal)) out.push(f);
  return out;
};

describe("readSse", () => {
  it("parses a single event+data frame with JSON data", async () => {
    const out = await collect(streamOf(['event: metadata\ndata: {"thread_id":"T9"}\n\n']));
    expect(out).toEqual([{ event: "metadata", data: { thread_id: "T9" } }]);
  });

  it("parses multiple frames split across chunk boundaries", async () => {
    const out = await collect(streamOf(['event: metadata\ndata: {"thread_id":"T9"}\n\nev', 'ent: final\ndata: {"content":"hi"}\n\n']));
    expect(out).toEqual([
      { event: "metadata", data: { thread_id: "T9" } },
      { event: "final", data: { content: "hi" } },
    ]);
  });

  it("joins multi-line data and ignores comments", async () => {
    const out = await collect(streamOf([": keep-alive\nevent: note\ndata: line1\ndata: line2\n\n']));
    expect(out).toEqual([{ event: "note", data: "line1\nline2" }]);
  });

  it("flushes a trailing frame with no terminating blank line", async () => {
    const out = await collect(streamOf(['event: final\ndata: {"content":"end"}']));
    expect(out).toEqual([{ event: "final", data: { content: "end" } }]);
  });

  it("stops when the signal aborts on an open stream", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('event: metadata\ndata: {"thread_id":"T9"}\n\n'));
        // never closed → simulates an in-progress run
      },
    });
    const res = new Response(body, { status: 200 });
    const ctrl = new AbortController();
    const out = [];
    for await (const f of readSse(res, ctrl.signal)) {
      out.push(f);
      ctrl.abort(); // abort right after the first frame
    }
    expect(out).toEqual([{ event: "metadata", data: { thread_id: "T9" } }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/diaflow/sse.test.ts`
Expected: FAIL — cannot find module `sse.js`.

- [ ] **Step 3: Implement `src/diaflow/sse.ts`**

```typescript
export interface SseFrame {
  event: string;
  data: unknown;
}

/**
 * Parse an SSE `Response` body into frames. Frames are separated by a blank line; within a frame
 * `event:` sets the type (default "message") and `data:` lines are concatenated with "\n" then
 * JSON-parsed when possible. Comment lines (starting ":") are ignored. Iteration ends when the
 * stream closes or `signal` aborts (the underlying reader is cancelled).
 */
export async function* readSse(res: Response, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const onAbort = (): void => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) onAbort();

  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const frame = parseFrame(part);
        if (frame) yield frame;
      }
    }
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
  }
}

function parseFrame(block: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return null;
  const dataStr = dataLines.join("\n");
  let data: unknown = dataStr;
  try {
    data = JSON.parse(dataStr);
  } catch {
    /* keep the raw string */
  }
  return { event, data };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/diaflow/sse.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add src/diaflow/sse.ts tests/diaflow/sse.test.ts
git commit -m "feat(sse): SSE frame reader with abort support"
```

---

### Task 3: Extend run-status types and raise the wait budget

**Files:**
- Modify: `src/diaflow/types.ts:100-113`
- Modify: `src/config.ts:10`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `type RunStatus = "completed" | "working" | "failed" | "interrupted" | "unknown"`
  - `CompletionResult` and `RunResult` gain optional `error?: string`.
  - `MESSAGE_TEAMMATE_WAIT_MS` default becomes `90000`.

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts` (create if absent, following the existing config-test style — `loadConfig` with a minimal env):

```typescript
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig messageWaitMs", () => {
  it("defaults the SSE budget to 90000ms", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://api-dev.diaflow.io" } as NodeJS.ProcessEnv);
    expect(cfg.messageWaitMs).toBe(90000);
  });

  it("honors an explicit MESSAGE_TEAMMATE_WAIT_MS", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://api-dev.diaflow.io", MESSAGE_TEAMMATE_WAIT_MS: "45000" } as unknown as NodeJS.ProcessEnv);
    expect(cfg.messageWaitMs).toBe(45000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — `messageWaitMs` is `25000`.

- [ ] **Step 3: Apply the changes**

In `src/config.ts:10` change the default:

```typescript
  MESSAGE_TEAMMATE_WAIT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(90000)),
```

In `src/diaflow/types.ts`, replace lines 100-113:

```typescript
export type RunStatus = "completed" | "working" | "failed" | "interrupted" | "unknown";

export interface CompletionResult {
  status: RunStatus;
  threadId: string;
  reply?: string;
  error?: string;
  usage?: { totalTokens?: number };
}

export interface RunResult {
  status: RunStatus;
  threadId: string;
  reply?: string;
  error?: string;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/diaflow/types.ts tests/config.test.ts
git commit -m "feat(config): raise SSE wait budget to 90s; extend RunStatus with failed/interrupted"
```

---

### Task 4: Rewrite `ConversationsApi` onto SSE start + reconnect

**Files:**
- Modify: `src/diaflow/conversations.ts` (full rewrite of the class body; keep `listSessions`, `getHistory`, `stop`)
- Test: `tests/diaflow/conversations.test.ts` (rewrite the send/retrieve cases)

**Interfaces:**
- Consumes: `DiaflowClient.stream` (Task 1), `readSse`/`SseFrame` (Task 2), `RunStatus`/`CompletionResult`/`RunResult` (Task 3), `DiaflowHttpError`.
- Produces:
  - `sendMessage(params: { teammateId?: string; message: string; threadId?: string; files?: FileRef[]; webSearch?: boolean }): Promise<CompletionResult>` — posts `stream:true`, returns `completed`/`failed`/`working` (always with the captured `threadId`).
  - `waitForReply(threadId: string): Promise<RunResult>` — reconnects to `/threads/{id}/stream`; returns `completed`/`failed`/`interrupted`/`working`; on a 404 falls back to `/threads/{id}/state`.
  - `listSessions`, `getHistory`, `stop` unchanged.
  - `getLatestReply` is **removed** (replaced by `waitForReply`).

- [ ] **Step 1: Write the failing tests**

Replace the send/retrieve tests in `tests/diaflow/conversations.test.ts` (keep the `stop`/`listSessions`/`getHistory` cases):

```typescript
import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { ConversationsApi } from "../../src/diaflow/conversations.js";

const enc = new TextEncoder();
const sse = (frames: string[], keepOpen = false): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const fr of frames) c.enqueue(enc.encode(fr.endsWith("\n\n") ? fr : fr + "\n\n"));
      if (!keepOpen) c.close();
    },
  });
  return new Response(body, { status: 200 });
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("ConversationsApi.sendMessage", () => {
  it("posts stream:true with agent_unique_id and returns completed on a final frame", async () => {
    const f = vi.fn(async () => sse(['event: metadata\ndata: {"thread_id":"T1","session_id":"T1"}', 'event: final\ndata: {"content":"hi there"}']));
    const r = await new ConversationsApi(client(f)).sendMessage({ teammateId: "u1", message: "hello" });
    expect(r).toEqual({ status: "completed", threadId: "T1", reply: "hi there" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agent-runtime/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ stream: true, agent_unique_id: "u1", messages: [{ role: "user", content: "hello" }] });
    expect(body.thread_id).toBeUndefined();
  });

  it("returns failed with the error text on an error frame", async () => {
    const f = vi.fn(async () => sse(['event: metadata\ndata: {"thread_id":"T2"}', 'event: error\ndata: {"error":"model exploded"}']));
    const r = await new ConversationsApi(client(f)).sendMessage({ teammateId: "u1", message: "go" });
    expect(r).toEqual({ status: "failed", threadId: "T2", error: "model exploded" });
  });

  it("returns working with the captured threadId when the budget elapses mid-run", async () => {
    const f = vi.fn(async () => sse(['event: metadata\ndata: {"thread_id":"T3"}'], true)); // stream stays open
    const r = await new ConversationsApi(client(f), 20).sendMessage({ teammateId: "u1", message: "long" });
    expect(r).toEqual({ status: "working", threadId: "T3" });
  });

  it("replays thread_id and omits agent_unique_id on continuation", async () => {
    const f = vi.fn(async () => sse(['event: final\ndata: {"content":"more"}']));
    const r = await new ConversationsApi(client(f)).sendMessage({ message: "again", threadId: "T1" });
    expect(r).toEqual({ status: "completed", threadId: "T1", reply: "more" });
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thread_id).toBe("T1");
    expect(body.agent_unique_id).toBeUndefined();
  });
});

describe("ConversationsApi.waitForReply", () => {
  it("returns completed from a replayed final frame", async () => {
    const f = vi.fn(async () => sse(['event: final\ndata: {"content":"analysis done"}']));
    const r = await new ConversationsApi(client(f)).waitForReply("T9");
    expect(r).toEqual({ status: "completed", threadId: "T9", reply: "analysis done" });
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agent-runtime/threads/T9/stream");
  });

  it("returns failed from a replayed error frame", async () => {
    const f = vi.fn(async () => sse(['event: error\ndata: {"error":"boom"}']));
    const r = await new ConversationsApi(client(f)).waitForReply("T9");
    expect(r).toEqual({ status: "failed", threadId: "T9", error: "boom" });
  });

  it("returns interrupted on a cancelled frame", async () => {
    const f = vi.fn(async () => sse(['event: cancelled\ndata: {}']));
    const r = await new ConversationsApi(client(f)).waitForReply("T9");
    expect(r).toEqual({ status: "interrupted", threadId: "T9" });
  });

  it("returns working when the budget elapses with no terminal frame", async () => {
    const f = vi.fn(async () => sse(['event: thinking\ndata: {"content":"..."}'], true));
    const r = await new ConversationsApi(client(f), 20).waitForReply("T9");
    expect(r).toEqual({ status: "working", threadId: "T9" });
  });

  it("falls back to /state when the stream 404s (buffer expired)", async () => {
    const f = vi.fn(async (url?: string) => {
      if (String(url).endsWith("/stream")) return json({ message: "Thread not found" }, 404);
      return json({ status: "completed", messages: [{ type: "human", content: "q" }, { type: "ai", content: "durable reply" }] });
    });
    const r = await new ConversationsApi(client(f)).waitForReply("T9");
    expect(r).toEqual({ status: "completed", threadId: "T9", reply: "durable reply" });
    expect(String(f.mock.calls[1][0])).toBe("https://x/api/v1/agent-runtime/threads/T9/state");
  });

  it("reports working from /state fallback when the run is still running", async () => {
    const f = vi.fn(async (url?: string) => {
      if (String(url).endsWith("/stream")) return json({ message: "Thread not found" }, 404);
      return json({ status: "running", messages: [] });
    });
    const r = await new ConversationsApi(client(f)).waitForReply("T9");
    expect(r).toEqual({ status: "working", threadId: "T9" });
  });
});
```

Keep the existing `stop`, `listSessions`, and `getHistory` test cases as-is.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/diaflow/conversations.test.ts`
Expected: FAIL — `waitForReply` undefined; `sendMessage` still posts `stream:false`.

- [ ] **Step 3: Rewrite `src/diaflow/conversations.ts`**

```typescript
import type { DiaflowClient } from "./client.js";
import { DiaflowHttpError } from "./errors.js";
import { readSse, type SseFrame } from "./sse.js";
import type { CompletionResult, RunResult, RunStatus, FileRef } from "./types.js";

const DEFAULT_WAIT_MS = 90000;

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/** Thread id carried by the `metadata` frame (emitted once, early). */
function frameThreadId(frame: SseFrame): string | undefined {
  if (frame.event !== "metadata" || !frame.data || typeof frame.data !== "object") return undefined;
  const d = frame.data as { thread_id?: string; session_id?: string };
  return d.thread_id ?? d.session_id;
}

/** Map a terminal SSE frame to a run outcome, or null for non-terminal frames. */
function terminalOutcome(frame: SseFrame): { status: RunStatus; reply?: string; error?: string } | null {
  const d = (frame.data ?? {}) as { content?: string; error?: unknown };
  switch (frame.event) {
    case "final":
      return { status: "completed", reply: d.content ?? "" };
    case "error":
      return { status: "failed", error: typeof d.error === "string" ? d.error : JSON.stringify(d.error ?? "unknown error") };
    case "cancelled":
      return { status: "interrupted" };
    default:
      return null;
  }
}

/** Newest assistant/`ai` message content from a `/threads/{id}/state` message list. */
function finalMessageContent(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === "object") {
      const mm = m as { type?: string; role?: string; content?: string };
      if ((mm.type === "ai" || mm.role === "assistant") && (mm.content ?? "").length > 0) return mm.content ?? "";
    }
  }
  return "";
}

export class ConversationsApi {
  constructor(
    private readonly client: DiaflowClient,
    private readonly waitMs: number = DEFAULT_WAIT_MS,
  ) {}

  /**
   * Send a message to a teammate over the buffered SSE transport. Reads frames up to `waitMs`:
   * `final` → completed, `error` → failed, `cancelled` → interrupted; if the budget elapses the
   * run keeps going server-side (detached forwarder) and we return `working` with the captured
   * `threadId`. A caller-supplied `threadId` is only sent to continue an existing thread.
   */
  async sendMessage(params: {
    teammateId?: string;
    message: string;
    threadId?: string;
    files?: FileRef[];
    webSearch?: boolean;
  }): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: params.message }],
      stream: true,
    };
    if (params.teammateId) body.agent_unique_id = params.teammateId;
    if (params.threadId) body.thread_id = params.threadId;
    if (params.files?.length) body.files = params.files;
    if (params.webSearch !== undefined) body.web_search_enabled = params.webSearch;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.waitMs);
    let threadId = params.threadId ?? "";
    try {
      const res = await this.client.stream("POST", "/agent-runtime/completions", { body, signal: controller.signal });
      for await (const frame of readSse(res, controller.signal)) {
        const tid = frameThreadId(frame);
        if (tid) threadId = tid;
        const outcome = terminalOutcome(frame);
        if (outcome) return { ...outcome, threadId };
      }
      return { status: "working", threadId };
    } catch (e) {
      if (isAbortError(e)) return { status: "working", threadId };
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reconnect to a run and wait for its terminal state, up to `waitMs`. Replays the buffered
   * `:events` (catching `final`/`error` that fired while disconnected) then follows live. If the
   * event buffer has expired (`404`), falls back to `/threads/{id}/state`.
   */
  async waitForReply(threadId: string): Promise<RunResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.waitMs);
    try {
      const res = await this.client.stream("GET", `/agent-runtime/threads/${encodeURIComponent(threadId)}/stream`, {
        signal: controller.signal,
      });
      for await (const frame of readSse(res, controller.signal)) {
        const outcome = terminalOutcome(frame);
        if (outcome) return { ...outcome, threadId };
      }
      return { status: "working", threadId };
    } catch (e) {
      if (isAbortError(e)) return { status: "working", threadId };
      if (e instanceof DiaflowHttpError && e.status === 404) return this.stateFallback(threadId);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Durable status after the SSE buffer TTL: `/threads/{id}/state` has no `error` status. */
  private async stateFallback(threadId: string): Promise<RunResult> {
    const state = await this.client.request<{ status?: string; messages?: unknown }>(
      "GET",
      `/agent-runtime/threads/${encodeURIComponent(threadId)}/state`,
    );
    if (state.status === "completed") return { status: "completed", threadId, reply: finalMessageContent(state.messages) };
    if (state.status === "interrupted") return { status: "interrupted", threadId };
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/diaflow/conversations.test.ts`
Expected: PASS (all send/wait/stop/list/history cases).

- [ ] **Step 5: Commit**

```bash
git add src/diaflow/conversations.ts tests/diaflow/conversations.test.ts
git commit -m "feat(conversations): SSE stream:true send + /threads reconnect wait with state fallback"
```

---

### Task 5: Re-key the tools to `threadId`

**Files:**
- Modify: `src/tools/conversation.ts`
- Test: `tests/tools/conversation.test.ts` (adjust to the new `get_teammate_reply` shape; create if absent)

**Interfaces:**
- Consumes: `ConversationsApi.sendMessage`, `ConversationsApi.waitForReply` (Task 4).
- Produces:
  - `message_teammate` — unchanged inputs; on `status: "working"`, the hand-off note instructs calling `get_teammate_reply` **with the returned `threadId`**.
  - `get_teammate_reply` — input is `{ threadId: string }` (was `teammateId`); calls `waitForReply(threadId)`.

- [ ] **Step 1: Write the failing tests**

In `tests/tools/conversation.test.ts`, register the tools against a fake `ConversationsApi` and assert wiring. Match the existing tool-test harness in the repo (a stub `McpServer` capturing `registerTool` handlers). Core assertions:

```typescript
// message_teammate: working outcome names the returned threadId in the note
it("message_teammate hands off to get_teammate_reply with the threadId", async () => {
  const conversations = { sendMessage: vi.fn(async () => ({ status: "working", threadId: "T5" })) };
  const handler = getRegisteredHandler("message_teammate", { conversations, client: {} as any });
  const out = await handler({ teammateId: "u1", message: "long task" });
  const payload = JSON.parse(out.content[0].text);
  expect(payload.status).toBe("working");
  expect(payload.threadId).toBe("T5");
  expect(payload.note).toContain("get_teammate_reply");
  expect(payload.note).toContain("T5");
});

// get_teammate_reply: passes threadId straight through to waitForReply
it("get_teammate_reply calls waitForReply with the threadId", async () => {
  const conversations = { waitForReply: vi.fn(async () => ({ status: "completed", threadId: "T5", reply: "done" })) };
  const handler = getRegisteredHandler("get_teammate_reply", { conversations, client: {} as any });
  const out = await handler({ threadId: "T5" });
  expect(conversations.waitForReply).toHaveBeenCalledWith("T5");
  expect(JSON.parse(out.content[0].text)).toEqual({ status: "completed", threadId: "T5", reply: "done" });
});
```

(Use the repo's existing pattern for capturing registered handlers; if none exists, build a minimal stub server whose `registerTool(name, def, fn)` stores `fn` by name.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/tools/conversation.test.ts`
Expected: FAIL — `get_teammate_reply` still expects `teammateId`; note references teammateId.

- [ ] **Step 3: Update `src/tools/conversation.ts`**

Replace the `message_teammate` working branch and the `get_teammate_reply` registration:

```typescript
      if (r.status === "working") {
        return asText({
          ...r,
          note: `The teammate is still working (threadId "${r.threadId}"). Call get_teammate_reply with threadId "${r.threadId}" and keep calling until status is "completed" — it waits server-side, so just call it again whenever it returns "working".`,
        });
      }
      return asText(r);
    },
  );

  server.registerTool(
    "get_teammate_reply",
    {
      description:
        "Wait for and fetch a teammate's reply after message_teammate returned status \"working\". " +
        "Pass the threadId from that response. Blocks server-side until the run reaches a terminal " +
        "state or the wait budget elapses, then returns { status: \"completed\" | \"failed\" | " +
        "\"interrupted\" | \"working\", reply?, error? }. If \"working\", the run is still going — " +
        "call again with the same threadId (unlimited).",
      inputSchema: {
        threadId: z.string().min(1).describe("The threadId returned by message_teammate for this run."),
      },
    },
    async (args) => asText(await deps.conversations.waitForReply(args.threadId)),
  );
```

Remove the now-unused `TEAMMATE_ID_DESC` import if nothing else in the file uses it (leave it if `message_teammate`'s `teammateId` description still references it).

- [ ] **Step 4: Run the full suite + build**

Run: `npm test`
Expected: PASS (all suites).
Run: `npm run build`
Expected: clean tsc compile.

- [ ] **Step 5: Commit**

```bash
git add src/tools/conversation.ts tests/tools/conversation.test.ts
git commit -m "feat(tools): re-key get_teammate_reply to threadId; hand-off note carries threadId"
```

---

## Self-Review

- **Spec coverage:** SSE reader (Task 2), `stream:true` send (Task 4), `/threads/{id}/stream` reconnect + `/state` fallback (Task 4), `threadId` re-keying (Task 5), 90s budget + `failed`/`interrupted` statuses (Task 3), raw client stream (Task 1). All spec components mapped.
- **Type consistency:** `RunStatus`/`CompletionResult`/`RunResult` defined in Task 3 are consumed unchanged in Task 4; `stream()` signature from Task 1 is called exactly in Task 4; `readSse`/`SseFrame` from Task 2 imported in Task 4.
- **No placeholders:** every code step contains full code; every run step has an expected result.
- **Residual caveats** (600s failure-window, recursion-limit false-success) are backend limitations documented in the spec — not implementable here; no task attempts them.
