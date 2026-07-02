import { describe, it, expect, vi } from "vitest";
import { registerSkillTools } from "../../src/tools/skills.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("skill tools", () => {
  it("attach_skill forwards exactly one id", async () => {
    const skills = { attach: vi.fn(async () => ({ ok: true })) };
    const { server, tools } = fakeServer();
    registerSkillTools(server as any, { skills } as any);
    await tools["attach_skill"]({ teammateId: "u1", skillWorkspaceId: 5 });
    expect(skills.attach).toHaveBeenCalledWith("u1", { skillWorkspaceId: 5, skillSystemId: undefined, skillUserId: undefined });
  });

  it("attach_skill rejects when no id is given", async () => {
    const skills = { attach: vi.fn() };
    const { server, tools } = fakeServer();
    registerSkillTools(server as any, { skills } as any);
    const res = await tools["attach_skill"]({ teammateId: "u1" });
    expect(res.isError).toBe(true);
    expect(skills.attach).not.toHaveBeenCalled();
  });

  it("attach_skill rejects when more than one id is given", async () => {
    const skills = { attach: vi.fn() };
    const { server, tools } = fakeServer();
    registerSkillTools(server as any, { skills } as any);
    const res = await tools["attach_skill"]({ teammateId: "u1", skillWorkspaceId: 5, skillSystemId: 9 });
    expect(res.isError).toBe(true);
    expect(skills.attach).not.toHaveBeenCalled();
  });

  it("list_teammate_skills and list_available_skills forward the teammateId", async () => {
    const skills = { listAttached: vi.fn(async () => [{ id: 1 }]), listAvailable: vi.fn(async () => [{ id: 2 }]) };
    const { server, tools } = fakeServer();
    registerSkillTools(server as any, { skills } as any);
    await tools["list_teammate_skills"]({ teammateId: "u1" });
    await tools["list_available_skills"]({ teammateId: "u1" });
    expect(skills.listAttached).toHaveBeenCalledWith("u1");
    expect(skills.listAvailable).toHaveBeenCalledWith("u1");
  });

  it("detach_skill forwards exactly one id and reports success", async () => {
    const skills = { detach: vi.fn(async () => {}) };
    const { server, tools } = fakeServer();
    registerSkillTools(server as any, { skills } as any);
    const res = await tools["detach_skill"]({ teammateId: "u1", skillUserId: 3 });
    expect(skills.detach).toHaveBeenCalledWith("u1", { skillWorkspaceId: undefined, skillSystemId: undefined, skillUserId: 3 });
    expect(res.content[0].text).toContain("detached");
  });

  it("detach_skill rejects when no id is given", async () => {
    const skills = { detach: vi.fn() };
    const { server, tools } = fakeServer();
    registerSkillTools(server as any, { skills } as any);
    const res = await tools["detach_skill"]({ teammateId: "u1" });
    expect(res.isError).toBe(true);
    expect(skills.detach).not.toHaveBeenCalled();
  });
});
