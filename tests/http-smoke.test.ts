import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildContext } from "../src/tools/context.js";

describe("http session factory", () => {
  it("builds an isolated context per call", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://x", MCP_TRANSPORT: "http" } as any);
    const a = buildContext(cfg);
    const b = buildContext(cfg);
    expect(a.provider).not.toBe(b.provider); // isolated per session
  });
});
