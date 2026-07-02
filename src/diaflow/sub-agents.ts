import type { DiaflowClient } from "./client.js";
import type { AgentDetail, CreateTeammateFields } from "./types.js";

export class SubAgentsApi {
  constructor(private readonly client: DiaflowClient) {}

  list(uniqueId: string): Promise<AgentDetail[]> {
    return this.client.request<AgentDetail[]>("GET", `/agents/${encodeURIComponent(uniqueId)}/sub-agents`);
  }

  attach(uniqueId: string, subAgentUniqueId: string): Promise<unknown> {
    return this.client.request<unknown>("POST", `/agents/${encodeURIComponent(uniqueId)}/sub-agents`, {
      body: { subAgentUniqueId },
    });
  }

  create(uniqueId: string, fields: CreateTeammateFields): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("POST", `/agents/${encodeURIComponent(uniqueId)}/sub-agents/create`, { body: fields });
  }

  detach(uniqueId: string, subUniqueId: string): Promise<void> {
    return this.client.request<void>("DELETE", `/agents/${encodeURIComponent(uniqueId)}/sub-agents/${encodeURIComponent(subUniqueId)}`);
  }
}
