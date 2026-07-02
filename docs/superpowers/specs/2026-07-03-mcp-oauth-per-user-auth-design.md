# Design: Per-User OAuth for the Diaflow Teammate MCP

- **Date:** 2026-07-03
- **Status:** Approved (design), pending implementation plan
- **Author:** Thong Dang
- **Supersedes for HTTP auth:** the static `MCP_INBOUND_TOKEN` gate (kept as an alternate mode, not removed)

## Problem

Diaflow's custom-MCP registration ("Discover" / paste-URL) only handles two kinds of
server: **public/no-auth** or **OAuth-advertising**. Our server is protected by a static
bearer token (`MCP_INBOUND_TOKEN`) and advertises no OAuth, so:

1. Diaflow's `discover` exhausts its three OAuth tiers (path-aware well-known, root
   well-known, `WWW-Authenticate` `resource_metadata` probe), then falls to an
   unauthenticated `client.connect()` which **hangs** on our bare `401` → Diaflow's
   gateway returns **504**. (Verified live: our `401` carries only
   `WWW-Authenticate: Bearer`; Linear's carries
   `resource_metadata="https://mcp.linear.app/.well-known/oauth-protected-resource/mcp"`
   and its well-known returns `{resource, authorization_servers, scopes_supported}`.)
2. Even if discovery didn't hang, the discover→`save-public` path only ever writes
   `auth_type:"none"`; there is **no bearer/API-key branch** in the paste-URL flow. So a
   static-bearer server can never be registered through that UI.

A secondary limitation motivates the same fix: today every caller of the remote server
acts as the **single** `DIAFLOW_TOKEN` service seal. There is no way for different users
to act as themselves.

## Goal

Make the MCP server **OAuth-advertising like Linear**, where the OAuth "user
authentication" step is a **Diaflow magic-code login**, and each issued access token is
bound to **that user's own Diaflow seal**. This simultaneously:

- Lets Diaflow's paste-URL "Connect" flow discover and register the server (OAuth path).
- Gives genuine **per-user identity** — every tool call runs as the logged-in user, not a
  shared service account.

## Non-Goals (v1 / YAGNI)

- No persistent token store (in-memory only; see Trade-offs).
- No workspace-picker UI — use the `workspaceId` magic-auth returns by default.
- No refresh-token rotation/reuse-detection beyond basic issue+exchange.
- No removal of the existing static mode — it stays as an alternate.
- No change to how the server talks to Diaflow's API (still forwards a seal as
  `Authorization: Bearer` + `Workspace-Id`, still captures `X-Diaflow-Session` rotation).

## Architecture

The MCP server plays **both** OAuth roles (self-hosted AS + resource server), exactly like
Linear. The MCP TypeScript SDK (`@modelcontextprotocol/sdk@^1.29`) provides the protocol
plumbing — we implement the Diaflow-specific pieces.

```
Diaflow discover ──GET /.well-known/oauth-protected-resource──▶ {resource, authorization_servers:[self], scopes_supported}
Client connect   ──401 + WWW-Authenticate: Bearer resource_metadata="…"──▶ begins OAuth
  /register (DCR) → /authorize → [login page: email → magic code → verify → user seal]
                  → redirect to client redirect_uri with code+state → /token → access_token (+refresh)
Tool call        ──Authorization: Bearer <access_token>──▶ requireBearerAuth
                  → seal+workspaceId for THAT user → DiaflowClient → https://api.diaflow.io
```

### SDK surface used
- `mcpAuthRouter({ provider, issuerUrl, ... })` — mounts `/authorize`, `/token`,
  `/register` (DCR), `/revoke`, and the `.well-known/oauth-authorization-server` +
  `.well-known/oauth-protected-resource` metadata endpoints.
- `requireBearerAuth({ verifier, resourceMetadataUrl, requiredScopes })` — Express
  middleware that validates the bearer token and, on failure, emits the
  `WWW-Authenticate: Bearer resource_metadata="…"` header our current `401` lacks.
