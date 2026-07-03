import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./tools/context.js";
import { registerAllTools } from "./tools/register.js";

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: "Diaflow Teammate MCP",
    version: "0.1.0",
    icons: [{ src: "https://app.diaflow.io/favicon.ico", mimeType: "image/x-icon", sizes: ["any"] }],
  });
  registerAllTools(server, ctx);
  return server;
}
