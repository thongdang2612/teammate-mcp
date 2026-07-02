import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { DiaflowHttpError } from "../../src/diaflow/errors.js";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("DiaflowClient", () => {
  it("sends native headers, bearer token and workspace id; returns parsed JSON", async () => {
    const fetchImpl = vi.fn(async (_url?: string, _init?: RequestInit) => jsonResponse({ total: 0, results: [] }));
    const client = new DiaflowClient({
      baseUrl: "https://api.diaflow.io",
      getToken: async () => "SEAL",
      getWorkspaceId: () => 1564,
      fetchImpl: fetchImpl as any,
    });

    const data = await client.request<{ total: number }>("GET", "/agents", { query: { page: 1, pageSize: 5 } });

    expect(data.total).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.diaflow.io/api/v1/agents?page=1&pageSize=5");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("x-client")).toBe("native");
    expect(headers.get("authorization")).toBe("Bearer SEAL");
    expect(headers.get("workspace-id")).toBe("1564");
    expect(headers.has("origin")).toBe(false);
  });

  it("captures a rotated seal from X-Diaflow-Session", async () => {
    const onRotate = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true }, { headers: { "content-type": "application/json", "x-diaflow-session": "NEWSEAL" } }),
    );
    const client = new DiaflowClient({
      baseUrl: "https://x",
      getToken: async () => "OLD",
      getWorkspaceId: () => null,
      onRotate,
      fetchImpl: fetchImpl as any,
    });
    await client.request("GET", "/agents");
    expect(onRotate).toHaveBeenCalledWith("NEWSEAL");
  });

  it("throws DiaflowHttpError with code+message on 4xx", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: "permanent_delete_conflict", message: "must offboard first" }, { status: 409 }),
    );
    const client = new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: fetchImpl as any });
    await expect(client.request("DELETE", "/agents/abc/permanent")).rejects.toMatchObject({
      status: 409,
      code: "permanent_delete_conflict",
    } satisfies Partial<DiaflowHttpError>);
  });
});
