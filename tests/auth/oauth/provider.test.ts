import { describe, it, expect } from "vitest";
import { DiaflowOAuthProvider } from "../../../src/auth/oauth/provider.js";
import { OAuthTokenStore } from "../../../src/auth/oauth/token-store.js";
import { InMemoryClientStore } from "../../../src/auth/oauth/client-store.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

function setup() {
  const store = new OAuthTokenStore();
  const clients = new InMemoryClientStore();
  const provider = new DiaflowOAuthProvider({ store, clients, loginPath: "/login", scopes: ["teammate"] });
  const client = clients.registerClient({ redirect_uris: ["https://cb"] }) as OAuthClientInformationFull;
  return { store, clients, provider, client };
}

describe("DiaflowOAuthProvider", () => {
  it("authorize stores a pending login and redirects to the login page", async () => {
    const { provider, client } = setup();
    let redirectedTo = "";
    const res = { redirect: (url: string) => { redirectedTo = url; } } as any;
    await provider.authorize(client, { redirectUri: "https://cb", codeChallenge: "ch", state: "xyz", scopes: ["teammate"] }, res);
    expect(redirectedTo).toMatch(/^\/login\?login_id=/);
  });

  it("exchangeAuthorizationCode issues a token whose verifyAccessToken exposes the seal", async () => {
    const { store, provider, client } = setup();
    const code = store.createAuthCode({ seal: "gAAAA", workspaceId: 1564, clientId: client.client_id, redirectUri: "https://cb", codeChallenge: "ch", scopes: ["teammate"] });
    expect(await provider.challengeForAuthorizationCode(client, code)).toBe("ch");
    const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, "https://cb");
    expect(tokens.access_token).toBeTruthy();
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.extra?.seal).toBe("gAAAA");
    expect(info.extra?.workspaceId).toBe(1564);
    expect(info.clientId).toBe(client.client_id);
  });

  it("refresh issues a new access token preserving the seal", async () => {
    const { store, provider, client } = setup();
    const code = store.createAuthCode({ seal: "s", workspaceId: null, clientId: client.client_id, redirectUri: "https://cb", codeChallenge: "ch", scopes: ["teammate"] });
    const first = await provider.exchangeAuthorizationCode(client, code, undefined, "https://cb");
    const refreshed = await provider.exchangeRefreshToken(client, first.refresh_token!);
    const info = await provider.verifyAccessToken(refreshed.access_token);
    expect(info.extra?.seal).toBe("s");
  });

  it("verifyAccessToken rejects unknown tokens; revokeToken invalidates", async () => {
    const { store, provider, client } = setup();
    await expect(provider.verifyAccessToken("bogus")).rejects.toThrow();
    const code = store.createAuthCode({ seal: "s", workspaceId: null, clientId: client.client_id, redirectUri: "https://cb", codeChallenge: "ch", scopes: [] });
    const t = await provider.exchangeAuthorizationCode(client, code, undefined, "https://cb");
    await provider.revokeToken(client, { token: t.access_token });
    await expect(provider.verifyAccessToken(t.access_token)).rejects.toThrow();
  });
});
