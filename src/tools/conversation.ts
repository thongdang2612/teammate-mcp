import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiaflowClient } from "../diaflow/client.js";
import type { ConversationsApi } from "../diaflow/conversations.js";
import type { FileRef } from "../diaflow/types.js";
import { uploadChatAttachment as defaultUpload } from "../diaflow/upload.js";
import { TEAMMATE_ID_DESC } from "./descriptions.js";
import { JobStore, jobStore as defaultJobStore } from "../teammate/job-store.js";
import { startJob, raceGrace, awaitJob, runToCompletion, runRelay, type RelayStep } from "../teammate/runner.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });

/** Encode the next poll number into the id the orchestrator passes back, so each poll's args differ. */
export function makePollToken(jobId: string, nextPoll: number): string {
  return `${jobId}::p${nextPoll}`;
}

/** Recover the real job id + current poll number from a raw jobId or a "<jobId>::p<N>" token. */
export function parsePollToken(raw: string): { jobId: string; pollNumber: number } {
  const idx = raw.lastIndexOf("::p");
  if (idx > 0) {
    const suffix = raw.slice(idx + 3);
    if (/^\d+$/.test(suffix)) return { jobId: raw.slice(0, idx), pollNumber: Number(suffix) };
  }
  return { jobId: raw, pollNumber: 0 };
}

/** How long message_teammate holds the tool response, hoping a quick task finishes in one call. */
const GRACE_MS = 8000;
/** How long get_teammate_reply blocks waiting for a job — under Diaflow's 30s MCP-proxy cap. */
const REPLY_WAIT_MS = 20000;

export interface ConversationDeps {
  conversations: ConversationsApi;
  client: DiaflowClient;
  uploadChatAttachment?: typeof defaultUpload;
  now?: () => Date;
  jobStore?: JobStore;
  graceMs?: number;
  replyWaitMs?: number;
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
  const replyWaitMs = deps.replyWaitMs ?? REPLY_WAIT_MS;

  server.registerTool(
    "message_teammate",
    {
      description:
        "Send a message to ONE teammate and get their reply. The teammate runs in the background on " +
        "the server (so long tasks are not cut off): a quick reply comes back inline as plain text; " +
        "a longer one returns { status: \"working\", jobId } — then call get_teammate_reply with that " +
        "jobId to fetch the result (it finishes server-side even if you check back later). Omit " +
        "teammateId only to continue an existing thread. " +
        "IMPORTANT: if the task is to take one teammate's reply and pass it to ANOTHER teammate " +
        "(any \"ask X, then send it to Y\" or A→B→C hand-off), do NOT chain message_teammate calls " +
        "yourself — call relay_teammates instead. It runs the whole chain server-side in one step and " +
        "is far more reliable for multi-teammate work.",
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
        "USE THIS for ANY task involving more than one teammate in sequence — e.g. \"ask A, then send " +
        "A's answer to B\", or A→B→C. It is the correct tool for every multi-teammate hand-off; do not " +
        "emulate it with multiple message_teammate calls. Runs a sequential relay: the message goes to " +
        "the first teammate, its reply feeds the next, and so on — the ENTIRE chain runs in the " +
        "background on the server, no per-step waiting from you. Returns { status: \"working\", jobId }; " +
        "call get_teammate_reply with that jobId to fetch the final result once the chain completes. " +
        "Each step may include an optional instruction prepended to the previous step's output.",
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
      if (!store.get(args.jobId)) {
        return asText({ status: "unknown", note: "No job with that id — it may have expired or the server restarted. Start again with message_teammate or relay_teammates." });
      }
      // Block for a real window (under the 30s proxy cap) so this poll actually WAITS for the job
      // instead of returning instantly — otherwise the orchestrator hammers it and gives up in seconds.
      const job = (await awaitJob(store, args.jobId, replyWaitMs))!;
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

  server.registerTool(
    "rename_conversation",
    {
      description:
        "Set the title of a conversation session (the title is otherwise auto-generated from the first " +
        "message). Find the sessionId with list_conversations first.",
      inputSchema: {
        sessionId: z.string().min(1).describe("The conversation session id (from list_conversations)."),
        title: z.string().min(1).max(200).describe("The new title (1-200 characters)."),
      },
    },
    async (args) => asText(await deps.conversations.updateTitle(args.sessionId, args.title)),
  );
}
