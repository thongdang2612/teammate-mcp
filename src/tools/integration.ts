import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiaflowClient } from "../diaflow/client.js";
import type { TokenProvider } from "../auth/token-provider.js";
import { registerCustomMcp as defaultRegister, attachMcpToAgent as defaultAttach } from "../diaflow/custom-mcp.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const errText = (msg: string) => ({ isError: true as const, content: [{ type: "text" as const, text: msg }] });

export interface IntegrationDeps {
  client: DiaflowClient;
  provider: Pick<TokenProvider, "getWorkspaceId">;
  publicUrl?: string;
  inboundToken?: string;
  registerCustomMcp?: typeof defaultRegister;
  attachMcpToAgent?: typeof defaultAttach;
}

export function registerIntegrationTools(server: McpServer, deps: IntegrationDeps): void {
  const register = deps.registerCustomMcp ?? defaultRegister;
  const attach = deps.attachMcpToAgent ?? defaultAttach;

  server.registerTool(
    "register_self_as_custom_mcp",
    {
      description: "Register THIS MCP server as a Diaflow custom MCP resource (requires MCP_PUBLIC_URL https + MCP_INBOUND_TOKEN).",
      inputSchema: { name: z.string().optional() },
    },
    async (args) => {
      const ws = deps.provider.getWorkspaceId();
      if (ws == null) return errText("No active workspace. Connect and/or set_workspace first.");
      if (!deps.publicUrl || !deps.publicUrl.startsWith("https://")) return errText("MCP_PUBLIC_URL must be a public https:// URL ending in /mcp (Diaflow rejects http/localhost/private).");
      if (!deps.inboundToken) return errText("Refusing to register an unauthenticated public MCP endpoint. Set MCP_INBOUND_TOKEN first, then retry.");
      const r = await register(deps.client, ws, { url: deps.publicUrl, name: args.name ?? "Diaflow Teammate MCP", key: deps.inboundToken });
      return asText(r);
    },
  );

  server.registerTool(
    "attach_self_to_teammate",
    {
      description: "Attach a registered custom-MCP resource to a teammate so it can call this server's tools.",
      inputSchema: { teammateId: z.string().min(1), resourceId: z.number().int().positive(), actions: z.array(z.string()).optional() },
    },
    async (args) => asText(await attach(deps.client, args.teammateId, args.resourceId, args.actions)),
  );
}
