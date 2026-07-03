import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeammatesApi } from "../diaflow/teammates.js";
import { DiaflowHttpError } from "../diaflow/errors.js";
import { TEAMMATE_ID_DESC } from "./descriptions.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function registerLifecycleTools(server: McpServer, ctx: { teammates: TeammatesApi }): void {
  server.registerTool(
    "publish_teammate",
    { description: "Publish a draft teammate.", inputSchema: { teammateId: z.string().min(1).describe(TEAMMATE_ID_DESC) } },
    async (args) => asText(await ctx.teammates.publish(args.teammateId)),
  );

  server.registerTool(
    "offboard_teammate",
    { description: "Offboard (reversible soft-delete) a teammate.", inputSchema: { teammateId: z.string().min(1).describe(TEAMMATE_ID_DESC) } },
    async (args) => asText(await ctx.teammates.offboard(args.teammateId)),
  );

  server.registerTool(
    "rehire_teammate",
    { description: "Rehire (restore) an offboarded teammate.", inputSchema: { teammateId: z.string().min(1).describe(TEAMMATE_ID_DESC) } },
    async (args) => asText(await ctx.teammates.rehire(args.teammateId)),
  );

  server.registerTool(
    "delete_teammate",
    {
      description: "Permanently delete a teammate. A teammate must be offboarded first; pass force:true to offboard-then-delete in one step.",
      inputSchema: { teammateId: z.string().min(1).describe(TEAMMATE_ID_DESC), force: z.boolean().optional() },
    },
    async (args) => {
      try {
        await ctx.teammates.permanentDelete(args.teammateId);
      } catch (err) {
        if (args.force && err instanceof DiaflowHttpError && err.code === "permanent_delete_conflict") {
          await ctx.teammates.offboard(args.teammateId);
          await ctx.teammates.permanentDelete(args.teammateId);
        } else {
          throw err;
        }
      }
      return asText({ deleted: true, teammateId: args.teammateId });
    },
  );
}
