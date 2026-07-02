import { describe, it, expect, vi } from "vitest";
import { registerWriteTools } from "../../src/tools/write.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("write tools", () => {
  it("create_teammate calls the api", async () => {
    const teammates = { create: vi.fn(async () => ({ id: 1, uniqueId: "u1", name: "A" })) };
    const { server, tools } = fakeServer();
    registerWriteTools(server as any, { teammates } as any);
    const res = await tools["create_teammate"]({ modelProvider: "openai", modelName: "gpt-4", name: "A" });
    expect(teammates.create).toHaveBeenCalledWith(expect.objectContaining({ modelProvider: "openai", modelName: "gpt-4", name: "A" }));
    expect(res.content[0].text).toContain("u1");
  });

  it("update_teammate strips teammateId out of the fields", async () => {
    const teammates = { update: vi.fn(async () => ({ id: 1, uniqueId: "u1", name: "B" })) };
    const { server, tools } = fakeServer();
    registerWriteTools(server as any, { teammates } as any);
    await tools["update_teammate"]({ teammateId: "u1", name: "B" });
    expect(teammates.update).toHaveBeenCalledWith("u1", { name: "B" });
  });

  it("check_teammate_name forwards the name and reports duplicate status", async () => {
    const teammates = { checkName: vi.fn(async () => ({ isDuplicate: true })) };
    const { server, tools } = fakeServer();
    registerWriteTools(server as any, { teammates } as any);
    const res = await tools["check_teammate_name"]({ name: "Aria" });
    expect(teammates.checkName).toHaveBeenCalledWith("Aria");
    expect(res.content[0].text).toContain("true");
  });
});
