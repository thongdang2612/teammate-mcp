import type { AppConfig } from "../config.js";
import { DiaflowClient } from "../diaflow/client.js";
import { TeammatesApi } from "../diaflow/teammates.js";
import { SkillsApi } from "../diaflow/skills.js";
import { MemorySessionStore } from "../auth/session-store.js";
import { WorkOSSessionProvider, StaticTokenProvider, type TokenProvider } from "../auth/token-provider.js";

export interface ToolContext {
  provider: TokenProvider;
  client: DiaflowClient;
  teammates: TeammatesApi;
  skills: SkillsApi;
  baseUrl: string;
  publicUrl?: string;
  inboundToken?: string;
}

export function buildContext(cfg: AppConfig): ToolContext {
  const provider: TokenProvider = cfg.staticToken
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
    baseUrl: cfg.diaflowApiBase,
    publicUrl: cfg.publicUrl,
    inboundToken: cfg.inboundToken,
  };
}
