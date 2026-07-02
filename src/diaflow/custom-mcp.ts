import type { DiaflowClient } from "./client.js";

export function registerCustomMcp(
  client: DiaflowClient,
  workspaceId: number,
  params: { url: string; name: string; key?: string; description?: string; tools?: { name: string }[] },
): Promise<{ resourceId: number; created: boolean }> {
  return client.request<{ resourceId: number; created: boolean }>(
    "POST",
    `/workspaces/${workspaceId}/resources/mcp/upsert`,
    {
      body: {
        url: params.url,
        name: params.name,
        description: params.description,
        resourceType: "mcp_custom",
        key: params.key,
        config: {
          transport: "streamable_http",
          authType: params.key ? "bearer" : "none",
          ...(params.tools ? { tools: params.tools } : {}),
        },
      },
    },
  );
}

export function attachMcpToAgent(
  client: DiaflowClient,
  agentUniqueId: string,
  resourceId: number,
  actions?: string[],
): Promise<unknown> {
  return client.request<unknown>("POST", `/agents/${encodeURIComponent(agentUniqueId)}/apps`, {
    body: { nodeType: `mcp_custom__${resourceId}`, resourceId, ...(actions ? { actions } : {}) },
  });
}
