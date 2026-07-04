import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillUserApi } from "../diaflow/skill-users.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });

const SKILL_ID = "The personal skill's unique id (the uniqueId returned by create_personal_skill / list_personal_skills).";
const DEFAULT_FILE = "SKILL.md";

export function registerSkillAuthoringTools(server: McpServer, ctx: { skillUsers: SkillUserApi }): void {
  server.registerTool(
    "create_personal_skill",
    {
      description:
        "Create a new PERSONAL skill you own (name + optional description). Pass `content` to also write its SKILL.md in the same call. " +
        "This creates a skill DEFINITION; use attach_skill afterwards to add it to a teammate.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        content: z.string().optional().describe("Initial SKILL.md content. If given, it is written after the skill is created."),
      },
    },
    async (args) => {
      const skill = await ctx.skillUsers.create({ name: args.name, description: args.description });
      if (args.content === undefined) return asText(skill);
      await ctx.skillUsers.writeFile(skill.uniqueId, DEFAULT_FILE, args.content);
      return asText(await ctx.skillUsers.get(skill.uniqueId));
    },
  );

  server.registerTool(
    "list_personal_skills",
    { description: "List the personal skills you own.", inputSchema: {} },
    async () => asText(await ctx.skillUsers.list()),
  );

  server.registerTool(
    "get_personal_skill",
    { description: "Get one personal skill by id, including its files map.", inputSchema: { skillId: z.string().min(1).describe(SKILL_ID) } },
    async (args) => asText(await ctx.skillUsers.get(args.skillId)),
  );

  server.registerTool(
    "update_personal_skill",
    {
      description: "Update a personal skill's name and/or description. To change file CONTENT, use write_personal_skill_file instead.",
      inputSchema: { skillId: z.string().min(1).describe(SKILL_ID), name: z.string().optional(), description: z.string().optional() },
    },
    async (args) => asText(await ctx.skillUsers.update(args.skillId, { name: args.name, description: args.description })),
  );

  server.registerTool(
    "delete_personal_skill",
    { description: "Delete a personal skill you own.", inputSchema: { skillId: z.string().min(1).describe(SKILL_ID) } },
    async (args) => {
      await ctx.skillUsers.remove(args.skillId);
      return asText({ deleted: true, skillId: args.skillId });
    },
  );

  server.registerTool(
    "write_personal_skill_file",
    {
      description: "Write (create or overwrite) one file inside a personal skill. `path` defaults to SKILL.md. Content is plain text.",
      inputSchema: {
        skillId: z.string().min(1).describe(SKILL_ID),
        path: z.string().min(1).optional().describe('Relative file path within the skill. Defaults to "SKILL.md".'),
        content: z.string(),
      },
    },
    async (args) => {
      const path = args.path ?? DEFAULT_FILE;
      await ctx.skillUsers.writeFile(args.skillId, path, args.content);
      return asText({ written: true, path });
    },
  );

  server.registerTool(
    "read_personal_skill_file",
    {
      description: "Read one file's text from a personal skill. `path` defaults to SKILL.md.",
      inputSchema: { skillId: z.string().min(1).describe(SKILL_ID), path: z.string().min(1).optional().describe('Defaults to "SKILL.md".') },
    },
    async (args) => asText(await ctx.skillUsers.readFile(args.skillId, args.path ?? DEFAULT_FILE)),
  );

  server.registerTool(
    "remove_personal_skill_file",
    {
      description: "Remove one file from a personal skill by its relative path.",
      inputSchema: { skillId: z.string().min(1).describe(SKILL_ID), path: z.string().min(1) },
    },
    async (args) => asText(await ctx.skillUsers.removeFiles(args.skillId, [args.path])),
  );
}
