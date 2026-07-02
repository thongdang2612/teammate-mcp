import type { AppConfig } from "../config.js";
import { DiaflowClient } from "../diaflow/client.js";
import { TeammatesApi } from "../diaflow/teammates.js";
import { MemorySessionStore } from "../auth/session-store.js";
import { WorkOSSessionProvider, StaticTokenProvider, type TokenProvider } from "../auth/token-provider.js";

export interface ToolContext {
  provider: TokenProvider;
  client: DiaflowClient;
  teammates: TeammatesApi;
  baseUrl: string;
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

  return { provider, client, teammates: new TeammatesApi(client), baseUrl: cfg.diaflowApiBase };
}
