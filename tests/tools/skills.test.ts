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
});
