import type { DiaflowClient } from "./client.js";
import type { CompletionResult, RunResult, FileRef } from "./types.js";

interface CompletionResponse {
  thread_id?: string;
  session_id?: string;
  choices?: { message?: { role?: string; content?: string } }[];
  usage?: { total_tokens?: number };
}

/** Loosely-typed message; the exact envelope path is normalized in `pickList`. */
interface RtMessage {
  role?: string;
  content?: string;
}
interface RtSession {
  session_id?: string;
  thread_id?: string;
  id?: string | number;
}

const DEFAULT_WAIT_MS = 25000;

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

/**
 * Normalize Diaflow list payloads: the backend uses a `{ data, message, status }` envelope with
 * paginated `results`, but some endpoints return the array at the top level. Accept both shapes.
 * NOTE: the exact shapes of `/agent-runtime/sessions` and `.../history` are UNVERIFIED against live
 * Diaflow (dev seal expired during build) — confirm and tighten with one live probe.
 */
function pickList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const o = payload as { data?: { results?: T[] }; results?: T[] };
    return o.data?.results ?? o.results ?? [];
  }
  return [];
}

export class ConversationsApi {
  constructor(
    private readonly client: DiaflowClient,
    private readonly waitMs: number = DEFAULT_WAIT_MS,
  ) {}

  /**
   * Send a message to a teammate. Blocks up to `waitMs` for the reply:
   *  - reply within the bound  → `{ status: "completed", threadId, reply, usage? }`
   *  - exceeds the bound        → `{ status: "working", threadId }` (the target's run continues
   *    server-side; retrieve the result later via `getLatestReply`).
   * A caller-supplied `thread_id` is only sent when continuing an existing thread — the backend
   * rejects unknown thread ids as "Session expired", so new runs let the backend assign the id.
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
      stream: false,
    };
    if (params.teammateId) body.agent_unique_id = params.teammateId;
    if (params.threadId) body.thread_id = params.threadId;
    if (params.files?.length) body.files = params.files;
    if (params.webSearch !== undefined) body.web_search_enabled = params.webSearch;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.waitMs);
    try {
      const res = await this.client.request<CompletionResponse>("POST", "/agent-runtime/completions", {
        body,
        signal: controller.signal,
      });
      return {
        status: "completed",
        threadId: res.thread_id ?? res.session_id ?? params.threadId ?? "",
        reply: res.choices?.[0]?.message?.content ?? "",
        usage: res.usage ? { totalTokens: res.usage.total_tokens } : undefined,
      };
    } catch (e) {
      if (isAbortError(e)) return { status: "working", threadId: params.threadId ?? "" };
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Retrieve the latest reply from a teammate's most recent conversation — used to poll the result
   * of a `sendMessage` that returned `status:"working"`. Returns `completed` with the reply once an
   * assistant message is present, `working` while none is, or `unknown` when the teammate has no
   * session yet.
   */
  async getLatestReply(teammateId: string): Promise<RunResult> {
    const sessionsPayload = await this.client.request<unknown>("GET", "/agent-runtime/sessions", {
      query: { agent_id: teammateId, page: 1, pageSize: 1 },
    });
    const sessions = pickList<RtSession>(sessionsPayload);
    const newest = sessions[0];
    const sid = newest?.session_id ?? newest?.thread_id ?? (newest?.id != null ? String(newest.id) : undefined);
    if (!sid) return { status: "unknown", threadId: "" };

    const historyPayload = await this.client.request<unknown>(
      "GET",
      `/agent-runtime/sessions/${encodeURIComponent(sid)}/history`,
      { query: { limit: 20 } },
    );
    const messages = pickList<RtMessage>(historyPayload);
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && (m.content ?? "").length > 0);
    if (lastAssistant) return { status: "completed", threadId: sid, reply: lastAssistant.content ?? "" };
    return { status: "working", threadId: sid };
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
}
