import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SubAgentsApi } from "../diaflow/sub-agents.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const starterPrompt = z.object({ title: z.string(), prompt: z.string() });

export function registerSubAgentTools(server: McpServer, ctx: { subAgents: SubAgentsApi }): void {
  server.registerTool(
    "list_sub_agents",
    { description: "List the sub-agents attached to an orchestrator teammate.", inputSchema: { teammateId: z.string().min(1) } },
    async (args) => asText(await ctx.subAgents.list(args.teammateId)),
  );

  server.registerTool(
    "add_sub_agent",
    { description: "Attach an existing teammate as a sub-agent of an orchestrator teammate.", inputSchema: { teammateId: z.string().min(1), subAgentId: z.string().min(1) } },
    async (args) => asText(await ctx.subAgents.attach(args.teammateId, args.subAgentId)),
  );

  server.registerTool(
    "create_sub_agent",
    {
      description: "Create a new teammate and attach it as a sub-agent of an orchestrator in one step.",
      inputSchema: {
        teammateId: z.string().min(1),
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
    async (args) => {
      const { teammateId, ...fields } = args;
      return asText(await ctx.subAgents.create(teammateId, fields));
    },
  );

  server.registerTool(
    "remove_sub_agent",
    { description: "Detach a sub-agent from an orchestrator teammate.", inputSchema: { teammateId: z.string().min(1), subAgentId: z.string().min(1) } },
    async (args) => {
      await ctx.subAgents.detach(args.teammateId, args.subAgentId);
      return asText({ detached: true, teammateId: args.teammateId, subAgentId: args.subAgentId });
    },
  );
}
