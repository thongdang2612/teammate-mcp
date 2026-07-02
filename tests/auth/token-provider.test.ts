import { describe, it, expect, vi } from "vitest";
import { MemorySessionStore } from "../../src/auth/session-store.js";
import { WorkOSSessionProvider, StaticTokenProvider } from "../../src/auth/token-provider.js";
import * as magic from "../../src/auth/magic-auth.js";

describe("WorkOSSessionProvider", () => {
  it("completeConnect stores the seal and exposes it via getToken", async () => {
    vi.spyOn(magic, "verifyMagicCode").mockResolvedValue({ session: "SEAL1", workspaceId: 1564 });
    const store = new MemorySessionStore();
    const p = new WorkOSSessionProvider({ store, key: "default", baseUrl: "https://x" });

    const r = await p.completeConnect("a@b.com", "123456");
    expect(r.workspaceId).toBe(1564);
    expect(await p.getToken()).toBe("SEAL1");
    expect(p.getWorkspaceId()).toBe(1564);
    expect(await p.isConnected()).toBe(true);
  });

  it("onRotate replaces the stored seal", async () => {
    vi.spyOn(magic, "verifyMagicCode").mockResolvedValue({ session: "SEAL1", workspaceId: 1 });
    const store = new MemorySessionStore();
    const p = new WorkOSSessionProvider({ store, key: "default", baseUrl: "https://x" });
    await p.completeConnect("a@b.com", "1");
    p.onRotate("SEAL2");
    expect(await p.getToken()).toBe("SEAL2");
  });

  it("getToken is null before connecting", async () => {
    const p = new WorkOSSessionProvider({ store: new MemorySessionStore(), key: "default", baseUrl: "https://x" });
    expect(await p.getToken()).toBeNull();
    expect(await p.isConnected()).toBe(false);
  });
});

describe("StaticTokenProvider", () => {
  it("returns the configured seal and workspace", async () => {
    const p = new StaticTokenProvider("SEAL", 42);
    expect(await p.getToken()).toBe("SEAL");
    expect(p.getWorkspaceId()).toBe(42);
    expect(await p.isConnected()).toBe(true);
  });
});
