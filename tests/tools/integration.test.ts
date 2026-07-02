import { describe, it, expect, vi } from "vitest";
import { registerIntegrationTools } from "../../src/tools/integration.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("integration tools", () => {
  it("register_self_as_custom_mcp rejects a non-https public url", async () => {
    const { server, tools } = fakeServer();
    registerIntegrationTools(server as any, {
      client: {} as any,
      provider: { getWorkspaceId: () => 1564 } as any,
      publicUrl: "http://insecure/mcp",
      inboundToken: "K",
      registerCustomMcp: vi.fn(),
    } as any);
    const res = await tools["register_self_as_custom_mcp"]({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text.toLowerCase()).toContain("https");
  });

  it("register_self_as_custom_mcp registers with the public url + inbound token", async () => {
    const registerCustomMcp = vi.fn(async () => ({ resourceId: 9, created: true }));
    const { server, tools } = fakeServer();
    registerIntegrationTools(server as any, {
      client: {} as any,
      provider: { getWorkspaceId: () => 1564 } as any,
      publicUrl: "https://m.example.com/mcp",
      inboundToken: "K",
      registerCustomMcp,
    } as any);
    const res = await tools["register_self_as_custom_mcp"]({ name: "Mine" });
    expect(registerCustomMcp).toHaveBeenCalledWith(expect.anything(), 1564, expect.objectContaining({ url: "https://m.example.com/mcp", name: "Mine", key: "K" }));
    expect(res.content[0].text).toContain("9");
  });
});
