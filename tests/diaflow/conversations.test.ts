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

describe("ConversationsApi", () => {
  it("stop posts to the stop endpoint", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    await new ConversationsApi(client(f)).stop("T1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agent-runtime/sessions/T1/stop");
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("listSessions queries the sessions endpoint with filters", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => json({ results: [{ sessionId: "T1" }] }));
    const r = await new ConversationsApi(client(f)).listSessions({ agentId: "u1", page: 2, pageSize: 10 });
    expect(r).toEqual({ results: [{ sessionId: "T1" }] });
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agent-runtime/sessions?agent_id=u1&page=2&pageSize=10");
  });

  it("getHistory queries the history endpoint with a default limit", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => json({ messages: [] }));
    await new ConversationsApi(client(f)).getHistory("T1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agent-runtime/sessions/T1/history?limit=50");
  });
});
