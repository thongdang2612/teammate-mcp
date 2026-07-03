import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./tools/context.js";
import { registerAllTools } from "./tools/register.js";
import { DIAFLOW_ICON_DATA_URI } from "./branding.js";

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: "Diaflow Teammate MCP",
    version: "0.1.0",
    icons: [{ src: DIAFLOW_ICON_DATA_URI, mimeType: "image/png", sizes: ["72x72"] }],
  });
  registerAllTools(server, ctx);
  return server;
}
