import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { TEAMMATE_ID_DESC } from "./descriptions.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function registerReadTools(server: McpServer, ctx: Pick<ToolContext, "teammates">): void {
  server.registerTool(
    "list_teammates",
    {
      description:
        "List Diaflow teammates in the active workspace. Returns each teammate's `uniqueId` (use this as the id for every other teammate tool), `name`, `title`, and status. Call this FIRST to turn a teammate name into its uniqueId.",
      inputSchema: {
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().max(200).optional(),
        lifecycle: z.enum(["active", "offboarded"]).optional(),
        search: z.string().optional(),
        orderBy: z.string().optional(),
      },
    },
    async (args) => {
      const page = await ctx.teammates.list({
        page: args.page,
        pageSize: args.pageSize,
        lifecycle: args.lifecycle,
        search: args.search,
        orderBy: args.orderBy,
      });
      return asText(page);
    },
  );

  server.registerTool(
    "get_teammate",
    {
      description: "Get full detail for a single teammate by its `uniqueId` (resolve a name via list_teammates first).",
      inputSchema: { teammateId: z.string().min(1).describe(TEAMMATE_ID_DESC) },
    },
    async (args) => asText(await ctx.teammates.get(args.teammateId)),
  );
}
