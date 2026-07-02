import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiaflowClient } from "../diaflow/client.js";
import type { WorkOSSessionProvider } from "../auth/token-provider.js";
import { DiaflowHttpError } from "../diaflow/errors.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });

export function registerWorkspaceTools(server: McpServer, ctx: { provider: WorkOSSessionProvider; client: DiaflowClient }): void {
  server.registerTool(
    "set_workspace",
    { description: "Switch the active Diaflow workspace for subsequent teammate operations.", inputSchema: { workspaceId: z.number().int().positive() } },
    async (args) => {
      await ctx.provider.setWorkspace(args.workspaceId);
      return asText(`Active workspace set to ${ctx.provider.getWorkspaceId()}.`);
    },
  );

  server.registerTool(
    "list_workspaces",
    { description: "List workspaces available to the connected user.", inputSchema: {} },
    async () => {
      try {
        return asText(await ctx.client.request<unknown>("GET", "/workspaces"));
      } catch (err) {
        if (err instanceof DiaflowHttpError && (err.status === 404 || err.status === 405)) {
          return asText(`Listing workspaces is not supported by this Diaflow instance; the active workspace is ${ctx.provider.getWorkspaceId() ?? "(none)"}.`);
        }
        throw err;
      }
    },
  );
}
