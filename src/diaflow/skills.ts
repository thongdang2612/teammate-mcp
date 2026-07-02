import type { DiaflowClient } from "./client.js";
import type { AgentSkillLink, AvailableSkill, SkillRef } from "./types.js";

function refToQuery(ref: SkillRef): Record<string, number | undefined> {
  return { skillWorkspaceId: ref.skillWorkspaceId, skillSystemId: ref.skillSystemId, skillUserId: ref.skillUserId };
}

export class SkillsApi {
  constructor(private readonly client: DiaflowClient) {}

  listAttached(uniqueId: string): Promise<AgentSkillLink[]> {
    return this.client.request<AgentSkillLink[]>("GET", `/agents/${encodeURIComponent(uniqueId)}/skill-agents`);
  }

  listAvailable(uniqueId: string): Promise<AvailableSkill[]> {
    return this.client.request<AvailableSkill[]>("GET", `/agents/${encodeURIComponent(uniqueId)}/skill-agents/available`);
  }

  attach(uniqueId: string, ref: SkillRef): Promise<unknown> {
    return this.client.request<unknown>("POST", `/agents/${encodeURIComponent(uniqueId)}/skill-agents/attach`, { body: ref });
  }

  detach(uniqueId: string, ref: SkillRef): Promise<void> {
    return this.client.request<void>("DELETE", `/agents/${encodeURIComponent(uniqueId)}/skill-agents`, { query: refToQuery(ref) });
  }
}
