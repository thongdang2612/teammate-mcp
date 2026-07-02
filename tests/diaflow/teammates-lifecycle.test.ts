import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { TeammatesApi } from "../../src/diaflow/teammates.js";

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("TeammatesApi lifecycle", () => {
  it("publish posts to /publish", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ uniqueId: "u1", status: "published" }));
    await new TeammatesApi(client(f)).publish("u1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/u1/publish");
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("rehire posts to /rehire", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ uniqueId: "u1", status: "active" }));
    await new TeammatesApi(client(f)).rehire("u1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/u1/rehire");
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("offboard posts to /offboard", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ uniqueId: "u1", status: "offboarded" }));
    await new TeammatesApi(client(f)).offboard("u1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/u1/offboard");
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("permanentDelete deletes /permanent and tolerates 204", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    await new TeammatesApi(client(f)).permanentDelete("u1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/u1/permanent");
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });
});
