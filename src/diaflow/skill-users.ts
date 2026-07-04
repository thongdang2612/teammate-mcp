import type { DiaflowClient } from "./client.js";
import type { PersonalSkill } from "./types.js";

const BASE = "/agents/skill-users";

interface RawSkill {
  id: number; unique_id: string; workspace_id: number; user_id: number;
  name: string; description: string | null; files?: Record<string, string>;
  is_active: boolean; version: number; created_at: string; updated_at: string;
}

function toPersonalSkill(raw: RawSkill): PersonalSkill {
  return {
    id: raw.id,
    uniqueId: raw.unique_id,
    workspaceId: raw.workspace_id,
    userId: raw.user_id,
    name: raw.name,
    description: raw.description,
    files: raw.files ?? {},
    isActive: raw.is_active,
    version: raw.version,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export class SkillUserApi {
  constructor(private readonly client: DiaflowClient) {}

  async list(): Promise<PersonalSkill[]> {
    const raw = await this.client.request<RawSkill[]>("GET", BASE);
    return raw.map(toPersonalSkill);
  }

  async get(uniqueId: string): Promise<PersonalSkill> {
    return toPersonalSkill(await this.client.request<RawSkill>("GET", `${BASE}/${encodeURIComponent(uniqueId)}`));
  }

  async create(input: { name: string; description?: string; files?: Record<string, string> }): Promise<PersonalSkill> {
    const body = { name: input.name, description: input.description, files: input.files ?? {} };
    return toPersonalSkill(await this.client.request<RawSkill>("POST", BASE, { body }));
  }

  async update(uniqueId: string, fields: { name?: string; description?: string }): Promise<PersonalSkill> {
    return toPersonalSkill(await this.client.request<RawSkill>("PATCH", `${BASE}/${encodeURIComponent(uniqueId)}`, { body: fields }));
  }

  remove(uniqueId: string): Promise<void> {
    return this.client.request<void>("DELETE", `${BASE}/${encodeURIComponent(uniqueId)}`);
  }
}
