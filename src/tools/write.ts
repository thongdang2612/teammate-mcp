import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { TEAMMATE_ID_DESC } from "./descriptions.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const starterPrompt = z.object({ title: z.string(), prompt: z.string() });

export function registerWriteTools(server: McpServer, ctx: Pick<ToolContext, "teammates">): void {
  server.registerTool(
    "create_teammate",
    {
      description:
        "Create a new teammate. modelProvider and modelName are required. The teammate is PUBLISHED by default (immediately live); pass publish:false to leave it as an unpublished draft.",
      inputSchema: {
        modelProvider: z.string().min(1),
        modelName: z.string().min(1),
        name: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        instruction: z.string().optional(),
        welcomeMessage: z.string().optional(),
        intelligence: z.string().optional(),
        starterPrompts: z.array(starterPrompt).optional(),
        tags: z.array(z.string()).optional(),
        icon: z.string().optional(),
        publish: z.boolean().optional().describe("Publish the teammate immediately after creation (default true). Set false to keep it a draft."),
      },
    },
    async (args) => {
      const { publish, ...fields } = args;
      const created = await ctx.teammates.create(fields);
      // Diaflow creates teammates as drafts; publish by default so a created teammate is live.
      if (publish === false) return asText(created);
      return asText(await ctx.teammates.publish(created.uniqueId));
    },
  );

  server.registerTool(
    "update_teammate",
    {
      description:
        "Update a teammate's fields (name, model, description, instruction, tags, icon, ...). This is " +
        "the ONLY way to actually change a teammate — you MUST call it and confirm success before " +
        "telling the user the change is done; never just claim a rename/update happened without calling it. " +
        "To change YOUR OWN name or info, first call list_teammates, find the teammate whose name matches " +
        "the one you currently go by, use its teammateId here, then apply the change.",
      inputSchema: {
        teammateId: z.string().min(1).describe(TEAMMATE_ID_DESC),
        name: z.string().optional(),
        title: z.string().optional(),
        modelProvider: z.string().optional(),
        modelName: z.string().optional(),
        outputFormat: z.string().optional(),
        description: z.string().optional(),
        instruction: z.string().optional(),
        welcomeMessage: z.string().optional(),
        intelligence: z.string().optional(),
        starterPrompts: z.array(starterPrompt).optional(),
        tags: z.array(z.string()).optional(),
        icon: z.string().optional(),
      },
    },
    async (args) => {
      const { teammateId, ...fields } = args;
      return asText(await ctx.teammates.update(teammateId, fields));
    },
  );

  server.registerTool(
    "check_teammate_name",
    {
      description: "Check whether a teammate name is already taken in the workspace.",
      inputSchema: { name: z.string().min(1) },
    },
    async (args) => asText(await ctx.teammates.checkName(args.name)),
  );
}
