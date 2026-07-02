import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { listPresetAvatars } from "../../src/diaflow/avatars.js";

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("avatars", () => {
  it("listPresetAvatars returns results", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ results: [{ url: "https://cdn/a.png", category: "robots" }] }));
    const client = new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f as any });
    const r = await listPresetAvatars(client);
    expect(r).toEqual([{ url: "https://cdn/a.png", category: "robots" }]);
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/avatars");
  });

  it("listPresetAvatars falls back to an empty array when results is missing", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({}));
    const client = new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f as any });
    const r = await listPresetAvatars(client, "robots");
    expect(r).toEqual([]);
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/avatars?category=robots");
  });
});
