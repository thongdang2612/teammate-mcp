import type { DiaflowClient } from "./client.js";
import type { AgentDetail, TeammatePage, CreateTeammateFields, UpdateTeammateFields } from "./types.js";

export interface ListParams {
  page?: number;
  pageSize?: number;
  lifecycle?: "active" | "offboarded";
  search?: string;
  filter?: string;
  orderBy?: string;
}

export class TeammatesApi {
  constructor(private readonly client: DiaflowClient) {}

  list(params: ListParams = {}): Promise<TeammatePage> {
    return this.client.request<TeammatePage>("GET", "/agents", {
      query: {
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 20,
        lifecycle: params.lifecycle,
        search: params.search,
        filter: params.filter,
        orderBy: params.orderBy,
      },
    });
  }

  get(uniqueId: string): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("GET", `/agents/${encodeURIComponent(uniqueId)}`);
  }

  create(fields: CreateTeammateFields): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("POST", "/agents", { body: fields });
  }

  update(uniqueId: string, fields: UpdateTeammateFields): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("PATCH", `/agents/${encodeURIComponent(uniqueId)}`, { body: { main: fields } });
  }

  checkName(name: string): Promise<{ isDuplicate: boolean }> {
    return this.client.request<{ isDuplicate: boolean }>("POST", "/agents/check-name", { body: { name } });
  }

  publish(uniqueId: string): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("POST", `/agents/${encodeURIComponent(uniqueId)}/publish`);
  }

  offboard(uniqueId: string): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("POST", `/agents/${encodeURIComponent(uniqueId)}/offboard`);
  }

  rehire(uniqueId: string): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("POST", `/agents/${encodeURIComponent(uniqueId)}/rehire`);
  }

  permanentDelete(uniqueId: string): Promise<void> {
    return this.client.request<void>("DELETE", `/agents/${encodeURIComponent(uniqueId)}/permanent`);
  }
}
