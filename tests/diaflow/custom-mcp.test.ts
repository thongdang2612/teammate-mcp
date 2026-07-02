import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { registerCustomMcp, attachMcpToAgent } from "../../src/diaflow/custom-mcp.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1564, fetchImpl: f });

describe("custom-mcp", () => {
  it("registerCustomMcp posts the upsert body to the workspace path", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ resourceId: 123, created: true }));
    const r = await registerCustomMcp(client(f), 1564, { url: "https://m/mcp", name: "N", key: "K" });
    expect(r).toEqual({ resourceId: 123, created: true });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/workspaces/1564/resources/mcp/upsert");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      url: "https://m/mcp", name: "N", resourceType: "mcp_custom", key: "K",
      config: { transport: "streamable_http", authType: "bearer" },
    });
  });

  it("attachMcpToAgent posts the mcp_custom node type", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ uniqueId: "u1" }));
    await attachMcpToAgent(client(f), "u1", 123, ["list_teammates"]);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/u1/apps");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ nodeType: "mcp_custom__123", resourceId: 123, actions: ["list_teammates"] });
  });
});
