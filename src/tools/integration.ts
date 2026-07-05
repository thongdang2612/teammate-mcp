import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiaflowClient } from "../diaflow/client.js";
import type { TokenProvider } from "../auth/token-provider.js";
import type { TeammatesApi } from "../diaflow/teammates.js";
import { registerCustomMcp as defaultRegister, attachMcpToAgent as defaultAttach } from "../diaflow/custom-mcp.js";
import { listTeammateConnectors as defaultListConnectors, addConnectorToAgent as defaultAddConnector } from "../diaflow/connectors.js";
import { resolveTeammateId } from "./resolve-teammate.js";
import { TEAMMATE_ID_DESC } from "./descriptions.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const errText = (msg: string) => ({ isError: true as const, content: [{ type: "text" as const, text: msg }] });

export interface IntegrationDeps {
  client: DiaflowClient;
  provider: Pick<TokenProvider, "getWorkspaceId">;
  teammates: Pick<TeammatesApi, "list">;
  publicUrl?: string;
  inboundToken?: string;
  registerCustomMcp?: typeof defaultRegister;
  attachMcpToAgent?: typeof defaultAttach;
  listTeammateConnectors?: typeof defaultListConnectors;
  addConnectorToAgent?: typeof defaultAddConnector;
}

const TEAMMATE_REF_DESC = "Identify the target teammate by EITHER teammateId OR teammateName (its current name, resolved server-side).";

export function registerIntegrationTools(server: McpServer, deps: IntegrationDeps): void {
  const register = deps.registerCustomMcp ?? defaultRegister;
  const attach = deps.attachMcpToAgent ?? defaultAttach;
  const listConnectors = deps.listTeammateConnectors ?? defaultListConnectors;
  const addConnector = deps.addConnectorToAgent ?? defaultAddConnector;

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
      inputSchema: { teammateId: z.string().min(1).describe(TEAMMATE_ID_DESC), resourceId: z.number().int().positive(), actions: z.array(z.string()).optional() },
    },
    async (args) => asText(await attach(deps.client, args.teammateId, args.resourceId, args.actions)),
  );

  server.registerTool(
    "list_teammate_connectors",
    {
      description:
        "List the connectors (apps/MCP integrations) currently attached to a teammate. Use this to " +
        "DISCOVER an existing connector's nodeType + resourceId + tool actions before attaching it to " +
        "another teammate with add_connector, or before changing its permissions with set_connector_permissions.",
      inputSchema: {
        teammateId: z.string().optional().describe(TEAMMATE_ID_DESC + " Provide this OR teammateName."),
        teammateName: z.string().optional().describe("The teammate's current name — resolved to its id server-side."),
      },
    },
    async (args) => {
      const resolved = await resolveTeammateId(deps.teammates, args);
      if (!resolved.ok) return asText({ error: resolved.error, candidates: resolved.candidates });
      return asText(await listConnectors(deps.client, resolved.id));
    },
  );

  const permissionSchema = z.object({ key: z.string().min(1), permission: z.enum(["allow", "ask", "deny"]) });

  server.registerTool(
    "add_connector",
    {
      description:
        "Attach an EXISTING connector (one already set up in the workspace — e.g. found via " +
        "list_teammate_connectors on another teammate) to a teammate. Identify the connector by its " +
        "nodeType (e.g. \"mcp_custom__12\"); for custom-MCP connectors resourceId is derived from it, " +
        "otherwise pass resourceId. Optionally scope the callable tools via actions (allowlist) or " +
        "permissions (per-tool allow/ask/deny).",
      inputSchema: {
        teammateId: z.string().optional().describe(TEAMMATE_REF_DESC + " Provide this OR teammateName."),
        teammateName: z.string().optional().describe("The target teammate's current name — resolved server-side."),
        nodeType: z.string().min(1).describe("The connector's node type, e.g. \"mcp_custom__12\" (from list_teammate_connectors)."),
        resourceId: z.number().int().positive().optional().describe("Connector resource id. Optional for mcp_custom (derived from nodeType); required for other connector types."),
        actions: z.array(z.string()).optional().describe("Callable tool allowlist. Omit to grant the connector's default tools."),
        permissions: z.array(permissionSchema).optional().describe("Per-tool tri-state (allow/ask/deny). When given, it is the source of truth for what the connector may call."),
      },
    },
    async (args) => {
      const resolved = await resolveTeammateId(deps.teammates, args);
      if (!resolved.ok) return asText({ error: resolved.error, candidates: resolved.candidates });
      return asText(await addConnector(deps.client, resolved.id, { nodeType: args.nodeType, resourceId: args.resourceId, actions: args.actions, permissions: args.permissions }));
    },
  );

  server.registerTool(
    "set_connector_permissions",
    {
      description:
        "Change the per-tool action permissions of a connector already attached to a teammate. Pass the " +
        "connector's nodeType and the full tri-state permissions list (each tool → allow/ask/deny); " +
        "\"deny\" blocks a tool, \"ask\" requires confirmation, \"allow\" grants it. This upserts the " +
        "existing attachment — it does not detach or re-add the connector.",
      inputSchema: {
        teammateId: z.string().optional().describe(TEAMMATE_REF_DESC + " Provide this OR teammateName."),
        teammateName: z.string().optional().describe("The teammate's current name — resolved server-side."),
        nodeType: z.string().min(1).describe("The attached connector's node type (from list_teammate_connectors)."),
        resourceId: z.number().int().positive().optional().describe("Connector resource id (optional for mcp_custom)."),
        permissions: z.array(permissionSchema).min(1).describe("Per-tool tri-state: each { key, permission: allow|ask|deny }."),
      },
    },
    async (args) => {
      const resolved = await resolveTeammateId(deps.teammates, args);
      if (!resolved.ok) return asText({ error: resolved.error, candidates: resolved.candidates });
      return asText(await addConnector(deps.client, resolved.id, { nodeType: args.nodeType, resourceId: args.resourceId, permissions: args.permissions }));
    },
  );
}
