import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkOSSessionProvider } from "../auth/token-provider.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function registerAuthTools(server: McpServer, ctx: { provider: WorkOSSessionProvider }): void {
  server.registerTool(
    "connect_diaflow",
    {
      description: "Begin Diaflow login: emails a magic code to the given address. Then call submit_code with the code.",
      inputSchema: { email: z.string().email() },
    },
    async (args) => {
      await ctx.provider.startConnect(args.email);
      return text(`A login code was emailed to ${args.email}. Call submit_code with { email, code } to finish connecting.`);
    },
  );

  server.registerTool(
    "submit_code",
    {
      description: "Finish Diaflow login with the emailed magic code.",
      inputSchema: { email: z.string().email(), code: z.string().min(4) },
    },
    async (args) => {
      const r = await ctx.provider.completeConnect(args.email, args.code);
      return text(`Connected to Diaflow. Active workspace: ${r.workspaceId ?? "(none — call set_workspace)"}.`);
    },
  );

  server.registerTool(
    "auth_status",
    {
      description: "Report whether the MCP is connected to Diaflow and which workspace is active.",
      inputSchema: {},
    },
    async () => {
      const connected = await ctx.provider.isConnected();
      return text(connected ? `Connected. Workspace: ${ctx.provider.getWorkspaceId() ?? "(none)"}.` : "Not connected. Call connect_diaflow.");
    },
  );
}
