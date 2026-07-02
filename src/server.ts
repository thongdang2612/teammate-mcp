import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./tools/context.js";
import { registerAllTools } from "./tools/register.js";

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "diaflow-teammate-mcp", version: "0.1.0" });
  registerAllTools(server, ctx);
  return server;
}
