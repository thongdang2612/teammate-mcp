import type { CompletionResult, RunResult, FileRef } from "../diaflow/types.js";
import { JobStore, type Job, type JobKind } from "./job-store.js";

/** The slice of ConversationsApi the runner needs — kept narrow so it's trivial to mock in tests. */
export interface RunnerConversations {
  sendMessage(params: {
    teammateId?: string;
    message: string;
    threadId?: string;
    files?: FileRef[];
    webSearch?: boolean;
  }): Promise<CompletionResult>;
  waitForReply(threadId: string, budgetMs?: number): Promise<RunResult>;
}

export interface RunnerOptions {
  /** Overall wall-clock budget for one teammate run before we give up. */
  maxMs?: number;
  /** Per-reconnect budget — must stay under Diaflow's ~60s upstream LB cut. */
  reconnectMs?: number;
  now?: () => number;
  onProgress?: (note: string) => void;
}

export interface RelayStep {
  teammateId: string;
  /** Optional instruction prepended to the previous hop's output for this hop. */
  instruction?: string;
}

// Not env-configurable by design — these track backend limits, not user preference.
const JOB_MAX_MS = 12 * 60 * 1000; // overall per-run ceiling (well within a WorkOS session)
const RECONNECT_MS = 50_000; // under Diaflow's 60s upstream cut; our outbound calls aren't proxy-capped

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

/**
 * Drive a single teammate run to a terminal state via plain awaits — the deterministic waiting the
 * orchestrator LLM can't reliably do. `sendMessage` starts the run; if it doesn't finish inside the
 * send window we reconnect (`waitForReply`) repeatedly until the run completes/fails or the overall
 * deadline passes. Runs off the tool-call request path (in a background job), so it is NOT subject
 * to Diaflow's 30s MCP-proxy cap.
 */
export async function runToCompletion(
  conv: RunnerConversations,
  params: { teammateId?: string; message: string; threadId?: string; files?: FileRef[]; webSearch?: boolean },
  opts: RunnerOptions = {},
): Promise<RunResult> {
  const now = opts.now ?? (() => Date.now());
  const reconnectMs = opts.reconnectMs ?? RECONNECT_MS;
  const deadline = now() + (opts.maxMs ?? JOB_MAX_MS);

  const first = await conv.sendMessage(params);
  if (first.status !== "working") return first; // completed | failed | interrupted
  let threadId = first.threadId;
  if (!threadId) return { status: "working", threadId: "" };

  let checks = 0;
  while (now() < deadline) {
    const r = await conv.waitForReply(threadId, reconnectMs);
    if (r.status !== "working") return r;
    threadId = r.threadId || threadId;
    checks += 1;
    opts.onProgress?.(`still working (${checks} checks)`);
  }
  return { status: "working", threadId };
}

/**
 * Run a sequential relay: each hop's reply is fed into the next hop as input (optionally prefixed
 * by that hop's instruction). Stops and reports on the first hop that fails or times out.
 */
export async function runRelay(
  conv: RunnerConversations,
  steps: RelayStep[],
  message: string,
  opts: RunnerOptions = {},
): Promise<RunResult & { atStep?: number }> {
  let out = message;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    opts.onProgress?.(`step ${i + 1}/${steps.length} (${step.teammateId})`);
    const hopMessage = step.instruction ? `${step.instruction}\n\n${out}` : out;
    const r = await runToCompletion(conv, { teammateId: step.teammateId, message: hopMessage }, opts);
    if (r.status === "completed") {
      out = r.reply ?? "";
      continue;
    }
    const reason =
      r.status === "working"
        ? `step ${i + 1} (${step.teammateId}) did not finish in time — it may still be running`
        : r.error ?? `step ${i + 1} (${step.teammateId}) failed`;
    return { status: "failed", threadId: r.threadId, error: reason, atStep: i + 1 };
  }
  return { status: "completed", threadId: "", reply: out };
}

/**
 * Create a job, run `exec` to completion in a detached task that writes the outcome into the store,
 * and return the job id immediately (plus the settling promise, so the caller can race a short grace
 * window for quick tasks). `exec` never rejects out of the store — failures land as `status:"failed"`.
 */
export function startJob(
  store: JobStore,
  kind: JobKind,
  exec: (onProgress: (note: string) => void) => Promise<RunResult>,
): { jobId: string; settled: Promise<Job> } {
  const job = store.create(kind);
  const settled = (async (): Promise<Job> => {
    try {
      const r = await exec((note) => store.update(job.id, { progress: note }));
      if (r.status === "completed") {
        store.update(job.id, { status: "completed", reply: r.reply ?? "" });
      } else if (r.status === "working") {
        store.update(job.id, { status: "failed", error: "The teammate did not finish in time; it may still be running server-side." });
      } else {
        store.update(job.id, { status: "failed", error: r.error ?? "The teammate run did not complete." });
      }
    } catch (e) {
      store.update(job.id, { status: "failed", error: (e as Error).message });
    }
    return store.get(job.id)!;
  })();
  return { jobId: job.id, settled };
}

/** Await a job's completion up to `graceMs`; resolves to the final Job if it settled, else null. */
export async function raceGrace(settled: Promise<Job>, graceMs: number): Promise<Job | null> {
  return Promise.race([settled, delay(graceMs).then(() => null)]);
}
