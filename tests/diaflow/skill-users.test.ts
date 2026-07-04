import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { SkillUserApi } from "../../src/diaflow/skill-users.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

const RAW = { id: 7, unique_id: "sk1", workspace_id: 1, user_id: 2, name: "My Skill", description: "d", files: { "SKILL.md": "k/SKILL.md" }, is_active: true, version: 3, created_at: "2026-07-04T00:00:00Z", updated_at: "2026-07-04T00:00:00Z" };

describe("SkillUserApi CRUD", () => {
  it("create posts name/description and maps the response to camelCase", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok(RAW, 201));
    const r = await new SkillUserApi(client(f)).create({ name: "My Skill", description: "d" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/skill-users");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: "My Skill", description: "d", files: {} });
    expect(r.uniqueId).toBe("sk1");
    expect(r.isActive).toBe(true);
    expect(r.files).toEqual({ "SKILL.md": "k/SKILL.md" });
  });

  it("list maps every item", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok([RAW]));
    const r = await new SkillUserApi(client(f)).list();
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/skill-users");
    expect(r[0].uniqueId).toBe("sk1");
  });

  it("get uses the unique id in the path", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok(RAW));
    await new SkillUserApi(client(f)).get("sk1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/skill-users/sk1");
  });

  it("update PATCHes only the provided fields", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok(RAW));
    await new SkillUserApi(client(f)).update("sk1", { description: "new" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/skill-users/sk1");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ description: "new" });
  });

  it("remove DELETEs and resolves on 204", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    await new SkillUserApi(client(f)).remove("sk1");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/skill-users/sk1");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
