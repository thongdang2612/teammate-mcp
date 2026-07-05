import { describe, it, expect, vi } from "vitest";
import { resolveTeammateId } from "../../src/tools/resolve-teammate.js";

describe("resolveTeammateId", () => {
  it("returns the id directly when teammateId is given (no lookup)", async () => {
    const teammates = { list: vi.fn() };
    const r = await resolveTeammateId(teammates as any, { teammateId: "u9" });
    expect(r).toEqual({ ok: true, id: "u9" });
    expect(teammates.list).not.toHaveBeenCalled();
  });

  it("resolves a name to its uniqueId (case-insensitive exact match)", async () => {
    const teammates = { list: vi.fn(async () => ({ total: 2, results: [{ uniqueId: "u9", name: "Ciel" }, { uniqueId: "u3", name: "Diablo" }] })) };
    const r = await resolveTeammateId(teammates as any, { teammateName: "ciel" });
    expect(teammates.list).toHaveBeenCalledWith({ search: "ciel" });
    expect(r).toEqual({ ok: true, id: "u9" });
  });

  it("errors with candidates when the name matches nothing", async () => {
    const teammates = { list: vi.fn(async () => ({ total: 1, results: [{ uniqueId: "u3", name: "Diablo" }] })) };
    const r = await resolveTeammateId(teammates as any, { teammateName: "Nobody" });
    expect(r).toEqual({ ok: false, error: 'No teammate named "Nobody" found.', candidates: ["Diablo"] });
  });

  it("errors when neither id nor name is provided", async () => {
    const teammates = { list: vi.fn() };
    const r = await resolveTeammateId(teammates as any, {});
    expect(r.ok).toBe(false);
    expect(teammates.list).not.toHaveBeenCalled();
  });
});
