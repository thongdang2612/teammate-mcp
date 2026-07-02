import type { DiaflowClient } from "./client.js";
import type { AgentDetail, TeammatePage } from "./types.js";

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
}
