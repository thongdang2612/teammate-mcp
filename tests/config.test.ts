import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://api.diaflow.io", MCP_TRANSPORT: "stdio" } as any);
    expect(cfg.diaflowApiBase).toBe("https://api.diaflow.io");
    expect(cfg.transport).toBe("stdio");
    expect(cfg.httpPort).toBe(8787);
  });

  it("throws when DIAFLOW_API_BASE is missing", () => {
    expect(() => loadConfig({} as any)).toThrow();
  });

  it("defaults transport to stdio and coerces the port", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://x", MCP_HTTP_PORT: "9000" } as any);
    expect(cfg.transport).toBe("stdio");
    expect(cfg.httpPort).toBe(9000);
  });
});
