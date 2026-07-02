import type { RequestHandler, Router } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AppConfig } from "../../config.js";
import { OAuthTokenStore } from "./token-store.js";
import { InMemoryClientStore } from "./client-store.js";
import { DiaflowOAuthProvider } from "./provider.js";
import { buildLoginRouter } from "./login.js";

export const OAUTH_SCOPES = ["teammate"];

export interface OAuthWiring {
  provider: DiaflowOAuthProvider;
  authRouter: RequestHandler;
  loginRouter: Router;
  bearer: RequestHandler;
  resourceMetadataUrl: string;
}

export function buildOAuthWiring(cfg: AppConfig): OAuthWiring {
  if (!cfg.oauthIssuerUrl || !cfg.oauthResourceUrl) {
    throw new Error("buildOAuthWiring requires oauthIssuerUrl and oauthResourceUrl (MCP_AUTH_MODE=oauth)");
  }
  const store = new OAuthTokenStore();
  const clients = new InMemoryClientStore();
  const provider = new DiaflowOAuthProvider({ store, clients, loginPath: "/login", scopes: OAUTH_SCOPES });

  const issuerUrl = new URL(cfg.oauthIssuerUrl);
  const resourceServerUrl = new URL(cfg.oauthResourceUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);

  const authRouter = mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl,
    scopesSupported: OAUTH_SCOPES,
    resourceName: "Diaflow Teammate MCP",
  });

  const loginRouter = buildLoginRouter({ store, baseUrl: cfg.diaflowApiBase });
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl });

  return { provider, authRouter, loginRouter, bearer, resourceMetadataUrl };
}
