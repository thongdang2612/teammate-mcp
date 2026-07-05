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

  it("register_self_as_custom_mcp refuses to register when no inbound token is configured", async () => {
    const registerCustomMcp = vi.fn();
    const { server, tools } = fakeServer();
    registerIntegrationTools(server as any, {
      client: {} as any,
      provider: { getWorkspaceId: () => 1564 } as any,
      publicUrl: "https://m.example.com/mcp",
      inboundToken: undefined,
      registerCustomMcp,
    } as any);
    const res = await tools["register_self_as_custom_mcp"]({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text.toLowerCase()).toContain("mcp_inbound_token");
    expect(registerCustomMcp).not.toHaveBeenCalled();
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

  it("list_teammate_connectors resolves the name then lists that teammate's connectors", async () => {
    const teammates = { list: vi.fn(async () => ({ total: 1, results: [{ uniqueId: "u9", name: "Ciel" }] })) };
    const listTeammateConnectors = vi.fn(async () => [{ id: 1, nodeType: "mcp_custom__12", resourceId: 12, resourceName: "M", resourceType: "mcp_custom", actions: [], isActive: true }]);
    const { server, tools } = fakeServer();
    registerIntegrationTools(server as any, { client: {} as any, provider: {} as any, teammates, listTeammateConnectors } as any);
    const res = await tools["list_teammate_connectors"]({ teammateName: "Ciel" });
    expect(teammates.list).toHaveBeenCalledWith({ search: "Ciel" });
    expect(listTeammateConnectors).toHaveBeenCalledWith(expect.anything(), "u9");
    expect(res.content[0].text).toContain("mcp_custom__12");
  });

  it("add_connector attaches an existing connector by nodeType to a teammate (by id)", async () => {
    const addConnectorToAgent = vi.fn(async () => ({ ok: true }));
    const { server, tools } = fakeServer();
    registerIntegrationTools(server as any, { client: {} as any, provider: {} as any, teammates: { list: vi.fn() }, addConnectorToAgent } as any);
    await tools["add_connector"]({ teammateId: "u1", nodeType: "mcp_custom__12", resourceId: 12, actions: ["a"] });
    expect(addConnectorToAgent).toHaveBeenCalledWith(expect.anything(), "u1", { nodeType: "mcp_custom__12", resourceId: 12, actions: ["a"], permissions: undefined });
  });

  it("set_connector_permissions upserts the tri-state permission list", async () => {
    const addConnectorToAgent = vi.fn(async () => ({ ok: true }));
    const { server, tools } = fakeServer();
    registerIntegrationTools(server as any, { client: {} as any, provider: {} as any, teammates: { list: vi.fn() }, addConnectorToAgent } as any);
    await tools["set_connector_permissions"]({ teammateId: "u1", nodeType: "mcp_custom__12", permissions: [{ key: "send", permission: "deny" }] });
    expect(addConnectorToAgent).toHaveBeenCalledWith(expect.anything(), "u1", { nodeType: "mcp_custom__12", resourceId: undefined, permissions: [{ key: "send", permission: "deny" }] });
  });

  it("add_connector errors (no attach) when the teammate name matches nothing", async () => {
    const addConnectorToAgent = vi.fn();
    const { server, tools } = fakeServer();
    registerIntegrationTools(server as any, { client: {} as any, provider: {} as any, teammates: { list: vi.fn(async () => ({ total: 0, results: [] })) }, addConnectorToAgent } as any);
    const res = await tools["add_connector"]({ teammateName: "Ghost", nodeType: "mcp_custom__1" });
    expect(res.content[0].text).toContain("No teammate named");
    expect(addConnectorToAgent).not.toHaveBeenCalled();
  });
});
