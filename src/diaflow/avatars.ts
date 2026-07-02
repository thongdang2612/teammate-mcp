import type { DiaflowClient } from "./client.js";
import type { PresetAvatar } from "./types.js";

export async function listPresetAvatars(client: DiaflowClient, category?: string): Promise<PresetAvatar[]> {
  const res = await client.request<{ results: PresetAvatar[] }>("GET", "/avatars", {
    query: { category },
  });
  return res.results ?? [];
}
