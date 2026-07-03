import { describe, it, expect } from "vitest";
import { buildContext } from "../../src/tools/context.js";
import type { AppConfig } from "../../src/config.js";

const cfg = { diaflowApiBase: "https://api.diaflow.io", authMode: "oauth" } as unknown as AppConfig;

describe("buildContext with seal identity", () => {
  it("builds a provider that returns the given seal + workspace", async () => {
    const ctx = buildContext(cfg, { seal: "gAAAA", workspaceId: 1564 });
    expect(await ctx.provider.getToken()).toBe("gAAAA");
    expect(ctx.provider.getWorkspaceId()).toBe(1564);
  });

  it("onRotate updates the seal and calls the writeback", async () => {
    let written = "";
    const ctx = buildContext(cfg, { seal: "old", workspaceId: null, onRotate: (s) => { written = s; } });
    ctx.provider.onRotate("new");
    expect(await ctx.provider.getToken()).toBe("new");
    expect(written).toBe("new");
  });
});
