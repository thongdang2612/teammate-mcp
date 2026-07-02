import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { SubAgentsApi } from "../../src/diaflow/sub-agents.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("SubAgentsApi", () => {
  it("attach posts subAgentUniqueId", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ ok: true }, 201));
    await new SubAgentsApi(client(f)).attach("orch1", "sub1");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/orch1/sub-agents");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ subAgentUniqueId: "sub1" });
  });

  it("detach deletes the sub-agent path", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    await new SubAgentsApi(client(f)).detach("orch1", "sub1");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/orch1/sub-agents/sub1");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("create posts to /sub-agents/create", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ uniqueId: "sub2" }, 201));
    await new SubAgentsApi(client(f)).create("orch1", { modelProvider: "openai", modelName: "gpt-4", name: "Helper" });
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/orch1/sub-agents/create");
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({ modelProvider: "openai", modelName: "gpt-4", name: "Helper" });
  });
});
