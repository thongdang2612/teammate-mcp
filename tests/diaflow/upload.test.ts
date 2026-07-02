import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { presignUpload, putToPresigned, uploadRemoteImage } from "../../src/diaflow/upload.js";

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("upload", () => {
  it("presignUpload posts snake_case file_size", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => ok({ uploadUrl: "https://s3/put", key: "k", url: "https://cdn/k" }));
    const r = await presignUpload(client(f), { name: "u1_a.png", type: "image/png", folder: "agent-teammate-icons/02-07-26", fileSize: 10 });
    expect(r.key).toBe("k");
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ name: "u1_a.png", type: "image/png", folder: "agent-teammate-icons/02-07-26", file_size: 10 });
  });

  it("putToPresigned PUTs bytes with Content-Type and no auth header", async () => {
    const f = vi.fn(async (_url?: string, _init?: RequestInit) => new Response(null, { status: 200 }));
    await putToPresigned("https://s3/put", new Uint8Array([1, 2, 3]), "image/png", f as any);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://s3/put");
    expect((init as RequestInit).method).toBe("PUT");
    const h = new Headers((init as RequestInit).headers);
    expect(h.get("content-type")).toBe("image/png");
    expect(h.has("authorization")).toBe(false);
  });

  it("putToPresigned throws on non-2xx", async () => {
    const f = vi.fn(async () => new Response("denied", { status: 403 }));
    await expect(putToPresigned("https://s3/put", new Uint8Array([1]), "image/png", f as any)).rejects.toThrow();
  });

  it("uploadRemoteImage downloads, presigns, PUTs, returns key", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const f = vi.fn(async (url: string) => {
      if (url === "https://remote/a.png") return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      if (url.endsWith("/drives/s3/presigned")) return ok({ uploadUrl: "https://s3/put", key: "agent-teammate-icons/02-07-26/u1_a.png", url: "https://cdn/k" });
      if (url === "https://s3/put") return new Response(null, { status: 200 });
      throw new Error("unexpected " + url);
    });
    const r = await uploadRemoteImage(client(f), { teammateId: "u1", imageUrl: "https://remote/a.png", date: new Date(Date.UTC(2026, 6, 2)), fetchImpl: f as any });
    expect(r.key).toBe("agent-teammate-icons/02-07-26/u1_a.png");
  });

  it("uploadRemoteImage rejects images over the size cap", async () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    const f = vi.fn(async () => new Response(big, { status: 200, headers: { "content-type": "image/png" } }));
    await expect(
      uploadRemoteImage(client(f), { teammateId: "u1", imageUrl: "https://remote/big.png", date: new Date(), fetchImpl: f as any }),
    ).rejects.toThrow(/size/i);
  });

  it("uploadRemoteImage fails fast on oversize Content-Length without buffering or calling presign/S3", async () => {
    const tinyBody = new Uint8Array([1, 2, 3]);
    const f = vi.fn(async (_url?: string) =>
      new Response(tinyBody, {
        status: 200,
        headers: { "content-type": "image/png", "content-length": String(11 * 1024 * 1024) },
      }),
    );
    await expect(
      uploadRemoteImage(client(f), { teammateId: "u1", imageUrl: "https://remote/huge.png", date: new Date(), fetchImpl: f as any }),
    ).rejects.toThrow(/size/i);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe("https://remote/huge.png");
  });
});
