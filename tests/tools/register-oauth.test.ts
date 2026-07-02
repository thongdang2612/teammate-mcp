import { describe, it, expect } from "vitest";
import { registerAllTools } from "../../src/tools/register.js";
import { buildContext } from "../../src/tools/context.js";
import type { AppConfig } from "../../src/config.js";

// Mirrors the fakeServer/registerAllTools pattern already used in register.test.ts:
// collect registered tool names by intercepting registerTool calls, rather than reaching
// into the SDK's private McpServer._registeredTools field.
function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

const cfg = { diaflowApiBase: "https://api.diaflow.io", authMode: "oauth" } as unknown as AppConfig;

describe("registerAllTools under oauth (seal) identity", () => {
  it("does not register interactive auth/workspace tools for a SealTokenProvider context", () => {
    const ctx = buildContext(cfg, { seal: "s", workspaceId: 1564 });
    const { server, tools } = fakeServer();
    registerAllTools(server as any, ctx);
    expect(tools["connect_diaflow"]).toBeUndefined();
    expect(tools["submit_code"]).toBeUndefined();
    expect(tools["auth_status"]).toBeUndefined();
    expect(tools["set_workspace"]).toBeUndefined();
    expect(tools["list_workspaces"]).toBeUndefined();
    expect(tools["list_teammates"]).toBeDefined();
  });
});
