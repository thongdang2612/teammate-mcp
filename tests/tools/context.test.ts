import { describe, it, expect } from "vitest";
import { buildContext } from "../../src/tools/context.js";
import { loadConfig } from "../../src/config.js";
import { StaticTokenProvider, WorkOSSessionProvider } from "../../src/auth/token-provider.js";

describe("buildContext", () => {
  it("uses a StaticTokenProvider when DIAFLOW_TOKEN is configured", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://x", DIAFLOW_TOKEN: "SEAL", DIAFLOW_WORKSPACE_ID: "1564" } as any);
    const ctx = buildContext(cfg);
    expect(ctx.provider).toBeInstanceOf(StaticTokenProvider);
    expect(ctx.provider.getWorkspaceId()).toBe(1564);
  });

  it("uses a WorkOSSessionProvider when no static token is configured", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://x" } as any);
    const ctx = buildContext(cfg);
    expect(ctx.provider).toBeInstanceOf(WorkOSSessionProvider);
  });
});
