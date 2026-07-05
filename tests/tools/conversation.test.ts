import { describe, it, expect, vi } from "vitest";
import { registerConversationTools, makePollToken, parsePollToken } from "../../src/tools/conversation.js";
import { JobStore } from "../../src/teammate/job-store.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

// A never-settling promise — simulates a teammate still working past the grace window.
const pending = () => new Promise<never>(() => {});

describe("conversation tools", () => {
  it("message_teammate returns the reply inline when it finishes within the grace window", async () => {
    const conversations = { sendMessage: vi.fn(async () => ({ status: "completed" as const, threadId: "T1", reply: "done" })) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any, uploadChatAttachment: vi.fn(), jobStore: new JobStore(), graceMs: 1000 } as any);
    const res = await tools["message_teammate"]({ teammateId: "u1", message: "go" });
    expect(conversations.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ teammateId: "u1", message: "go" }));
    expect(res.content[0].text).toBe("done");
  });

  it("message_teammate returns { working, jobId } when the task exceeds the grace window", async () => {
    const conversations = { sendMessage: vi.fn(async () => ({ status: "working" as const, threadId: "T1" })), waitForReply: vi.fn(() => pending()) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any, uploadChatAttachment: vi.fn(), jobStore: new JobStore(), graceMs: 10 } as any);
    const out = await tools["message_teammate"]({ teammateId: "u1", message: "long" });
    const payload = JSON.parse(out.content[0].text);
    expect(payload.status).toBe("working");
    expect(typeof payload.jobId).toBe("string");
    expect(payload.note).toContain("get_teammate_reply");
  });

  it("relay_teammates starts a background job and returns { working, jobId }", async () => {
    const conversations = { sendMessage: vi.fn(() => pending()), waitForReply: vi.fn(() => pending()) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any, uploadChatAttachment: vi.fn(), jobStore: new JobStore(), graceMs: 10 } as any);
    const out = await tools["relay_teammates"]({ message: "collect", steps: [{ teammateId: "A" }, { teammateId: "B", instruction: "analyze" }] });
    const payload = JSON.parse(out.content[0].text);
    expect(payload.status).toBe("working");
    expect(typeof payload.jobId).toBe("string");
    expect(payload.note).toContain("get_teammate_reply");
  });

  it("get_teammate_reply returns the plain reply for a completed job", async () => {
    const store = new JobStore();
    const job = store.create("message");
    store.update(job.id, { status: "completed" as const, reply: "the answer" });
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations: {} as any, client: {} as any, uploadChatAttachment: vi.fn(), jobStore: store } as any);
    const out = await tools["get_teammate_reply"]({ jobId: job.id });
    expect(out.content[0].text).toBe("the answer");
  });

  it("get_teammate_reply reports working with progress while the job runs", async () => {
    const store = new JobStore();
    const job = store.create("relay");
    store.update(job.id, { progress: "step 1/2 (A)" });
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations: {} as any, client: {} as any, uploadChatAttachment: vi.fn(), jobStore: store, replyWaitMs: 10 } as any);
    const out = await tools["get_teammate_reply"]({ jobId: job.id });
    const payload = JSON.parse(out.content[0].text);
    expect(payload.status).toBe("working");
    expect(payload.progress).toBe("step 1/2 (A)");
  });

  it("get_teammate_reply reports unknown for an unrecognized jobId", async () => {
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations: {} as any, client: {} as any, uploadChatAttachment: vi.fn(), jobStore: new JobStore() } as any);
    const out = await tools["get_teammate_reply"]({ jobId: "nope" });
    expect(JSON.parse(out.content[0].text).status).toBe("unknown");
  });

  it("list_conversations forwards filters", async () => {
    const conversations = { listSessions: vi.fn(async () => ({ results: [{ sessionId: "s1" }] })) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any } as any);
    const res = await tools["list_conversations"]({ agentId: "u1", page: 1 });
    expect(conversations.listSessions).toHaveBeenCalledWith({ agentId: "u1", page: 1, pageSize: undefined });
    expect(res.content[0].text).toContain("s1");
  });

  it("get_conversation fetches history by sessionId", async () => {
    const conversations = { getHistory: vi.fn(async () => ({ messages: [] })) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any } as any);
    await tools["get_conversation"]({ sessionId: "s1", limit: 10 });
    expect(conversations.getHistory).toHaveBeenCalledWith("s1", { limit: 10 });
  });

  it("stop_conversation stops the session and reports success", async () => {
    const conversations = { stop: vi.fn(async () => {}) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any } as any);
    const res = await tools["stop_conversation"]({ sessionId: "s1" });
    expect(conversations.stop).toHaveBeenCalledWith("s1");
    expect(res.content[0].text).toContain("stopped");
  });

  it("rename_conversation forwards sessionId + title to updateTitle", async () => {
    const conversations = { updateTitle: vi.fn(async () => ({ sessionId: "s1", title: "New title" })) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any } as any);
    const res = await tools["rename_conversation"]({ sessionId: "s1", title: "New title" });
    expect(conversations.updateTitle).toHaveBeenCalledWith("s1", "New title");
    expect(res.content[0].text).toContain("New title");
  });
});

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
    // waitForReply never settles — matches the still-working case without spinning
    // runToCompletion's poll loop against its real (12-minute) wall-clock deadline.
    const conversations = { sendMessage: vi.fn(async () => ({ status: "working" as const, threadId: "T" })), waitForReply: vi.fn(() => pending()) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any, uploadChatAttachment: vi.fn(), jobStore: new JobStore(), graceMs: 5 } as any);
    const out = await tools["message_teammate"]({ teammateId: "u1", message: "long" });
    const body = JSON.parse(out.content[0].text);
    expect(body.status).toBe("working");
    expect(body.pollToken).toBe(`${body.jobId}::p1`);
  });
});

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
