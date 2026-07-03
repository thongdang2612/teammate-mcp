import { describe, it, expect, vi } from "vitest";
import { registerConversationTools } from "../../src/tools/conversation.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("conversation tools", () => {
  it("message_teammate sends text and returns the reply + threadId", async () => {
    const conversations = { sendMessage: vi.fn(async () => ({ threadId: "T1", reply: "done" })) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any, uploadChatAttachment: vi.fn() } as any);
    const res = await tools["message_teammate"]({ teammateId: "u1", message: "go" });
    expect(conversations.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ teammateId: "u1", message: "go", threadId: undefined, files: undefined }));
    expect(res.content[0].text).toContain("T1");
    expect(res.content[0].text).toContain("done");
  });

  it("message_teammate uploads attachmentUrls first", async () => {
    const conversations = { sendMessage: vi.fn(async () => ({ threadId: "T1", reply: "ok" })) };
    const uploadChatAttachment = vi.fn(async () => ({ filename: "a.png", path: "k", artifact_url: "u" }));
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any, uploadChatAttachment } as any);
    await tools["message_teammate"]({ teammateId: "u1", message: "look", attachmentUrls: ["https://r/a.png"] });
    expect(uploadChatAttachment).toHaveBeenCalledTimes(1);
    expect(conversations.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ files: [{ filename: "a.png", path: "k", artifact_url: "u" }] }));
  });

  it("message_teammate hands off to get_teammate_reply with the threadId", async () => {
    const conversations = { sendMessage: vi.fn(async () => ({ status: "working", threadId: "T5" })) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any, uploadChatAttachment: vi.fn() } as any);
    const out = await tools["message_teammate"]({ teammateId: "u1", message: "long task" });
    const payload = JSON.parse(out.content[0].text);
    expect(payload.status).toBe("working");
    expect(payload.threadId).toBe("T5");
    expect(payload.note).toContain("get_teammate_reply");
    expect(payload.note).toContain("T5");
  });

  it("get_teammate_reply calls waitForReply with the threadId", async () => {
    const conversations = { waitForReply: vi.fn(async () => ({ status: "completed", threadId: "T5", reply: "done" })) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any, uploadChatAttachment: vi.fn() } as any);
    const out = await tools["get_teammate_reply"]({ threadId: "T5" });
    expect(conversations.waitForReply).toHaveBeenCalledWith("T5");
    expect(JSON.parse(out.content[0].text)).toEqual({ status: "completed", threadId: "T5", reply: "done" });
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
});
