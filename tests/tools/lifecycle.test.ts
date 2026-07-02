import { describe, it, expect, vi } from "vitest";
import { registerLifecycleTools } from "../../src/tools/lifecycle.js";
import { DiaflowHttpError } from "../../src/diaflow/errors.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("lifecycle tools", () => {
  it("publish_teammate calls teammates.publish", async () => {
    const teammates = { publish: vi.fn(async () => ({ uniqueId: "u1", status: "published" })) };
    const { server, tools } = fakeServer();
    registerLifecycleTools(server as any, { teammates } as any);
    const res = await tools["publish_teammate"]({ teammateId: "u1" });
    expect(teammates.publish).toHaveBeenCalledWith("u1");
    expect(res.content[0].text).toContain("published");
  });

  it("offboard_teammate calls teammates.offboard", async () => {
    const teammates = { offboard: vi.fn(async () => ({ uniqueId: "u1", status: "offboarded" })) };
    const { server, tools } = fakeServer();
    registerLifecycleTools(server as any, { teammates } as any);
    const res = await tools["offboard_teammate"]({ teammateId: "u1" });
    expect(teammates.offboard).toHaveBeenCalledWith("u1");
    expect(res.content[0].text).toContain("offboarded");
  });

  it("rehire_teammate calls teammates.rehire", async () => {
    const teammates = { rehire: vi.fn(async () => ({ uniqueId: "u1", status: "active" })) };
    const { server, tools } = fakeServer();
    registerLifecycleTools(server as any, { teammates } as any);
    const res = await tools["rehire_teammate"]({ teammateId: "u1" });
    expect(teammates.rehire).toHaveBeenCalledWith("u1");
    expect(res.content[0].text).toContain("active");
  });

  it("delete_teammate without force calls permanentDelete once", async () => {
    const teammates = { permanentDelete: vi.fn(async () => {}), offboard: vi.fn() };
    const { server, tools } = fakeServer();
    registerLifecycleTools(server as any, { teammates } as any);
    await tools["delete_teammate"]({ teammateId: "u1" });
    expect(teammates.permanentDelete).toHaveBeenCalledWith("u1");
    expect(teammates.offboard).not.toHaveBeenCalled();
  });

  it("delete_teammate with force offboards then permanent-deletes on conflict", async () => {
    const teammates = {
      offboard: vi.fn(async () => ({})),
      permanentDelete: vi
        .fn()
        .mockRejectedValueOnce(new DiaflowHttpError(409, "must offboard first", { code: "permanent_delete_conflict" }))
        .mockResolvedValueOnce(undefined),
    };
    const { server, tools } = fakeServer();
    registerLifecycleTools(server as any, { teammates } as any);
    await tools["delete_teammate"]({ teammateId: "u1", force: true });
    expect(teammates.offboard).toHaveBeenCalledWith("u1");
    expect(teammates.permanentDelete).toHaveBeenCalledTimes(2);
  });

  it("delete_teammate without force propagates a permanent_delete_conflict instead of swallowing it", async () => {
    const teammates = {
      offboard: vi.fn(async () => ({})),
      permanentDelete: vi
        .fn()
        .mockRejectedValue(new DiaflowHttpError(409, "must offboard first", { code: "permanent_delete_conflict" })),
    };
    const { server, tools } = fakeServer();
    registerLifecycleTools(server as any, { teammates } as any);
    await expect(tools["delete_teammate"]({ teammateId: "u1" })).rejects.toThrow(DiaflowHttpError);
    expect(teammates.offboard).not.toHaveBeenCalled();
  });

  it("delete_teammate with force propagates errors that are not a permanent_delete_conflict", async () => {
    const teammates = {
      offboard: vi.fn(async () => ({})),
      permanentDelete: vi
        .fn()
        .mockRejectedValue(new DiaflowHttpError(500, "boom", { code: "server_error" })),
    };
    const { server, tools } = fakeServer();
    registerLifecycleTools(server as any, { teammates } as any);
    await expect(tools["delete_teammate"]({ teammateId: "u1", force: true })).rejects.toThrow(DiaflowHttpError);
    expect(teammates.offboard).not.toHaveBeenCalled();
  });
});
