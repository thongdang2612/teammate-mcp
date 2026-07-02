import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { registerAuthTools } from "./auth.js";
import { registerReadTools } from "./read.js";
import { registerWriteTools } from "./write.js";
import { WorkOSSessionProvider } from "../auth/token-provider.js";

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  // connect/submit_code require the WorkOS provider; register them only then.
  if (ctx.provider instanceof WorkOSSessionProvider) {
    registerAuthTools(server, { provider: ctx.provider });
  }
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
}
