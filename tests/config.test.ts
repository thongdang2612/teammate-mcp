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

  it("treats empty-string optional env values as unset", () => {
    const cfg = loadConfig({
      DIAFLOW_API_BASE: "https://x",
      MCP_PUBLIC_URL: "",
      DIAFLOW_WORKSPACE_ID: "",
      DIAFLOW_TOKEN: "",
      MCP_INBOUND_TOKEN: "",
      MCP_HTTP_PORT: "",
    } as any);
    expect(cfg.publicUrl).toBeUndefined();
    expect(cfg.staticToken).toBeUndefined();
    expect(cfg.inboundToken).toBeUndefined();
    expect(cfg.staticWorkspaceId).toBeUndefined();
    expect(cfg.httpPort).toBe(8787);
    expect(cfg.transport).toBe("stdio");
  });

  it("uses PORT over MCP_HTTP_PORT when the host injects it", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://x", MCP_HTTP_PORT: "8787", PORT: "3000" } as any);
    expect(cfg.httpPort).toBe(3000);
  });

  it("falls back to MCP_HTTP_PORT when PORT is empty/unset", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://x", MCP_HTTP_PORT: "9001", PORT: "" } as any);
    expect(cfg.httpPort).toBe(9001);
  });
});

const base = {
  DIAFLOW_API_BASE: "https://api.diaflow.io",
  MCP_TRANSPORT: "http",
};

describe("MCP_AUTH_MODE", () => {
  it("defaults to static", () => {
    const cfg = loadConfig({ ...base, DIAFLOW_TOKEN: "seal" } as any);
    expect(cfg.authMode).toBe("static");
  });

  it("oauth mode requires an https MCP_PUBLIC_URL and derives issuer + resource", () => {
    const cfg = loadConfig({
      ...base,
      MCP_AUTH_MODE: "oauth",
      MCP_PUBLIC_URL: "https://teammate-mcp.onrender.com/mcp",
    } as any);
    expect(cfg.authMode).toBe("oauth");
    expect(cfg.oauthIssuerUrl).toBe("https://teammate-mcp.onrender.com");
    expect(cfg.oauthResourceUrl).toBe("https://teammate-mcp.onrender.com/mcp");
  });

  it("oauth mode without MCP_PUBLIC_URL throws", () => {
    expect(() => loadConfig({ ...base, MCP_AUTH_MODE: "oauth" } as any)).toThrow();
  });
});

describe("loadConfig messageWaitMs", () => {
  it("defaults the SSE budget to 20000ms (under Diaflow's 30s proxy cap)", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://api-dev.diaflow.io" } as NodeJS.ProcessEnv);
    expect(cfg.messageWaitMs).toBe(20000);
  });

  it("honors an explicit MESSAGE_TEAMMATE_WAIT_MS", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://api-dev.diaflow.io", MESSAGE_TEAMMATE_WAIT_MS: "45000" } as unknown as NodeJS.ProcessEnv);
    expect(cfg.messageWaitMs).toBe(45000);
  });
});
