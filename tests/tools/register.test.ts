import { describe, it, expect } from "vitest";
import { registerAllTools } from "../../src/tools/register.js";
import { buildContext } from "../../src/tools/context.js";
import { loadConfig } from "../../src/config.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("registerAllTools", () => {
  it("registers auth + workspace tools for a WorkOSSessionProvider context", () => {
    const ctx = buildContext(loadConfig({ DIAFLOW_API_BASE: "https://x" } as any));
    const { server, tools } = fakeServer();
    registerAllTools(server as any, ctx);
    expect(tools["connect_diaflow"]).toBeDefined();
    expect(tools["set_workspace"]).toBeDefined();
    expect(tools["list_teammates"]).toBeDefined();
    expect(tools["publish_teammate"]).toBeDefined();
    expect(tools["message_teammate"]).toBeDefined();
    expect(tools["list_sub_agents"]).toBeDefined();
  });

  it("omits auth + workspace tools for a StaticTokenProvider context", () => {
    const ctx = buildContext(loadConfig({ DIAFLOW_API_BASE: "https://x", DIAFLOW_TOKEN: "SEAL" } as any));
    const { server, tools } = fakeServer();
    registerAllTools(server as any, ctx);
    expect(tools["connect_diaflow"]).toBeUndefined();
    expect(tools["set_workspace"]).toBeUndefined();
    expect(tools["list_teammates"]).toBeDefined();
  });
});
