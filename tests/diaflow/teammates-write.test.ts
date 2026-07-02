import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { TeammatesApi } from "../../src/diaflow/teammates.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("TeammatesApi write", () => {
  it("create posts the fields", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ id: 1, uniqueId: "u1", name: "A" }, 201));
    const api = new TeammatesApi(client(f));
    await api.create({ modelProvider: "openai", modelName: "gpt-4", name: "A" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ modelProvider: "openai", modelName: "gpt-4", name: "A" });
  });

  it("update wraps fields under `main`", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ id: 1, uniqueId: "u1", name: "B" }));
    const api = new TeammatesApi(client(f));
    await api.update("u1", { name: "B", icon: "agent-teammate-icons/02-07-26/u1_a.png" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/u1");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ main: { name: "B", icon: "agent-teammate-icons/02-07-26/u1_a.png" } });
  });

  it("checkName posts the name", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ isDuplicate: true }));
    const api = new TeammatesApi(client(f));
    const r = await api.checkName("A");
    expect(r.isDuplicate).toBe(true);
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/check-name");
  });
});
