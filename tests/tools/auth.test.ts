import { describe, it, expect, vi } from "vitest";
import { registerAuthTools } from "../../src/tools/auth.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("auth tools", () => {
  it("connect_diaflow starts the magic-auth flow", async () => {
    const provider = { startConnect: vi.fn(async () => {}), isConnected: vi.fn(async () => false) };
    const { server, tools } = fakeServer();
    registerAuthTools(server as any, { provider } as any);
    const res = await tools["connect_diaflow"]({ email: "a@b.com" });
    expect(provider.startConnect).toHaveBeenCalledWith("a@b.com");
    expect(res.content[0].text.toLowerCase()).toContain("code");
  });

  it("submit_code completes the flow", async () => {
    const provider = { completeConnect: vi.fn(async () => ({ workspaceId: 1564 })) };
    const { server, tools } = fakeServer();
    registerAuthTools(server as any, { provider } as any);
    const res = await tools["submit_code"]({ email: "a@b.com", code: "123456" });
    expect(provider.completeConnect).toHaveBeenCalledWith("a@b.com", "123456");
    expect(res.content[0].text).toContain("1564");
  });
});
