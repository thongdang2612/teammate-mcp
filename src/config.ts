import { z } from "zod";

/** Empty-string env values are treated as absent, so defaults/optionals kick in. */
const emptyToUndefined = (v: unknown): unknown => (v === "" ? undefined : v);

const schema = z.object({
  DIAFLOW_API_BASE: z.url(),
  MCP_TRANSPORT: z.preprocess(emptyToUndefined, z.enum(["stdio", "http"]).default("stdio")),
  MCP_HTTP_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(8787)),
  // Many container hosts (Cloud Run, Render, Fly, Heroku, …) inject the listen port as `PORT`.
  // When present it takes precedence over MCP_HTTP_PORT.
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
  MCP_PUBLIC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
  MCP_INBOUND_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  DIAFLOW_TOKEN: z.preprocess(emptyToUndefined, z.string().optional()),
  DIAFLOW_WORKSPACE_ID: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
});

export interface AppConfig {
  diaflowApiBase: string;
  transport: "stdio" | "http";
  httpPort: number;
  publicUrl?: string;
  inboundToken?: string;
  staticToken?: string;
  staticWorkspaceId?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  return {
    diaflowApiBase: parsed.DIAFLOW_API_BASE.replace(/\/+$/, ""),
    transport: parsed.MCP_TRANSPORT,
    httpPort: parsed.PORT ?? parsed.MCP_HTTP_PORT,
    publicUrl: parsed.MCP_PUBLIC_URL,
    inboundToken: parsed.MCP_INBOUND_TOKEN || undefined,
    staticToken: parsed.DIAFLOW_TOKEN || undefined,
    staticWorkspaceId: parsed.DIAFLOW_WORKSPACE_ID,
  };
}
