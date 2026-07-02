import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { SkillsApi } from "../../src/diaflow/skills.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("SkillsApi", () => {
  it("attach posts the skill ref body", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ ok: true }, 201));
    await new SkillsApi(client(f)).attach("u1", { skillWorkspaceId: 5 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/u1/skill-agents/attach");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ skillWorkspaceId: 5 });
  });

  it("detach deletes with the ref as query", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    await new SkillsApi(client(f)).detach("u1", { skillSystemId: 9 });
    const [url, init] = f.mock.calls[0];
    expect((init as RequestInit).method).toBe("DELETE");
    expect(url).toBe("https://x/api/v1/agents/u1/skill-agents?skillSystemId=9");
  });

  it("listAttached returns the array", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok([{ id: 1, name: "S" }]));
    const r = await new SkillsApi(client(f)).listAttached("u1");
    expect(r).toHaveLength(1);
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/u1/skill-agents");
  });
});
