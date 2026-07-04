import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { SkillUserApi } from "../../src/diaflow/skill-users.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

const RAW = { id: 7, uniqueId: "sk1", workspaceId: 1, userId: 2, name: "My Skill", description: "d", files: { "SKILL.md": "k/SKILL.md" }, isActive: true, version: "1.0.0", createdAt: "2026-07-04T00:00:00Z", updatedAt: "2026-07-04T00:00:00Z" };

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

describe("SkillUserApi file ops", () => {
  const RAW = { id: 7, uniqueId: "sk1", workspaceId: 1, userId: 2, name: "My Skill", description: "d", files: { "SKILL.md": "wk/agent/skills/sk1/My Skill/SKILL.md" }, isActive: true, version: "1.0.0", createdAt: "t", updatedAt: "t" };

  it("writeFile EDIT branch: presigned-edit -> PUT octet-stream -> confirm-edit", async () => {
    const calls: any[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body, headers: init?.headers });
      if (url.endsWith("/agents/skill-users/sk1")) return ok(RAW);
      if (url.endsWith("/files/presigned-edit")) return ok({ upload_url: "https://s3/put-edit", s3_key: "wk/agent/skills/sk1/My Skill/SKILL.abc.md" });
      if (url === "https://s3/put-edit") return new Response(null, { status: 200 });
      if (url.endsWith("/files/confirm-edit")) return ok({ s3_key: "x", file_path: "SKILL.md" });
      throw new Error("unexpected " + url);
    });
    await new SkillUserApi(client(f), f as any).writeFile("sk1", "SKILL.md", "# hi");
    const seq = calls.map((c) => c.url.replace("https://x/api/v1", ""));
    expect(seq).toEqual([
      "/agents/skill-users/sk1",
      "/agents/skill-users/sk1/files/presigned-edit",
      "https://s3/put-edit",
      "/agents/skill-users/sk1/files/confirm-edit",
    ]);
    const putCall = calls.find((c) => c.url === "https://s3/put-edit");
    expect((putCall.body as any)).toBeDefined();
    expect(new Headers(putCall.headers).get("content-type")).toBe("application/octet-stream");
    const confirm = JSON.parse(calls.find((c) => c.url.endsWith("confirm-edit")).body);
    expect(confirm).toEqual({ file_path: "SKILL.md", s3_key: "wk/agent/skills/sk1/My Skill/SKILL.abc.md" });
  });

  it("writeFile NEW branch: presigned-urls(by name) -> PUT -> POST files", async () => {
    const calls: any[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body, headers: init?.headers });
      if (url.endsWith("/agents/skill-users/sk1")) return ok(RAW);
      if (url.endsWith("/agents/skill-users/presigned-urls")) return ok({ files: { "docs/x.md": { upload_url: "https://s3/put-new", key: "wk/.../docs/x.md", url: "https://cdn/x.md", content_type: "text/markdown" } } });
      if (url === "https://s3/put-new") return new Response(null, { status: 200 });
      if (url.endsWith("/agents/skill-users/sk1/files")) return ok(RAW);
      throw new Error("unexpected " + url);
    });
    await new SkillUserApi(client(f), f as any).writeFile("sk1", "docs/x.md", "body");
    const presign = JSON.parse(calls.find((c) => c.url.endsWith("presigned-urls")).body);
    expect(presign).toEqual({ skill_name: "My Skill", files: ["docs/x.md"] });
    const putCall = calls.find((c) => c.url === "https://s3/put-new");
    expect(new Headers(putCall.headers).get("content-type")).toBe("text/markdown");
    const persist = JSON.parse(calls.find((c) => c.url.endsWith("/sk1/files") && c.method === "POST").body);
    expect(persist).toEqual({ files: { "docs/x.md": "wk/.../docs/x.md" } });
  });

  it("readFile resolves the signed url then fetches text", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.endsWith("/files/SKILL.md")) return ok({ url: "https://cdn/signed" });
      if (url === "https://cdn/signed") return new Response("# content", { status: 200 });
      throw new Error("unexpected " + url);
    });
    const r = await new SkillUserApi(client(f), f as any).readFile("sk1", "SKILL.md");
    expect(r).toBe("# content");
  });

  it("removeFiles DELETEs with the paths body", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok(RAW));
    await new SkillUserApi(client(f)).removeFiles("sk1", ["docs/x.md"]);
    const init = f.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ paths: ["docs/x.md"] });
  });
});
