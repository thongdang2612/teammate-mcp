import { describe, it, expect } from "vitest";
import { registerAllTools } from "../../src/tools/register.js";
import { buildContext } from "../../src/tools/context.js";
import { loadConfig } from "../../src/config.js";
import { TEAMMATE_ID_DESC, SUB_AGENT_ID_DESC } from "../../src/tools/descriptions.js";

function fakeServer() {
  const tools: Record<string, { description?: string; inputSchema?: Record<string, any> }> = {};
  return {
    server: {
      registerTool: (name: string, def: { description?: string; inputSchema?: Record<string, any> }) => {
        tools[name] = def;
      },
    },
    tools,
  };
}

describe("tool description guidance", () => {
  it("exports shared constants that tell agents to resolve names via list_teammates", () => {
    expect(TEAMMATE_ID_DESC).toContain("list_teammates");
    expect(TEAMMATE_ID_DESC).toContain("uniqueId");
    expect(SUB_AGENT_ID_DESC).toContain("list_teammates");
    expect(SUB_AGENT_ID_DESC).toContain("uniqueId");
  });

  it("attaches the teammateId guidance to update_teammate's input schema", () => {
    const ctx = buildContext(loadConfig({ DIAFLOW_API_BASE: "https://x" } as any));
    const { server, tools } = fakeServer();
    registerAllTools(server as any, ctx);

    const updateTeammate = tools["update_teammate"];
    expect(updateTeammate).toBeDefined();
    expect(updateTeammate.inputSchema?.teammateId?.description).toContain("list_teammates");
  });

  it("describes list_teammates as the resolver for teammate uniqueId", () => {
    const ctx = buildContext(loadConfig({ DIAFLOW_API_BASE: "https://x" } as any));
    const { server, tools } = fakeServer();
    registerAllTools(server as any, ctx);

    const listTeammates = tools["list_teammates"];
    expect(listTeammates).toBeDefined();
    expect(listTeammates.description).toContain("uniqueId");
  });
});
