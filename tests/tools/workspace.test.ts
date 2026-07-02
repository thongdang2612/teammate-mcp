import { describe, it, expect, vi } from "vitest";
import { registerWorkspaceTools } from "../../src/tools/workspace.js";
import { DiaflowHttpError } from "../../src/diaflow/errors.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("workspace tools", () => {
  it("set_workspace calls provider.setWorkspace", async () => {
    const provider = { setWorkspace: vi.fn(async () => {}), getWorkspaceId: () => 7 };
    const client = { request: vi.fn() };
    const { server, tools } = fakeServer();
    registerWorkspaceTools(server as any, { provider, client } as any);
    await tools["set_workspace"]({ workspaceId: 7 });
    expect(provider.setWorkspace).toHaveBeenCalledWith(7);
  });

  it("list_workspaces degrades gracefully on 404", async () => {
    const provider = { getWorkspaceId: () => 7 };
    const client = { request: vi.fn(async () => { throw new DiaflowHttpError(404, "nope"); }) };
    const { server, tools } = fakeServer();
    registerWorkspaceTools(server as any, { provider, client } as any);
    const res = await tools["list_workspaces"]({});
    expect(res.content[0].text.toLowerCase()).toContain("not");
  });

  it("list_workspaces returns the workspace list on success", async () => {
    const provider = { getWorkspaceId: () => 7 };
    const client = { request: vi.fn(async () => ({ results: [{ id: 7, name: "Acme" }] })) };
    const { server, tools } = fakeServer();
    registerWorkspaceTools(server as any, { provider, client } as any);
    const res = await tools["list_workspaces"]({});
    expect(client.request).toHaveBeenCalledWith("GET", "/workspaces");
    expect(res.content[0].text).toContain("Acme");
  });

  it("list_workspaces propagates non-404/405 errors", async () => {
    const provider = { getWorkspaceId: () => 7 };
    const client = { request: vi.fn(async () => { throw new DiaflowHttpError(500, "boom"); }) };
    const { server, tools } = fakeServer();
    registerWorkspaceTools(server as any, { provider, client } as any);
    await expect(tools["list_workspaces"]({})).rejects.toThrow(DiaflowHttpError);
  });
});
