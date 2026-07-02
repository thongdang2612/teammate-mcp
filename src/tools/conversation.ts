import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiaflowClient } from "../diaflow/client.js";
import type { ConversationsApi } from "../diaflow/conversations.js";
import type { FileRef } from "../diaflow/types.js";
import { uploadChatAttachment as defaultUpload } from "../diaflow/upload.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });

export interface ConversationDeps {
  conversations: ConversationsApi;
  client: DiaflowClient;
  uploadChatAttachment?: typeof defaultUpload;
  now?: () => Date;
}

export function registerConversationTools(server: McpServer, deps: ConversationDeps): void {
  const upload = deps.uploadChatAttachment ?? defaultUpload;
  const now = deps.now ?? (() => new Date());

  server.registerTool(
    "message_teammate",
    {
      description: "Post a message to a teammate and get its reply (synchronous). Omit teammateId to continue an existing thread. Use for agent-to-agent orchestration.",
      inputSchema: {
        message: z.string().min(1),
        teammateId: z.string().optional(),
        threadId: z.string().optional(),
        attachmentUrls: z.array(z.string().url()).optional(),
        webSearch: z.boolean().optional(),
      },
    },
    async (args) => {
      let files: FileRef[] | undefined;
      if (args.attachmentUrls?.length) {
        files = [];
        for (const url of args.attachmentUrls) {
          files.push(await upload(deps.client, { url, threadId: args.threadId, date: now() }));
        }
      }
      const r = await deps.conversations.sendMessage({
        teammateId: args.teammateId,
        message: args.message,
        threadId: args.threadId,
        files,
        webSearch: args.webSearch,
      });
      return asText(r);
    },
  );

  server.registerTool(
    "list_conversations",
    { description: "List conversation sessions, optionally filtered by teammate.", inputSchema: { agentId: z.string().optional(), page: z.number().int().positive().optional(), pageSize: z.number().int().positive().optional() } },
    async (args) => asText(await deps.conversations.listSessions(args)),
  );

  server.registerTool(
    "get_conversation",
    { description: "Get the message history of a conversation session.", inputSchema: { sessionId: z.string().min(1), limit: z.number().int().positive().optional() } },
    async (args) => asText(await deps.conversations.getHistory(args.sessionId, { limit: args.limit })),
  );

  server.registerTool(
    "stop_conversation",
    { description: "Stop/cancel an in-progress conversation run.", inputSchema: { sessionId: z.string().min(1) } },
    async (args) => {
      await deps.conversations.stop(args.sessionId);
      return asText({ stopped: true, sessionId: args.sessionId });
    },
  );
}
