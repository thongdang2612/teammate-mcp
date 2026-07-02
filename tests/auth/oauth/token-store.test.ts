import { describe, it, expect } from "vitest";
import { OAuthTokenStore } from "../../../src/auth/oauth/token-store.js";

const identity = { seal: "gAAAA-seal", workspaceId: 1564 };

describe("OAuthTokenStore", () => {
  it("round-trips a pending login once (single-use)", () => {
    const s = new OAuthTokenStore();
    const id = s.createLogin({ clientId: "c1", redirectUri: "https://cb", codeChallenge: "ch", scopes: ["teammate"] });
    expect(s.takeLogin(id)?.clientId).toBe("c1");
    expect(s.takeLogin(id)).toBeUndefined();
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
});
