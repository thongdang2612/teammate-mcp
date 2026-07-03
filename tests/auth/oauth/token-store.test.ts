import { describe, it, expect, vi } from "vitest";
import { OAuthTokenStore } from "../../../src/auth/oauth/token-store.js";

const identity = { seal: "gAAAA-seal", workspaceId: 1564 };

/** Internal map shapes, exposed only for sweepExpired assertions (TS `private` is not runtime-private). */
interface InternalStore {
  logins: Map<string, unknown>;
  codes: Map<string, unknown>;
  access: Map<string, unknown>;
  refresh: Map<string, unknown>;
}

describe("OAuthTokenStore", () => {
  it("round-trips a pending login once (single-use)", () => {
    const s = new OAuthTokenStore();
    const id = s.createLogin({ clientId: "c1", redirectUri: "https://cb", codeChallenge: "ch", scopes: ["teammate"] });
    expect(s.takeLogin(id)?.clientId).toBe("c1");
    expect(s.takeLogin(id)).toBeUndefined();
  });

  it("peekLogin returns the pending login without consuming it", () => {
    const s = new OAuthTokenStore();
    const id = s.createLogin({ clientId: "c1", redirectUri: "https://cb", codeChallenge: "ch", scopes: ["teammate"] });
    expect(s.peekLogin(id)?.clientId).toBe("c1");
    expect(s.peekLogin(id)?.clientId).toBe("c1"); // still there — not consumed
    expect(s.takeLogin(id)?.clientId).toBe("c1"); // take still works afterward
  });

  it("peekLogin returns undefined for an expired login", () => {
    vi.useFakeTimers();
    try {
      const s = new OAuthTokenStore();
      const id = s.createLogin({ clientId: "c1", redirectUri: "https://cb", codeChallenge: "ch", scopes: [] });
      vi.advanceTimersByTime(11 * 60_000); // past the 10-minute login TTL
      expect(s.peekLogin(id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("mints a single-use auth code carrying the seal", () => {
    const s = new OAuthTokenStore();
    const code = s.createAuthCode({ ...identity, clientId: "c1", redirectUri: "https://cb", codeChallenge: "ch", scopes: ["teammate"] });
    expect(s.peekAuthCode(code)?.seal).toBe("gAAAA-seal");
    expect(s.takeAuthCode(code)?.workspaceId).toBe(1564);
    expect(s.takeAuthCode(code)).toBeUndefined();
  });

  it("issues access+refresh tokens that resolve to the identity", () => {
    const s = new OAuthTokenStore();
    const { accessToken, refreshToken, expiresIn } = s.issueTokens(identity, { clientId: "c1", scopes: ["teammate"] });
    expect(expiresIn).toBeGreaterThan(0);
    expect(s.getAccess(accessToken)?.seal).toBe("gAAAA-seal");
    expect(s.getRefresh(refreshToken)?.clientId).toBe("c1");
  });

  it("updateAccessSeal replaces the stored seal without mutating the old entry", () => {
    const s = new OAuthTokenStore();
    const { accessToken } = s.issueTokens(identity, { clientId: "c1", scopes: [] });
    const before = s.getAccess(accessToken);
    s.updateAccessSeal(accessToken, "rotated-seal");
    expect(s.getAccess(accessToken)?.seal).toBe("rotated-seal");
    expect(before?.seal).toBe("gAAAA-seal"); // old snapshot unchanged
  });

  it("revoke removes access + refresh", () => {
    const s = new OAuthTokenStore();
    const { accessToken, refreshToken } = s.issueTokens(identity, { clientId: "c1", scopes: [] });
    s.revoke(accessToken);
    s.revoke(refreshToken);
    expect(s.getAccess(accessToken)).toBeUndefined();
    expect(s.getRefresh(refreshToken)).toBeUndefined();
  });

  it("getRefresh expires a refresh token once REFRESH_TOKEN_TTL_S elapses", () => {
    vi.useFakeTimers();
    try {
      const s = new OAuthTokenStore();
      const { refreshToken } = s.issueTokens(identity, { clientId: "c1", scopes: [] });
      expect(s.getRefresh(refreshToken)?.clientId).toBe("c1");
      vi.advanceTimersByTime(90 * 24 * 3600 * 1000 + 1000); // just past the 90-day TTL
      expect(s.getRefresh(refreshToken)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweepExpired removes expired logins, codes, access, and refresh entries", () => {
    vi.useFakeTimers();
    try {
      const s = new OAuthTokenStore();
      s.createLogin({ clientId: "c1", redirectUri: "https://cb", codeChallenge: "ch", scopes: [] });
      s.createAuthCode({ ...identity, clientId: "c1", redirectUri: "https://cb", codeChallenge: "ch", scopes: [] });
      s.issueTokens(identity, { clientId: "c1", scopes: [] });
      const internal = s as unknown as InternalStore;

      expect(internal.logins.size).toBe(1);
      expect(internal.codes.size).toBe(1);
      expect(internal.access.size).toBe(1);
      expect(internal.refresh.size).toBe(1);

      // Nothing expired yet — sweep is a no-op.
      s.sweepExpired();
      expect(internal.logins.size).toBe(1);
      expect(internal.codes.size).toBe(1);
      expect(internal.access.size).toBe(1);
      expect(internal.refresh.size).toBe(1);

      // Past every TTL (refresh's 90-day TTL is the longest-lived).
      vi.advanceTimersByTime(91 * 24 * 3600 * 1000);
      s.sweepExpired();

      expect(internal.logins.size).toBe(0);
      expect(internal.codes.size).toBe(0);
      expect(internal.access.size).toBe(0);
      expect(internal.refresh.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
