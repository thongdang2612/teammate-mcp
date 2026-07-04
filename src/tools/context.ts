import type { AppConfig } from "../config.js";
import { DiaflowClient } from "../diaflow/client.js";
import { TeammatesApi } from "../diaflow/teammates.js";
import { SkillsApi } from "../diaflow/skills.js";
import { SkillUserApi } from "../diaflow/skill-users.js";
import { ConversationsApi } from "../diaflow/conversations.js";
import { SubAgentsApi } from "../diaflow/sub-agents.js";
import { MemorySessionStore } from "../auth/session-store.js";
import { WorkOSSessionProvider, StaticTokenProvider, SealTokenProvider, type TokenProvider } from "../auth/token-provider.js";

export interface ToolContext {
  provider: TokenProvider;
  client: DiaflowClient;
  teammates: TeammatesApi;
  skills: SkillsApi;
  skillUsers: SkillUserApi;
  conversations: ConversationsApi;
  subAgents: SubAgentsApi;
  baseUrl: string;
  publicUrl?: string;
  inboundToken?: string;
}

export function buildContext(
  cfg: AppConfig,
  identity?: { seal: string; workspaceId: number | null; onRotate?: (seal: string) => void },
): ToolContext {
  const provider: TokenProvider = identity
    ? new SealTokenProvider(identity.seal, identity.workspaceId, identity.onRotate)
    : cfg.staticToken
      ? new StaticTokenProvider(cfg.staticToken, cfg.staticWorkspaceId ?? null)
      : new WorkOSSessionProvider({ store: new MemorySessionStore(), key: "default", baseUrl: cfg.diaflowApiBase });

  const client = new DiaflowClient({
    baseUrl: cfg.diaflowApiBase,
    getToken: () => provider.getToken(),
    getWorkspaceId: () => provider.getWorkspaceId(),
    onRotate: (seal) => provider.onRotate(seal),
  });

  return {
    provider,
    client,
    teammates: new TeammatesApi(client),
    skills: new SkillsApi(client),
    skillUsers: new SkillUserApi(client),
    conversations: new ConversationsApi(client, cfg.messageWaitMs),
    subAgents: new SubAgentsApi(client),
    baseUrl: cfg.diaflowApiBase,
    publicUrl: cfg.publicUrl,
    inboundToken: cfg.inboundToken,
  };
}
