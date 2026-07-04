import { describe, it, expect, vi } from "vitest";
import { registerSkillAuthoringTools } from "../../src/tools/skill-authoring.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

const SKILL = { uniqueId: "sk1", name: "My Skill", description: "d", files: {} };

describe("skill authoring tools", () => {
  it("create_personal_skill without content just creates", async () => {
    const skillUsers = { create: vi.fn(async () => SKILL), writeFile: vi.fn(), get: vi.fn() };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    const res = await tools["create_personal_skill"]({ name: "My Skill", description: "d" });
    expect(skillUsers.create).toHaveBeenCalledWith({ name: "My Skill", description: "d" });
    expect(skillUsers.writeFile).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("sk1");
  });

  it("create_personal_skill with content creates, writes SKILL.md, returns refreshed skill", async () => {
    const skillUsers = {
      create: vi.fn(async () => SKILL),
      writeFile: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ ...SKILL, files: { "SKILL.md": "k" } })),
    };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    const res = await tools["create_personal_skill"]({ name: "My Skill", content: "# hi" });
    expect(skillUsers.writeFile).toHaveBeenCalledWith("sk1", "SKILL.md", "# hi");
    expect(skillUsers.get).toHaveBeenCalledWith("sk1");
    expect(res.content[0].text).toContain("SKILL.md");
  });

  it("write_personal_skill_file defaults path to SKILL.md", async () => {
    const skillUsers = { writeFile: vi.fn(async () => undefined) };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    const res = await tools["write_personal_skill_file"]({ skillId: "sk1", content: "x" });
    expect(skillUsers.writeFile).toHaveBeenCalledWith("sk1", "SKILL.md", "x");
    expect(res.content[0].text).toContain('"written": true');
  });

  it("read_personal_skill_file returns plain text and defaults path", async () => {
    const skillUsers = { readFile: vi.fn(async () => "# content") };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    const res = await tools["read_personal_skill_file"]({ skillId: "sk1" });
    expect(skillUsers.readFile).toHaveBeenCalledWith("sk1", "SKILL.md");
    expect(res.content[0].text).toBe("# content");
  });

  it("delete_personal_skill reports deleted", async () => {
    const skillUsers = { remove: vi.fn(async () => undefined) };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    const res = await tools["delete_personal_skill"]({ skillId: "sk1" });
    expect(skillUsers.remove).toHaveBeenCalledWith("sk1");
    expect(res.content[0].text).toContain('"deleted": true');
  });

  it("remove_personal_skill_file forwards a single-path array", async () => {
    const skillUsers = { removeFiles: vi.fn(async () => SKILL) };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    await tools["remove_personal_skill_file"]({ skillId: "sk1", path: "docs/x.md" });
    expect(skillUsers.removeFiles).toHaveBeenCalledWith("sk1", ["docs/x.md"]);
  });

  it("update_personal_skill forwards only provided fields", async () => {
    const skillUsers = { update: vi.fn(async () => SKILL) };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    await tools["update_personal_skill"]({ skillId: "sk1", name: "New" });
    expect(skillUsers.update).toHaveBeenCalledWith("sk1", { name: "New", description: undefined });
  });

  it("list_personal_skills returns the array", async () => {
    const skillUsers = { list: vi.fn(async () => [SKILL]) };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    const res = await tools["list_personal_skills"]({});
    expect(res.content[0].text).toContain("sk1");
  });
});
