import type { DiaflowClient } from "./client.js";
import { DiaflowHttpError } from "./errors.js";
import { readSse, type SseFrame } from "./sse.js";
import type { CompletionResult, RunResult, RunStatus, FileRef } from "./types.js";

// Kept under Diaflow's 30s MCP proxy cap (see config.ts MESSAGE_TEAMMATE_WAIT_MS). Beyond ~30s the
// proxy fabricates a fake "too slow, do not retry" success and discards our real result.
const DEFAULT_WAIT_MS = 20000;

/** Operational diagnostics for the async teammate flow — surfaces in server logs as `[teammate] …`. */
function logTeammate(op: string, info: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.error(`[teammate] ${op} ${JSON.stringify(info)}`);
}

/** Thread id carried by the `metadata` frame (emitted once, early). */
function frameThreadId(frame: SseFrame): string | undefined {
  if (frame.event !== "metadata" || !frame.data || typeof frame.data !== "object") return undefined;
  const d = frame.data as { thread_id?: string; session_id?: string };
  return d.thread_id ?? d.session_id;
}

/** Map a terminal SSE frame to a run outcome, or null for non-terminal frames. */
function terminalOutcome(frame: SseFrame): { status: RunStatus; reply?: string; error?: string } | null {
  const d = (frame.data ?? {}) as { content?: string; error?: unknown };
  switch (frame.event) {
    case "final":
      return { status: "completed", reply: d.content ?? "" };
    case "error":
      return { status: "failed", error: typeof d.error === "string" ? d.error : JSON.stringify(d.error ?? "unknown error") };
    case "cancelled":
      return { status: "interrupted" };
    default:
      return null;
  }
}

/** Newest assistant/`ai` message content from a `/threads/{id}/state` message list. */
function finalMessageContent(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === "object") {
      const mm = m as { type?: string; role?: string; content?: string };
      if ((mm.type === "ai" || mm.role === "assistant") && (mm.content ?? "").length > 0) return mm.content ?? "";
    }
  }
  return "";
}

export class ConversationsApi {
  constructor(
    private readonly client: DiaflowClient,
    private readonly waitMs: number = DEFAULT_WAIT_MS,
  ) {}

