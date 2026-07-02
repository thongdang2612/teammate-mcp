import { z } from "zod";

const schema = z.object({
  DIAFLOW_API_BASE: z.string().url(),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(8787),
  MCP_PUBLIC_URL: z.string().url().optional(),
  MCP_INBOUND_TOKEN: z.string().optional(),
  DIAFLOW_TOKEN: z.string().optional(),
  DIAFLOW_WORKSPACE_ID: z.coerce.number().int().positive().optional(),
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
    httpPort: parsed.MCP_HTTP_PORT,
    publicUrl: parsed.MCP_PUBLIC_URL,
    inboundToken: parsed.MCP_INBOUND_TOKEN || undefined,
    staticToken: parsed.DIAFLOW_TOKEN || undefined,
    staticWorkspaceId: parsed.DIAFLOW_WORKSPACE_ID,
  };
}
