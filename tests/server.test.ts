import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildServer } from "../src/server.js";
import { buildContext } from "../src/tools/context.js";
import { loadConfig } from "../src/config.js";

describe("buildServer", () => {
  it("builds an McpServer with all tools registered", () => {
    const ctx = buildContext(loadConfig({ DIAFLOW_API_BASE: "https://x" } as any));
    const server = buildServer(ctx);
    expect(server).toBeInstanceOf(McpServer);
  });
});
