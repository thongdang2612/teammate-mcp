import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiaflowClient } from "../diaflow/client.js";
import type { ConversationsApi } from "../diaflow/conversations.js";
import type { FileRef } from "../diaflow/types.js";
import { uploadChatAttachment as defaultUpload } from "../diaflow/upload.js";
import { TEAMMATE_ID_DESC } from "./descriptions.js";
import { JobStore, jobStore as defaultJobStore } from "../teammate/job-store.js";
import { startJob, raceGrace, runToCompletion, runRelay, type RelayStep } from "../teammate/runner.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });

/** How long message_teammate holds the tool response, hoping a quick task finishes in one call. */
const GRACE_MS = 8000;

export interface ConversationDeps {
  conversations: ConversationsApi;
  client: DiaflowClient;
  uploadChatAttachment?: typeof defaultUpload;
  now?: () => Date;
  jobStore?: JobStore;
  graceMs?: number;
}

const BUSY = {
  status: "busy" as const,
  note: "Too many teammate tasks are running right now. Wait a moment and try again.",
};

export function registerConversationTools(server: McpServer, deps: ConversationDeps): void {
  const upload = deps.uploadChatAttachment ?? defaultUpload;
  const now = deps.now ?? (() => new Date());
  const store = deps.jobStore ?? defaultJobStore;
  const graceMs = deps.graceMs ?? GRACE_MS;

  server.registerTool(
    "message_teammate",
    {
      description:
        "Send a message to a teammate and get their reply. The teammate runs in the background on " +
        "the server (so long tasks are not cut off): a quick reply comes back inline as plain text; " +
        "a longer one returns { status: \"working\", jobId } — then call get_teammate_reply with that " +
        "jobId to fetch the result (it finishes server-side even if you check back later). Omit " +
        "teammateId only to continue an existing thread. For a multi-step A→B→C hand-off, prefer relay_teammates.",
      inputSchema: {
        message: z.string().min(1),
        teammateId: z.string().optional().describe(TEAMMATE_ID_DESC + " Omit ONLY to continue an existing thread you already started."),
        threadId: z.string().optional(),
        attachmentUrls: z.array(z.string().url()).optional(),
        webSearch: z.boolean().optional(),
      },
    },
    async (args) => {
      if (store.atCapacity()) return asText(BUSY);
      let files: FileRef[] | undefined;
      if (args.attachmentUrls?.length) {
        files = [];
        for (const url of args.attachmentUrls) {
          files.push(await upload(deps.client, { url, threadId: args.threadId, date: now() }));
        }
      }
      const params = { teammateId: args.teammateId, message: args.message, threadId: args.threadId, files, webSearch: args.webSearch };
      const { jobId, settled } = startJob(store, "message", (onProgress) => runToCompletion(deps.conversations, params, { onProgress }));
      const graced = await raceGrace(settled, graceMs);
      if (graced?.status === "completed") return asText(graced.reply ?? "");
      if (graced?.status === "failed") return asText(`The teammate's run failed: ${graced.error ?? "unknown error"}`);
      return asText({
        status: "working",
        jobId,
        note: `The teammate is working in the background. Call get_teammate_reply with jobId "${jobId}" to fetch the result — it completes server-side even if you check later, so just call get_teammate_reply again (with this jobId) until status is "completed".`,
      });
    },
  );

  server.registerTool(
    "relay_teammates",
    {
      description:
        "Run a sequential relay across teammates: send the message to the first, feed its reply to " +
        "the next, and so on (A→B→C…). The whole chain runs in the background on the server — no " +
        "per-step waiting from you. Returns { status: \"working\", jobId }; call get_teammate_reply " +
        "with that jobId to fetch the final result once the chain completes. Each step may include an " +
        "optional instruction prepended to the previous step's output.",
      inputSchema: {
        message: z.string().min(1).describe("The initial message given to the first teammate in the chain."),
        steps: z
          .array(z.object({ teammateId: z.string().min(1), instruction: z.string().optional() }))
          .min(1)
          .describe("Ordered teammates. Each receives the previous step's reply (optionally prefixed by its instruction)."),
      },
    },
    async (args) => {
      if (store.atCapacity()) return asText(BUSY);
      const steps: RelayStep[] = args.steps;
      const { jobId } = startJob(store, "relay", (onProgress) => runRelay(deps.conversations, steps, args.message, { onProgress }));
      return asText({
        status: "working",
        jobId,
        note: `Relay started across ${steps.length} teammate(s), running in the background. Call get_teammate_reply with jobId "${jobId}" to fetch the final result — check back until status is "completed" (the chain finishes server-side regardless).`,
      });
    },
  );

  server.registerTool(
    "get_teammate_reply",
    {
      description:
        "Fetch the result of a background teammate job started by message_teammate or relay_teammates. " +
        "Pass the jobId from that response. Returns the reply as plain text when done, or " +
        "{ status: \"working\", progress } while it runs (call again shortly — it finishes server-side), " +
        "or an error if it failed.",
      inputSchema: {
        jobId: z.string().min(1).describe("The jobId returned by message_teammate or relay_teammates."),
      },
    },
    async (args) => {
      const job = store.get(args.jobId);
      if (!job) {
        return asText({ status: "unknown", note: "No job with that id — it may have expired or the server restarted. Start again with message_teammate or relay_teammates." });
      }
      if (job.status === "completed") return asText(job.reply ?? "");
      if (job.status === "failed") return asText(`The teammate's run failed: ${job.error ?? "unknown error"}`);
      return asText({
        status: "working",
        jobId: job.id,
        progress: job.progress,
        note: `Still running server-side. Call get_teammate_reply with jobId "${job.id}" again shortly — it will finish even if you wait.`,
      });
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
