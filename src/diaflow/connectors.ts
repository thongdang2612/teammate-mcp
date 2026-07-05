import type { DiaflowClient } from "./client.js";

/** One connector (app) attached to a teammate. Backend `AgentResourceDetail`, camelCase on the wire. */
export interface TeammateConnector {
  id: number;
  nodeType: string;
  resourceId: number | null;
  resourceName: string | null;
  resourceType: string | null;
  actions: string[];
  isActive: boolean;
}

interface RawConnector {
  id: number;
  nodeType: string;
  resourceId?: number | null;
  resourceName?: string | null;
  resourceType?: string | null;
  actions?: string[];
  isActive?: boolean;
}

function toConnector(r: RawConnector): TeammateConnector {
  return {
    id: r.id,
    nodeType: r.nodeType,
    resourceId: r.resourceId ?? null,
    resourceName: r.resourceName ?? null,
    resourceType: r.resourceType ?? null,
    actions: r.actions ?? [],
    isActive: r.isActive ?? false,
  };
}

/** List the connectors currently attached to a teammate. GET /agents/{id}/apps. */
export async function listTeammateConnectors(client: DiaflowClient, agentUniqueId: string): Promise<TeammateConnector[]> {
  const raw = await client.request<RawConnector[]>("GET", `/agents/${encodeURIComponent(agentUniqueId)}/apps`);
  return raw.map(toConnector);
}

/** Per-tool permission for a connector: `deny` blocks the tool, `ask` prompts, `allow` grants. */
export interface ConnectorToolPermission {
  key: string;
  permission: "allow" | "ask" | "deny";
}

/**
 * Attach OR update an existing connector on a teammate. POST /agents/{id}/apps is an
 * upsert, so calling it again with new `actions`/`permissions` changes what the
 * connector's tools are allowed to do without re-attaching.
 *
 * `nodeType` identifies the connector (e.g. `mcp_custom__12`); for mcp_custom the
 * backend derives resourceId from it, but we pass it through when provided.
 * When `permissions` is given it is the source of truth (the backend derives the
 * callable allowlist from it); otherwise `actions` is the allowlist.
 */
export function addConnectorToAgent(
  client: DiaflowClient,
  agentUniqueId: string,
  params: { nodeType: string; resourceId?: number; actions?: string[]; permissions?: ConnectorToolPermission[] },
): Promise<unknown> {
  return client.request<unknown>("POST", `/agents/${encodeURIComponent(agentUniqueId)}/apps`, {
    body: {
      nodeType: params.nodeType,
      ...(params.resourceId !== undefined ? { resourceId: params.resourceId } : {}),
      actions: params.actions ?? [],
      ...(params.permissions ? { permissions: params.permissions } : {}),
    },
  });
}
