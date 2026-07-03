import { z } from "zod";

/** Empty-string env values are treated as absent, so defaults/optionals kick in. */
const emptyToUndefined = (v: unknown): unknown => (v === "" ? undefined : v);

const schema = z.object({
  DIAFLOW_API_BASE: z.url(),
  MCP_TRANSPORT: z.preprocess(emptyToUndefined, z.enum(["stdio", "http"]).default("stdio")),
  MCP_HTTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(8787)),
  // Must stay under Diaflow's MCP proxy cap: it kills any tool call taking >30s and fabricates a
  // fake "too slow, do not retry" success, discarding our real result (diaflow-backend
  // modules/mcp/proxy.py _FORWARD_MAX_SECONDS = 30.0). 20s leaves margin for network/Render latency
  // so our real completed/working result always reaches the caller.
  MESSAGE_TEAMMATE_WAIT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(20000)),
  // Many container hosts (Cloud Run, Render, Fly, Heroku, …) inject the listen port as `PORT`.
  // When present it takes precedence over MCP_HTTP_PORT.
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  MCP_PUBLIC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  MCP_INBOUND_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  DIAFLOW_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  DIAFLOW_WORKSPACE_ID: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  MCP_AUTH_MODE: z.preprocess(emptyToUndefined, z.enum(["oauth", "static"]).optional()),
});

export interface AppConfig {
  diaflowApiBase: string;
  transport: "stdio" | "http";
  httpPort: number;
  publicUrl?: string;
  inboundToken?: string;
  staticToken?: string;
  staticWorkspaceId?: number;
  authMode: "oauth" | "static";
  oauthIssuerUrl?: string;
  oauthResourceUrl?: string;
  messageWaitMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);

  const authMode = parsed.MCP_AUTH_MODE ?? "static";

  if (authMode === "oauth") {
    if (!parsed.MCP_PUBLIC_URL || !parsed.MCP_PUBLIC_URL.startsWith("https://")) {
      throw new Error("MCP_AUTH_MODE=oauth requires MCP_PUBLIC_URL to be an https:// URL (e.g. https://host/mcp)");
    }
  }

  const oauthResourceUrl = authMode === "oauth" ? parsed.MCP_PUBLIC_URL!.replace(/\/+$/, "") : undefined;
  const oauthIssuerUrl = oauthResourceUrl ? new URL(oauthResourceUrl).origin : undefined;

  return {
    diaflowApiBase: parsed.DIAFLOW_API_BASE.replace(/\/+$/, ""),
    transport: parsed.MCP_TRANSPORT,
    httpPort: parsed.PORT ?? parsed.MCP_HTTP_PORT,
    publicUrl: parsed.MCP_PUBLIC_URL,
    inboundToken: parsed.MCP_INBOUND_TOKEN || undefined,
    staticToken: parsed.DIAFLOW_TOKEN || undefined,
    staticWorkspaceId: parsed.DIAFLOW_WORKSPACE_ID,
    authMode,
    oauthIssuerUrl,
    oauthResourceUrl,
    messageWaitMs: parsed.MESSAGE_TEAMMATE_WAIT_MS,
  };
}