  /**
   * Send a message to a teammate over the buffered SSE transport. Reads frames up to `waitMs`:
   * `final` → completed, `error` → failed, `cancelled` → interrupted; if the budget elapses the
   * run keeps going server-side (detached forwarder) and we return `working` with the captured
   * `threadId`. A caller-supplied `threadId` is only sent to continue an existing thread.
   */
  async sendMessage(params: {
    teammateId?: string;
    message: string;
    threadId?: string;
    files?: FileRef[];
    webSearch?: boolean;
  }): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: params.message }],
      stream: true,
    };
    if (params.teammateId) body.agent_unique_id = params.teammateId;
    if (params.threadId) body.thread_id = params.threadId;
    if (params.files?.length) body.files = params.files;
    if (params.webSearch !== undefined) body.web_search_enabled = params.webSearch;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.waitMs);
    let threadId = params.threadId ?? "";
    const events: string[] = [];
    const startedAt = Date.now();
    try {
      const res = await this.client.stream("POST", "/agent-runtime/completions", { body, signal: controller.signal });
      const ct = res.headers.get("content-type") ?? "";
      for await (const frame of readSse(res, controller.signal)) {
        events.push(frame.event);
        const tid = frameThreadId(frame);
        if (tid) threadId = tid;
        const outcome = terminalOutcome(frame);
        if (outcome) {
          logTeammate("message", { status: outcome.status, threadId, ms: Date.now() - startedAt, ct, events, replyLen: outcome.reply?.length ?? 0 });
          return { ...outcome, threadId };
        }
      }
      logTeammate("message", { status: "working", threadId, ms: Date.now() - startedAt, ct, events, streamEnded: true });
      return { status: "working", threadId };
    } catch (e) {
      // Genuine HTTP errors on the initial POST (401/500/…) must surface. A budget abort or a
      // mid-stream network drop after the run started (threadId captured) leaves it running
      // server-side → report working; if nothing started, surface the failure.
      if (e instanceof DiaflowHttpError) throw e;
      if (threadId) {
        logTeammate("message", { status: "working", threadId, ms: Date.now() - startedAt, events, error: String(e) });
        return { status: "working", threadId };
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reconnect to a run and wait for its terminal state, up to `waitMs`. Replays the buffered
   * `:events` (catching `final`/`error` that fired while disconnected) then follows live. If the
   * event buffer has expired (`404`), falls back to `/threads/{id}/state`.
   */
  async waitForReply(threadId: string, budgetMs: number = this.waitMs): Promise<RunResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const events: string[] = [];
    const startedAt = Date.now();
    try {
      const res = await this.client.stream("GET", `/agent-runtime/threads/${encodeURIComponent(threadId)}/stream`, {
        signal: controller.signal,
      });
      const ct = res.headers.get("content-type") ?? "";
      for await (const frame of readSse(res, controller.signal)) {
        events.push(frame.event);
        const outcome = terminalOutcome(frame);
        if (outcome) {
          logTeammate("reply", { status: outcome.status, threadId, ms: Date.now() - startedAt, ct, events, replyLen: outcome.reply?.length ?? 0 });
          return { ...outcome, threadId };
        }
      }
      logTeammate("reply", { status: "working", threadId, ms: Date.now() - startedAt, ct, events, streamEnded: true });
      return { status: "working", threadId };
    } catch (e) {
      // 404 → the event buffer expired; fall back to /state. Other HTTP errors surface. A budget
      // abort or a mid-stream network drop leaves the run going server-side → report working
      // (the caller re-invokes and reconnects).
      if (e instanceof DiaflowHttpError) {
        if (e.status === 404) {
          logTeammate("reply", { status: "404->state", threadId, ms: Date.now() - startedAt, events });
          return this.stateFallback(threadId);
        }
        throw e;
      }
      logTeammate("reply", { status: "working", threadId, ms: Date.now() - startedAt, events, error: String(e) });
      return { status: "working", threadId };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Durable status after the SSE buffer TTL: `/threads/{id}/state` has no `error` status. */
  private async stateFallback(threadId: string): Promise<RunResult> {
    const state = await this.client.request<{ status?: string; messages?: unknown }>(
      "GET",
      `/agent-runtime/threads/${encodeURIComponent(threadId)}/state`,
    );
    if (state.status === "completed") return { status: "completed", threadId, reply: finalMessageContent(state.messages) };
    if (state.status === "interrupted") return { status: "interrupted", threadId };
    return { status: "working", threadId };
  }

  listSessions(params: { agentId?: string; page?: number; pageSize?: number } = {}): Promise<unknown> {
    return this.client.request<unknown>("GET", "/agent-runtime/sessions", {
      query: { agent_id: params.agentId, page: params.page, pageSize: params.pageSize },
    });
  }

  getHistory(sessionId: string, opts: { limit?: number; beforeSequence?: number } = {}): Promise<unknown> {
    return this.client.request<unknown>("GET", `/agent-runtime/sessions/${encodeURIComponent(sessionId)}/history`, {
      query: { limit: opts.limit ?? 50, before_sequence: opts.beforeSequence },
    });
  }

  stop(sessionId: string): Promise<void> {
    return this.client.request<void>("POST", `/agent-runtime/sessions/${encodeURIComponent(sessionId)}/stop`);
  }

  /** Set a conversation session's title (otherwise auto-generated). PUT /agent-runtime/sessions/{id}. */
  async updateTitle(sessionId: string, title: string): Promise<{ sessionId: string; title: string }> {
    const r = await this.client.request<{ session_id: string; title: string }>(
      "PUT",
      `/agent-runtime/sessions/${encodeURIComponent(sessionId)}`,
      { body: { title } },
    );
    return { sessionId: r.session_id, title: r.title };
  }
}
