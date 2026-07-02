import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const starterPrompt = z.object({ title: z.string(), prompt: z.string() });

export function registerWriteTools(server: McpServer, ctx: Pick<ToolContext, "teammates">): void {
  server.registerTool(
    "create_teammate",
    {
      description: "Create a new teammate. modelProvider and modelName are required.",
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
      },
    },
    async (args) => asText(await ctx.teammates.create(args)),
  );

  server.registerTool(
    "update_teammate",
    {
      description: "Update a teammate's fields (name, model, description, instruction, tags, icon, ...).",
      inputSchema: {
        teammateId: z.string().min(1),
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
