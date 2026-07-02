import { describe, it, expect, vi } from "vitest";
import { sendMagicCode, verifyMagicCode, selectWorkspace } from "../../src/auth/magic-auth.js";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("magic-auth", () => {
  it("sendMagicCode posts native headers with no Origin", async () => {
    const fetchImpl = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ sent: true }));
    await sendMagicCode("https://x", "a@b.com", fetchImpl as any);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://x/api/v1/auth/magic-auth/send");
    const h = new Headers((init as RequestInit).headers);
    expect(h.get("x-client")).toBe("native");
    expect(h.has("origin")).toBe(false);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ email: "a@b.com" });
  });

  it("verifyMagicCode returns the seal from the `session` field", async () => {
    const fetchImpl = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ session: "gAAAA_SEAL", accessToken: null, workspaceId: 1564, subdomain: "diaflow427" }));
    const r = await verifyMagicCode("https://x", "a@b.com", "123456", fetchImpl as any);
    expect(r).toEqual({ session: "gAAAA_SEAL", workspaceId: 1564, subdomain: "diaflow427" });
  });

  it("selectWorkspace sends the seal as bearer and returns the new seal", async () => {
    const fetchImpl = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ session: "gAAAA_SEAL2", workspaceId: 999 }));
    const r = await selectWorkspace("https://x", "OLD", 999, fetchImpl as any);
    const [, init] = fetchImpl.mock.calls[0];
    const h = new Headers((init as RequestInit).headers);
    expect(h.get("authorization")).toBe("Bearer OLD");
    expect(r).toEqual({ session: "gAAAA_SEAL2", workspaceId: 999 });
  });

  it("verifyMagicCode throws a DiaflowHttpError with the server's message on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: "invalid_code", message: "code expired" }), { status: 400, headers: { "content-type": "application/json" } }));
    await expect(verifyMagicCode("https://x", "a@b.com", "000000", fetchImpl as any)).rejects.toMatchObject({ status: 400, code: "invalid_code", message: "code expired" });
  });

  it("verifyMagicCode throws when the response has no session seal", async () => {
    const fetchImpl = vi.fn(async () => ok({ workspaceId: null }));
    await expect(verifyMagicCode("https://x", "a@b.com", "123456", fetchImpl as any)).rejects.toThrow(/session seal/);
  });

  it("selectWorkspace prefers a rotated session header over the body's session field", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ session: "BODY_SEAL", workspaceId: 999 }), {
          status: 200,
          headers: { "content-type": "application/json", "x-diaflow-session": "ROTATED_SEAL" },
        }),
    );
    const r = await selectWorkspace("https://x", "OLD", 999, fetchImpl as any);
    expect(r).toEqual({ session: "ROTATED_SEAL", workspaceId: 999 });
  });

  it("nativePost falls back to a generic HTTP message on a non-JSON error body", async () => {
    const fetchImpl = vi.fn(async () => new Response("plain text error", { status: 500 }));
    await expect(sendMagicCode("https://x", "a@b.com", fetchImpl as any)).rejects.toMatchObject({ status: 500, message: "HTTP 500" });
  });
});