- `OAuthServerProvider` interface — we implement it as `DiaflowOAuthProvider`.
- PKCE (S256) and redirect-uri validation are enforced by the SDK handlers.

## Components (new, small + focused)

All under `src/auth/oauth/`:

| File | Responsibility | Depends on |
|------|----------------|------------|
| `token-store.ts` | In-memory store: authorization codes + access/refresh tokens → `{ seal, workspaceId, clientId, scopes, expiresAt }`. Single-use codes, TTL expiry, revoke. | — |
| `client-store.ts` | In-memory `OAuthRegisteredClientsStore`. DCR `/register` calls `registerClient`; `/authorize`+`/token` look clients up. | SDK types |
| `login.ts` | Renders the two-step server-rendered HTML login (email → code) and handles its form POSTs; calls existing `sendMagicCode` / `verifyMagicCode`; on success completes the pending authorize by minting a code in `token-store`. | `magic-auth.ts`, `token-store.ts` |
| `provider.ts` | `DiaflowOAuthProvider implements OAuthServerProvider`: `authorize` (redirect to login), `challengeForAuthorizationCode`, `exchangeAuthorizationCode` (issue token + persist seal), `exchangeRefreshToken`, `verifyAccessToken` (return seal in `AuthInfo.extra`), `revokeToken`, `clientsStore`. | `token-store.ts`, `client-store.ts`, `login.ts` |
| `router.ts` | Builds and mounts `mcpAuthRouter` + the login routes on the Express app. | all of the above |

### Login flow detail
1. SDK `/authorize` GET validates `client_id` / `redirect_uri` / PKCE, then calls
   `provider.authorize(client, params, res)`.
2. `authorize` stores the pending request (client, redirect_uri, state, `code_challenge`)
   under a short-lived `loginId` and **redirects to our `/login?req=<loginId>`**.
3. `/login` renders step 1 (email). POST → `sendMagicCode(email)` → render step 2 (code).
4. Step 2 POST → `verifyMagicCode(email, code)` → `{ seal, workspaceId }`. We generate a
   single-use **authorization code** bound to `{ seal, workspaceId, code_challenge,
   redirect_uri, clientId }` and **redirect to the client's `redirect_uri?code=…&state=…`**.
5. SDK `/token` POST verifies PKCE + code, calls `provider.exchangeAuthorizationCode`,
   which issues an access token (+ refresh) and stores `token → { seal, workspaceId }`.

## Wiring changes (existing files)

- **`src/config.ts`** — add `MCP_AUTH_MODE: "oauth" | "static"` (default `"static"` for
  backward compatibility). In `oauth` mode, `MCP_PUBLIC_URL` (https, e.g.
  `https://teammate-mcp.onrender.com/mcp`) is **required**; `DIAFLOW_TOKEN` /
  `MCP_INBOUND_TOKEN` are not used. Keep existing vars for `static` mode.
  - **Issuer vs. resource** (mirrors Linear): the OAuth **issuer / `authorization_servers`**
    entry is the **origin** of `MCP_PUBLIC_URL` (`https://teammate-mcp.onrender.com`),
    while the protected-resource **`resource`** is the full `MCP_PUBLIC_URL`
    (`…/mcp`). Derive both from `MCP_PUBLIC_URL`.
- **`src/index.ts` (`startHttpServer`)** — branch on mode:
  - `static`: unchanged (current `isInboundAuthorized` gate).
  - `oauth`: mount `mcpAuthRouter` + login routes; replace the inbound-token middleware on
    `/mcp` with `requireBearerAuth`. On session init, read validated
    `req.auth.extra.{seal, workspaceId}` and build the per-session `ToolContext` from it.
- **`src/tools/context.ts` (`buildContext`)** — accept an optional
  `{ seal, workspaceId, tokenStore, token }` to construct a **token-backed provider**
  instead of `StaticTokenProvider`/`WorkOSSessionProvider`. `getToken()` reads the seal
  from the token store by token; `onRotate(seal)` writes the rotated seal back to the
  store (so refresh and other sessions of the same token observe the rotation).
