import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { registerAuthTools } from "./auth.js";
import { registerReadTools } from "./read.js";
import { registerWriteTools } from "./write.js";
import { registerAvatarTools } from "./avatar.js";
import { registerSkillTools } from "./skills.js";
import { WorkOSSessionProvider } from "../auth/token-provider.js";

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  // connect/submit_code require the WorkOS provider; register them only then.
  if (ctx.provider instanceof WorkOSSessionProvider) {
    registerAuthTools(server, { provider: ctx.provider });
  }
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  // presetHosts seeds from the API host as a starting point; refine once the
  // real Diaflow CDN host is confirmed (see spec §9 open question #4).
  registerAvatarTools(server, { teammates: ctx.teammates, client: ctx.client, presetHosts: [new URL(ctx.baseUrl).host] });
  registerSkillTools(server, { skills: ctx.skills });
}
