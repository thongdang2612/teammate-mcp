import { describe, it, expect, vi } from "vitest";
import { MemorySessionStore } from "../../src/auth/session-store.js";
import { WorkOSSessionProvider, StaticTokenProvider } from "../../src/auth/token-provider.js";
import * as magic from "../../src/auth/magic-auth.js";

describe("MemorySessionStore", () => {
  it("deletes a stored session", async () => {
    const store = new MemorySessionStore();
    await store.set("default", { seal: "S", workspaceId: 1 });
    await store.delete("default");
    expect(await store.get("default")).toBeNull();
  });
});

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

  it("startConnect delegates to sendMagicCode", async () => {
    const spy = vi.spyOn(magic, "sendMagicCode").mockResolvedValue(undefined);
    const p = new WorkOSSessionProvider({ store: new MemorySessionStore(), key: "default", baseUrl: "https://x" });
    await p.startConnect("a@b.com");
    expect(spy).toHaveBeenCalledWith("https://x", "a@b.com", undefined);
  });

  it("setWorkspace throws when not connected", async () => {
    const p = new WorkOSSessionProvider({ store: new MemorySessionStore(), key: "default", baseUrl: "https://x" });
    await expect(p.setWorkspace(1564)).rejects.toThrow("not connected");
  });

  it("setWorkspace updates the cached seal and workspace on success", async () => {
    vi.spyOn(magic, "verifyMagicCode").mockResolvedValue({ session: "SEAL1", workspaceId: null });
    vi.spyOn(magic, "selectWorkspace").mockResolvedValue({ session: "SEAL2", workspaceId: 1564 });
    const p = new WorkOSSessionProvider({ store: new MemorySessionStore(), key: "default", baseUrl: "https://x" });
    await p.completeConnect("a@b.com", "123456");
    await p.setWorkspace(1564);
    expect(p.getWorkspaceId()).toBe(1564);
    expect(await p.getToken()).toBe("SEAL2");
  });

  it("onRotate is a no-op when there is no cached session", async () => {
    const p = new WorkOSSessionProvider({ store: new MemorySessionStore(), key: "default", baseUrl: "https://x" });
    expect(() => p.onRotate("SEAL")).not.toThrow();
    expect(await p.getToken()).toBeNull();
  });
});

describe("StaticTokenProvider", () => {
  it("returns the configured seal and workspace", async () => {
    const p = new StaticTokenProvider("SEAL", 42);
    expect(await p.getToken()).toBe("SEAL");
    expect(p.getWorkspaceId()).toBe(42);
    expect(await p.isConnected()).toBe(true);
  });

  it("onRotate replaces the seal", async () => {
    const p = new StaticTokenProvider("SEAL", 42);
    p.onRotate("SEAL-ROTATED");
    expect(await p.getToken()).toBe("SEAL-ROTATED");
  });

  it("defaults workspace to null when none is configured", () => {
    const p = new StaticTokenProvider("SEAL");
    expect(p.getWorkspaceId()).toBeNull();
  });
});
