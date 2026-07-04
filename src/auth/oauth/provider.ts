import type { Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenStore } from "./token-store.js";
import type { InMemoryClientStore } from "./client-store.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

/** OAuth-flow diagnostics — surfaces in server logs as `[auth] …`. Never logs full tokens/seals. */
function logAuth(step: string, info: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.error(`[auth] ${step} ${JSON.stringify(info)}`);
}
const tag = (s: string | undefined): string => (s ? s.slice(0, 8) : "<none>");

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
    logAuth("authorize", { clientId: client.client_id, redirectUri: params.redirectUri, hasChallenge: !!params.codeChallenge, loginId: tag(loginId) });
    res.redirect(`${this.opts.loginPath}?login_id=${encodeURIComponent(loginId)}`);
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = this.opts.store.peekAuthCode(authorizationCode);
    if (!code) throw new InvalidGrantError("invalid or expired authorization code");
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const code = this.opts.store.takeAuthCode(authorizationCode);
    if (!code) {
      logAuth("token.code FAIL", { reason: "code_not_found_or_expired", code: tag(authorizationCode), clientId: client.client_id });
      throw new InvalidGrantError("invalid or expired authorization code");
    }
    if (code.clientId !== client.client_id) {
      logAuth("token.code FAIL", { reason: "client_mismatch", codeClient: code.clientId, reqClient: client.client_id });
      throw new InvalidGrantError("authorization code was issued to a different client");
    }
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) {
      logAuth("token.code FAIL", { reason: "redirect_uri_mismatch", got: redirectUri, want: code.redirectUri });
      throw new InvalidGrantError("redirect_uri mismatch");
    }
    const { accessToken, refreshToken, expiresIn } = this.opts.store.issueTokens(
      { seal: code.seal, workspaceId: code.workspaceId },
      { clientId: code.clientId, scopes: code.scopes },
    );
    logAuth("token.code OK", { clientId: code.clientId, token: tag(accessToken), refresh: tag(refreshToken), expiresIn, workspaceId: code.workspaceId });
    return { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, refresh_token: refreshToken, scope: code.scopes.join(" ") };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const stored = this.opts.store.getRefresh(refreshToken);
    if (!stored || stored.clientId !== client.client_id) {
      logAuth("token.refresh FAIL", { reason: stored ? "client_mismatch" : "refresh_not_found", refresh: tag(refreshToken), reqClient: client.client_id });
      throw new InvalidGrantError("invalid refresh token");
    }
    const grantScopes = scopes ?? stored.scopes;
    const issued = this.opts.store.issueTokens(
      { seal: stored.seal, workspaceId: stored.workspaceId },
      { clientId: stored.clientId, scopes: grantScopes },
    );
    return { access_token: issued.accessToken, token_type: "Bearer", expires_in: issued.expiresIn, refresh_token: issued.refreshToken, scope: grantScopes.join(" ") };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.opts.store.getAccess(token);
    if (!stored) {
      logAuth("verify FAIL", { token: tag(token), reason: "not_found_or_expired" });
      throw new InvalidTokenError("invalid or expired access token");
    }
    logAuth("verify OK", { token: tag(token), clientId: stored.clientId, workspaceId: stored.workspaceId, expiresAt: stored.expiresAt });
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
      extra: { seal: stored.seal, workspaceId: stored.workspaceId },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // Per the SDK contract, revoking an invalid/unknown token or one owned by a different
    // client is a silent no-op (no error) — only ever revoke tokens the caller actually owns.
    const owner = this.opts.store.getAccess(request.token) ?? this.opts.store.getRefresh(request.token);
    if (owner && owner.clientId === client.client_id) {
      this.opts.store.revoke(request.token);
    }
  }

  updateAccessSeal(token: string, seal: string): void {
    this.opts.store.updateAccessSeal(token, seal);
  }
}
