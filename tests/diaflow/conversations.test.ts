import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { ConversationsApi } from "../../src/diaflow/conversations.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("ConversationsApi", () => {
  it("sendMessage posts stream:false with agent_unique_id and parses the reply", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ thread_id: "T1", session_id: "T1", choices: [{ message: { role: "assistant", content: "hi there" } }] }));
    const api = new ConversationsApi(client(f));
    const r = await api.sendMessage({ teammateId: "u1", message: "hello" });
    expect(r).toEqual({ status: "completed", threadId: "T1", reply: "hi there", usage: undefined });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agent-runtime/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ stream: false, agent_unique_id: "u1", messages: [{ role: "user", content: "hello" }] });
    expect(body.thread_id).toBeUndefined();
  });

  it("sendMessage replays thread_id and omits agent_unique_id on continuation", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ thread_id: "T1", choices: [{ message: { content: "more" } }] }));
    const api = new ConversationsApi(client(f));
    const r = await api.sendMessage({ message: "again", threadId: "T1" });
    expect(r.reply).toBe("more");
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thread_id).toBe("T1");
    expect(body.agent_unique_id).toBeUndefined();
  });

  it("sendMessage returns status:working when the run exceeds the wait bound", async () => {
    // fetch that only settles on abort (simulates a long run): rejects with an AbortError.
    const f = vi.fn((_url?: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const api = new ConversationsApi(client(f as any), 20); // tiny bound
    const r = await api.sendMessage({ teammateId: "u1", message: "long task" });
    expect(r).toEqual({ status: "working", threadId: "" });
  });

  it("getLatestReply resolves the newest session then returns its latest assistant reply", async () => {
    const f = vi.fn(async (url?: string, _init?: RequestInit) => {
      if (String(url).includes("/sessions/S9/history")) {
        return ok({ data: { results: [{ role: "user", content: "long task" }, { role: "assistant", content: "analysis done" }] } });
      }
      return ok({ data: { results: [{ session_id: "S9" }] } }); // sessions list
    });
    const r = await new ConversationsApi(client(f as any)).getLatestReply("u1");
    expect(r).toEqual({ status: "completed", threadId: "S9", reply: "analysis done" });
  });

  it("getLatestReply reports working while the newest session has no assistant reply yet", async () => {
    const f = vi.fn(async (url?: string, _init?: RequestInit) => {
      if (String(url).includes("/sessions/S9/history")) return ok({ data: { results: [{ role: "user", content: "long task" }] } });
      return ok({ data: { results: [{ session_id: "S9" }] } });
    });
    const r = await new ConversationsApi(client(f as any)).getLatestReply("u1");
    expect(r).toEqual({ status: "working", threadId: "S9" });
  });

  it("getLatestReply returns unknown when the teammate has no session", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ data: { results: [] } }));
    const r = await new ConversationsApi(client(f as any)).getLatestReply("u1");
    expect(r).toEqual({ status: "unknown", threadId: "" });
  });

  it("stop posts to the stop endpoint", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    await new ConversationsApi(client(f)).stop("T1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agent-runtime/sessions/T1/stop");
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("listSessions queries the sessions endpoint with filters", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ results: [{ sessionId: "T1" }] }));
    const r = await new ConversationsApi(client(f)).listSessions({ agentId: "u1", page: 2, pageSize: 10 });
    expect(r).toEqual({ results: [{ sessionId: "T1" }] });
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agent-runtime/sessions?agent_id=u1&page=2&pageSize=10");
  });

  it("getHistory queries the history endpoint with a default limit", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ messages: [] }));
    await new ConversationsApi(client(f)).getHistory("T1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agent-runtime/sessions/T1/history?limit=50");
  });
});
