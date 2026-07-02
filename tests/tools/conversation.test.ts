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
});
