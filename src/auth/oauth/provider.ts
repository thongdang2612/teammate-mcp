import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenStore } from "./token-store.js";
import type { InMemoryClientStore } from "./client-store.js";

export interface DiaflowOAuthProviderOptions {
  store: OAuthTokenStore;
  clients: InMemoryClientStore;
  loginPath: string;
  scopes: string[];
}

export class DiaflowOAuthProvider implements OAuthServerProvider {
  constructor(private readonly opts: DiaflowOAuthProviderOptions) {}

  get clientsStore(): InMemoryClientStore {
    return this.opts.clients;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const loginId = this.opts.store.createLogin({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? this.opts.scopes,
      resource: params.resource?.toString(),
    });
    res.redirect(`${this.opts.loginPath}?login_id=${encodeURIComponent(loginId)}`);
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = this.opts.store.peekAuthCode(authorizationCode);
    if (!code) throw new Error("invalid or expired authorization code");
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const code = this.opts.store.takeAuthCode(authorizationCode);
    if (!code) throw new Error("invalid or expired authorization code");
    if (code.clientId !== client.client_id) throw new Error("client mismatch");
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) throw new Error("redirect_uri mismatch");
    const { accessToken, refreshToken, expiresIn } = this.opts.store.issueTokens(
      { seal: code.seal, workspaceId: code.workspaceId },
      { clientId: code.clientId, scopes: code.scopes },
    );
    return { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, refresh_token: refreshToken, scope: code.scopes.join(" ") };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const stored = this.opts.store.getRefresh(refreshToken);
    if (!stored || stored.clientId !== client.client_id) throw new Error("invalid refresh token");
    const grantScopes = scopes ?? stored.scopes;
    const issued = this.opts.store.issueTokens(
      { seal: stored.seal, workspaceId: stored.workspaceId },
      { clientId: stored.clientId, scopes: grantScopes },
    );
    return { access_token: issued.accessToken, token_type: "Bearer", expires_in: issued.expiresIn, refresh_token: issued.refreshToken, scope: grantScopes.join(" ") };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.opts.store.getAccess(token);
    if (!stored) throw new Error("invalid or expired access token");
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
      extra: { seal: stored.seal, workspaceId: stored.workspaceId },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.opts.store.revoke(request.token);
  }

  updateAccessSeal(token: string, seal: string): void {
    this.opts.store.updateAccessSeal(token, seal);
  }
}
