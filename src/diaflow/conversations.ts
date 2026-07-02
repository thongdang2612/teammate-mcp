import type { DiaflowClient } from "./client.js";
import type { CompletionResult, FileRef } from "./types.js";

interface CompletionResponse {
  thread_id?: string;
  session_id?: string;
  choices?: { message?: { role?: string; content?: string } }[];
  usage?: { total_tokens?: number };
}

export class ConversationsApi {
  constructor(private readonly client: DiaflowClient) {}

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

    const res = await this.client.request<CompletionResponse>("POST", "/agent-runtime/completions", { body });
    return {
      threadId: res.thread_id ?? res.session_id ?? params.threadId ?? "",
      reply: res.choices?.[0]?.message?.content ?? "",
      usage: res.usage ? { totalTokens: res.usage.total_tokens } : undefined,
    };
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
