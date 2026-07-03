import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillsApi } from "../diaflow/skills.js";
import type { SkillRef } from "../diaflow/types.js";
import { TEAMMATE_ID_DESC } from "./descriptions.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const errText = (msg: string) => ({ isError: true as const, content: [{ type: "text" as const, text: msg }] });

const refShape = {
  skillWorkspaceId: z.number().int().positive().optional(),
  skillSystemId: z.number().int().positive().optional(),
  skillUserId: z.number().int().positive().optional(),
};

function toRef(args: { skillWorkspaceId?: number; skillSystemId?: number; skillUserId?: number }): SkillRef | null {
  const provided = [args.skillWorkspaceId, args.skillSystemId, args.skillUserId].filter((v) => v !== undefined);
  if (provided.length !== 1) return null;
  return { skillWorkspaceId: args.skillWorkspaceId, skillSystemId: args.skillSystemId, skillUserId: args.skillUserId };
}

export function registerSkillTools(server: McpServer, ctx: { skills: SkillsApi }): void {
  server.registerTool(
    "list_teammate_skills",
    { description: "List skills attached to a teammate.", inputSchema: { teammateId: z.string().min(1).describe(TEAMMATE_ID_DESC) } },
    async (args) => asText(await ctx.skills.listAttached(args.teammateId)),
  );

  server.registerTool(
    "list_available_skills",
    { description: "List skills that can be attached to a teammate.", inputSchema: { teammateId: z.string().min(1).describe(TEAMMATE_ID_DESC) } },
    async (args) => asText(await ctx.skills.listAvailable(args.teammateId)),
  );

  server.registerTool(
    "attach_skill",
    { description: "Attach a skill to a teammate. Provide exactly one of skillWorkspaceId / skillSystemId / skillUserId.", inputSchema: { teammateId: z.string().min(1).describe(TEAMMATE_ID_DESC), ...refShape } },
    async (args) => {
      const ref = toRef(args);
      if (!ref) return errText("Provide exactly one of skillWorkspaceId, skillSystemId, skillUserId.");
      return asText(await ctx.skills.attach(args.teammateId, ref));
    },
  );

  server.registerTool(
    "detach_skill",
    { description: "Detach a skill from a teammate. Provide exactly one of skillWorkspaceId / skillSystemId / skillUserId.", inputSchema: { teammateId: z.string().min(1).describe(TEAMMATE_ID_DESC), ...refShape } },
    async (args) => {
      const ref = toRef(args);
      if (!ref) return errText("Provide exactly one of skillWorkspaceId, skillSystemId, skillUserId.");
      await ctx.skills.detach(args.teammateId, ref);
      return asText({ detached: true });
    },
  );
}
