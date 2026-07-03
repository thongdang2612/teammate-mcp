import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiaflowClient } from "../diaflow/client.js";
import type { ConversationsApi } from "../diaflow/conversations.js";
import type { FileRef } from "../diaflow/types.js";
import { uploadChatAttachment as defaultUpload } from "../diaflow/upload.js";
import { TEAMMATE_ID_DESC } from "./descriptions.js";

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
      description:
        "Post a message to a teammate. Returns { status }: \"completed\" with the reply for quick tasks, " +
        "or \"working\" (with a threadId) for long tasks — the target keeps running server-side. " +
        "If status is \"working\", you MUST call get_teammate_reply with that threadId, calling again until it " +
        "returns \"completed\", to get the result. Omit teammateId only to continue an existing thread. " +
        "Use for agent-to-agent orchestration.",
      inputSchema: {
        message: z.string().min(1),
        teammateId: z.string().optional().describe(TEAMMATE_ID_DESC + " Omit ONLY to continue an existing thread you already started."),
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
      // Completed: hand back the teammate's reply as plain text — the answer is here, so the
      // orchestrator should treat this as a finished tool call, not a status object to act on.
      if (r.status === "completed") return asText(r.reply ?? "");
      if (r.status === "failed") return asText(`The teammate's run failed: ${r.error ?? "unknown error"}`);
      if (r.status === "working") {
        return asText({
          ...r,
          note: `The teammate has NOT finished — you do NOT have the result yet. Call get_teammate_reply with threadId "${r.threadId}" NOW, and keep calling it repeatedly (each call waits ~20s) until it returns status "completed". A long task can need many polls over several minutes — do NOT stop after one or two, and do NOT tell the user it is "still working" or move on until you have the completed reply. Only if it is clearly taking many minutes should you report interim status and tell the user they can ask you to check again.`,
        });
      }
      return asText(r);
    },
  );

  server.registerTool(
    "get_teammate_reply",
    {
      description:
        "Wait for and fetch a teammate's reply after message_teammate returned status \"working\". " +
        "Pass the threadId from that response. Blocks server-side until the run reaches a terminal " +
        "state or the wait budget elapses, then returns { status: \"completed\" | \"failed\" | " +
        "\"interrupted\" | \"working\", reply?, error? }. If \"working\", the run is still going — " +
        "call get_teammate_reply again with the same threadId, and keep polling (a long task may " +
        "need many calls over several minutes) until it returns \"completed\". Do not give up early.",
      inputSchema: {
        threadId: z.string().min(1).describe("The threadId returned by message_teammate for this run."),
      },
    },
    async (args) => {
      const r = await deps.conversations.waitForReply(args.threadId);
      if (r.status === "completed") return asText(r.reply ?? "");
      if (r.status === "failed") return asText(`The teammate's run failed: ${r.error ?? "unknown error"}`);
      return asText(r); // working / interrupted — keep the structured shape so the caller can retry
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