- **`src/tools/register.ts`** — in `oauth` mode, skip the in-MCP `auth` and `workspace`
  tool groups (login/workspace-switch now happen in the OAuth flow), same way they're
  skipped today under `StaticTokenProvider`.

The per-session `McpServer` isolation model is unchanged; only the seal's *source* moves
from config to the validated bearer token. Because a client sends the same access token on
every request of a session, the seal is stable per session.

## Data model (in-memory)

```
TokenStore
  authCodes:     Map<code,  { seal, workspaceId, clientId, redirectUri, codeChallenge, expiresAt }>
  accessTokens:  Map<token, { seal, workspaceId, clientId, scopes, expiresAt }>
  refreshTokens: Map<token, { seal, workspaceId, clientId, scopes }>
  pendingLogins: Map<loginId, { clientId, redirectUri, state, codeChallenge, expiresAt }>
ClientStore
  clients:       Map<clientId, OAuthClientInformationFull>
```

- Authorization codes: single-use, ~60s TTL.
- Access tokens: ~1h TTL. Refresh tokens: long-lived (in-memory, so lost on restart).
- All maps are process-local. A restart/redeploy/cold-stop wipes them → users re-run the
  quick magic-code login.

## Error handling

- Magic-auth failures (bad code, expired code, Diaflow down) render an error on the login
  page with a retry, and never mint a code.
- Invalid/expired/used authorization codes and unknown/expired access tokens follow the
  SDK's standard OAuth error responses.
- `requireBearerAuth` emits `401 + WWW-Authenticate: Bearer resource_metadata="…"` on
  missing/invalid tokens (the behavior that makes Diaflow's discovery succeed).
- Seal rotation captured from `X-Diaflow-Session` updates the token store entry; a stale
  seal that Diaflow rejects surfaces as the existing `DiaflowHttpError` to the tool caller.

## Security considerations

- Seals live only in RAM; nothing sensitive is written to disk.
- Authorization codes are single-use with a short TTL; PKCE (S256) is enforced by the SDK.
- Redirect URIs are validated against the registered client (SDK), preventing open-redirect
  / code interception.
- The login page collects a Diaflow magic code on the MCP's own host
  (`teammate-mcp.onrender.com`), not a diaflow.io domain. Acceptable for an internal tool;
  documented as a known property. The code is forwarded server-side over HTTPS to Diaflow.
- `static` mode's guarantees are unchanged.

## Testing

Unit tests (Vitest, mocked `fetch` / magic-auth, no live backend), matching existing style
and the ~80%+ coverage bar:

- `token-store`: issue/lookup/expiry/single-use/revoke for codes and tokens.
- `client-store`: DCR register + lookup.
- `provider`: `authorize` (produces login redirect), `exchangeAuthorizationCode`
  (issues token, persists seal), `verifyAccessToken` (returns seal in `extra`),
  `exchangeRefreshToken`, `revokeToken`.
- `login`: send→verify happy path mints a code; bad code renders error, mints nothing.
- metadata: `.well-known/oauth-protected-resource` returns correct `resource` +
  `authorization_servers`; `401` from a protected call carries `resource_metadata`.
- config: `oauth` mode requires `MCP_PUBLIC_URL`; `static` mode still validates as before.

## Trade-offs

- **In-memory store**: zero infra, no seal at rest, but restarts force re-login. Chosen for
  v1 on free-tier Render; a persistent/encrypted store can be added later behind the same
  `TokenStore` interface without touching the provider.
- **Self-hosted AS** (vs. proxying WorkOS/Auth0): no external dependency and the token maps
  directly to a Diaflow seal; cost is that we own the login page and token lifecycle.
- **Effort**: largest change in the repo to date (~6 new files + wiring in 4 existing
  files). Justified by the Linear-grade registration UX plus per-user identity.

## Rollout

- Deploy in `oauth` mode: set `MCP_AUTH_MODE=oauth`, `MCP_PUBLIC_URL=https://teammate-mcp.onrender.com/mcp`.
- Diaflow "Connect" (paste URL) now discovers OAuth and walks the login.
- `static` mode remains available for non-interactive/service or stdio deployments.
```
