import type { DiaflowClient } from "./client.js";
import type { PersonalSkill, PresignedFileInfo } from "./types.js";
import { putToPresigned } from "./upload.js";

const BASE = "/agents/skill-users";

export class SkillUserApi {
  constructor(private readonly client: DiaflowClient, private readonly fetchImpl: typeof fetch = fetch) {}

  async list(): Promise<PersonalSkill[]> {
    return this.client.request<PersonalSkill[]>("GET", BASE);
  }

  async get(uniqueId: string): Promise<PersonalSkill> {
    return this.client.request<PersonalSkill>("GET", `${BASE}/${encodeURIComponent(uniqueId)}`);
  }

  async create(input: { name: string; description?: string; files?: Record<string, string> }): Promise<PersonalSkill> {
    const body = { name: input.name, description: input.description, files: input.files ?? {} };
    return this.client.request<PersonalSkill>("POST", BASE, { body });
  }

  async update(uniqueId: string, fields: { name?: string; description?: string }): Promise<PersonalSkill> {
    return this.client.request<PersonalSkill>("PATCH", `${BASE}/${encodeURIComponent(uniqueId)}`, { body: fields });
  }

  remove(uniqueId: string): Promise<void> {
    return this.client.request<void>("DELETE", `${BASE}/${encodeURIComponent(uniqueId)}`);
  }

  getFileUrl(uniqueId: string, filePath: string): Promise<string> {
    return this.client
      .request<{ url: string }>("GET", `${BASE}/${encodeURIComponent(uniqueId)}/files/${encodeFilePath(filePath)}`)
      .then((r) => r.url);
  }

  async removeFiles(uniqueId: string, paths: string[]): Promise<PersonalSkill> {
    return this.client.request<PersonalSkill>("DELETE", `${BASE}/${encodeURIComponent(uniqueId)}/files`, { body: { paths } });
  }

  async writeFile(uniqueId: string, path: string, content: string): Promise<void> {
    const skill = await this.get(uniqueId);
    const bytes = new TextEncoder().encode(content);
    const id = encodeURIComponent(uniqueId);
    if (Object.hasOwn(skill.files, path)) {
      const { upload_url, s3_key } = await this.client.request<{ upload_url: string; s3_key: string }>(
        "POST", `${BASE}/${id}/files/presigned-edit`, { body: { file_path: path } },
      );
      await putToPresigned(upload_url, bytes, "application/octet-stream", this.fetchImpl);
      await this.client.request<{ s3_key: string; file_path: string }>(
        "POST", `${BASE}/${id}/files/confirm-edit`, { body: { file_path: path, s3_key } },
      );
      return;
    }
    const presign = await this.client.request<{ files: Record<string, { upload_url: string; key: string; url: string; content_type: string }> }>(
      "POST", `${BASE}/presigned-urls`, { body: { skill_name: skill.name, files: [path] } },
    );
    const info = presign.files[path];
    if (!info) throw new Error(`presign did not return an entry for "${path}"`);
    await putToPresigned(info.upload_url, bytes, info.content_type, this.fetchImpl);
    await this.client.request<PersonalSkill>("POST", `${BASE}/${id}/files`, { body: { files: { [path]: info.key } } });
  }

  async readFile(uniqueId: string, path: string): Promise<string> {
    const url = await this.getFileUrl(uniqueId, path);
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`skill file read failed: HTTP ${res.status}`);
    return res.text();
  }
}

function encodeFilePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}
