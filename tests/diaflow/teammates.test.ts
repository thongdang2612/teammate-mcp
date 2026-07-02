import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { TeammatesApi } from "../../src/diaflow/teammates.js";

function client(fetchImpl: any) {
  return new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl });
}
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("TeammatesApi read", () => {
  it("list passes pagination + lifecycle", async () => {
    const fetchImpl = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ total: 1, results: [{ id: 1, uniqueId: "u1", name: "A" }] }));
    const api = new TeammatesApi(client(fetchImpl));
    const page = await api.list({ page: 2, pageSize: 10, lifecycle: "offboarded" });
    expect(page.total).toBe(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("/api/v1/agents?");
    expect(url).toContain("page=2");
    expect(url).toContain("pageSize=10");
    expect(url).toContain("lifecycle=offboarded");
  });

  it("get fetches by uniqueId", async () => {
    const fetchImpl = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ id: 1, uniqueId: "u1", name: "A", instruction: "hi" }));
    const api = new TeammatesApi(client(fetchImpl));
    const t = await api.get("u1");
    expect(t.uniqueId).toBe("u1");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://x/api/v1/agents/u1");
  });
});
