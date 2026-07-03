import { describe, it, expect, vi } from "vitest";
import { registerWriteTools } from "../../src/tools/write.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("write tools", () => {
  it("create_teammate creates then publishes by default, and does not pass the publish flag as a field", async () => {
    const teammates = {
      create: vi.fn(async () => ({ id: 1, uniqueId: "u1", name: "A", status: "draft" })),
      publish: vi.fn(async () => ({ id: 1, uniqueId: "u1", name: "A", status: "publish" })),
    };
    const { server, tools } = fakeServer();
    registerWriteTools(server as any, { teammates } as any);
    const res = await tools["create_teammate"]({ modelProvider: "openai", modelName: "gpt-4", name: "A" });
    // `publish` is a control flag, not a teammate field — it must not leak into the create payload.
    expect(teammates.create).toHaveBeenCalledWith({ modelProvider: "openai", modelName: "gpt-4", name: "A" });
    expect(teammates.publish).toHaveBeenCalledWith("u1");
    expect(res.content[0].text).toContain('"status": "publish"');
  });

  it("create_teammate with publish:false leaves the teammate as a draft (no publish call)", async () => {
    const teammates = {
      create: vi.fn(async () => ({ id: 1, uniqueId: "u1", name: "A", status: "draft" })),
      publish: vi.fn(async () => ({ id: 1, uniqueId: "u1", name: "A", status: "publish" })),
    };
    const { server, tools } = fakeServer();
    registerWriteTools(server as any, { teammates } as any);
    const res = await tools["create_teammate"]({ modelProvider: "openai", modelName: "gpt-4", name: "A", publish: false });
    expect(teammates.create).toHaveBeenCalledWith({ modelProvider: "openai", modelName: "gpt-4", name: "A" });
    expect(teammates.publish).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain('"status": "draft"');
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
