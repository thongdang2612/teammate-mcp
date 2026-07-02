import { describe, it, expect, vi } from "vitest";
import { isBlockedAddress, assertSafeFetchUrl } from "../../src/diaflow/url-guard.js";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { uploadRemoteImage } from "../../src/diaflow/upload.js";

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local, and unspecified IPv4 addresses", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("10.1.2.3")).toBe(true);
    expect(isBlockedAddress("172.16.0.5")).toBe(true);
    expect(isBlockedAddress("192.168.1.1")).toBe(true);
    expect(isBlockedAddress("169.254.169.254")).toBe(true);
    expect(isBlockedAddress("0.0.0.0")).toBe(true);
  });

  it("blocks loopback, ULA, and link-local IPv6 addresses", () => {
    expect(isBlockedAddress("::1")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("fc00::1")).toBe(true);
    expect(isBlockedAddress("::")).toBe(true);
  });

  it("allows a public IPv4 address", () => {
    expect(isBlockedAddress("93.184.216.34")).toBe(false);
  });

  it("blocks IPv4-mapped IPv6 addresses that embed a blocked IPv4 address (dotted form)", () => {
    expect(isBlockedAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("blocks IPv4-mapped IPv6 addresses that embed a blocked IPv4 address (hex-grouped form)", () => {
    expect(isBlockedAddress("::ffff:a9fe:a9fe")).toBe(true);
  });

  it("blocks legacy IPv4-compatible IPv6 addresses that embed a blocked IPv4 address", () => {
    expect(isBlockedAddress("::10.0.0.1")).toBe(true);
    expect(isBlockedAddress("::192.168.1.1")).toBe(true);
  });

  it("allows an IPv4-mapped IPv6 address that embeds a public IPv4 address", () => {
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("allows a genuine public IPv6 address", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });
});

describe("assertSafeFetchUrl", () => {
  it("rejects a link-local metadata IP literal", async () => {
    await expect(assertSafeFetchUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/unsafe|blocked/i);
  });

  it("rejects the localhost hostname", async () => {
    await expect(assertSafeFetchUrl("http://localhost/")).rejects.toThrow(/unsafe|blocked/i);
  });

  it("rejects a non-http(s) scheme", async () => {
    await expect(assertSafeFetchUrl("file:///etc/passwd")).rejects.toThrow(/unsafe|blocked/i);
  });

  it("rejects a hostname whose DNS lookup resolves to a private address", async () => {
    const lookup = vi.fn(async () => [{ address: "10.0.0.5" }]);
    await expect(assertSafeFetchUrl("http://internal.example.com/x", { lookup })).rejects.toThrow(/unsafe|blocked/i);
  });

  it("resolves without throwing for a hostname whose DNS lookup returns a public address", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34" }]);
    await expect(assertSafeFetchUrl("http://example.com/x", { lookup })).resolves.toBeUndefined();
  });

  it("rejects an IPv4-mapped IPv6 literal for the AWS/GCP metadata address", async () => {
    await expect(assertSafeFetchUrl("http://[::ffff:169.254.169.254]/latest/meta-data/")).rejects.toThrow(
      /unsafe|blocked/i,
    );
  });

  it("rejects a trailing-dot hostname via string normalization, before any DNS lookup", async () => {
    const lookup = vi.fn(async () => [{ address: "93.184.216.34" }]);
    await expect(assertSafeFetchUrl("http://localhost./", { lookup })).rejects.toThrow(/unsafe|blocked/i);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("uploadRemoteImage SSRF guard", () => {
  it("rejects an internal imageUrl before any fetch (presign/PUT) happens", async () => {
    const f = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const client = new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f as any });
    await expect(
      uploadRemoteImage(client, { teammateId: "u1", imageUrl: "http://169.254.169.254/latest/meta-data", date: new Date(), fetchImpl: f as any }),
    ).rejects.toThrow(/unsafe|blocked/i);
    expect(f).not.toHaveBeenCalled();
  });
});
