import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { listTeammateConnectors, addConnectorToAgent } from "../../src/diaflow/connectors.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("connectors api", () => {
  it("listTeammateConnectors GETs /agents/{id}/apps and maps the camelCase response", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) =>
      ok([{ id: 5, nodeType: "mcp_custom__12", resourceId: 12, resourceName: "My MCP", resourceType: "mcp_custom", actions: ["a", "b"], isActive: true }]),
    );
    const r = await listTeammateConnectors(client(f), "u1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/u1/apps");
    expect(r[0]).toEqual({ id: 5, nodeType: "mcp_custom__12", resourceId: 12, resourceName: "My MCP", resourceType: "mcp_custom", actions: ["a", "b"], isActive: true });
  });

  it("listTeammateConnectors defaults missing optional fields", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok([{ id: 7, nodeType: "ddb" }]));
    const r = await listTeammateConnectors(client(f), "u1");
    expect(r[0]).toEqual({ id: 7, nodeType: "ddb", resourceId: null, resourceName: null, resourceType: null, actions: [], isActive: false });
  });

  it("addConnectorToAgent POSTs nodeType/resourceId/actions", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ ok: true }));
    await addConnectorToAgent(client(f), "u1", { nodeType: "mcp_custom__12", resourceId: 12, actions: ["a"] });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/u1/apps");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ nodeType: "mcp_custom__12", resourceId: 12, actions: ["a"] });
  });

  it("addConnectorToAgent includes permissions and omits resourceId when absent", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ ok: true }));
    await addConnectorToAgent(client(f), "u1", { nodeType: "gmail", permissions: [{ key: "send", permission: "ask" }] });
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ nodeType: "gmail", actions: [], permissions: [{ key: "send", permission: "ask" }] });
  });
});
