# Per-User OAuth for the Diaflow Teammate MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the HTTP MCP server an OAuth-advertising authorization + resource server whose login step is a Diaflow magic-code flow, so Diaflow's paste-URL "Connect" discovers it and each issued token acts as that user's own Diaflow seal.

**Architecture:** The MCP server hosts its own OAuth AS via the SDK's `mcpAuthRouter` and protects `/mcp` with `requireBearerAuth`. A `DiaflowOAuthProvider` implements the SDK `OAuthServerProvider` interface; the `/authorize` step redirects to a server-rendered magic-code login that verifies against Diaflow and mints an authorization code bound to the user's seal. Tokens → seals are held in-memory. A new `MCP_AUTH_MODE=oauth|static` flag selects this behavior; `static` preserves today's `MCP_INBOUND_TOKEN` gate.

**Tech Stack:** TypeScript (ESM/NodeNext, Node ≥20), Express 5, `@modelcontextprotocol/sdk@^1.29`, Zod v4, Vitest.

## Global Constraints

- Node ≥ 20; ESM only (`"type":"module"`), NodeNext imports use explicit `.js` extensions.
- No mutation of existing objects — return new copies (repo/style rule). Map-based stores may replace entries with new objects rather than mutating them in place.
- No `console.log` in production code; the repo logs to `console.error` for startup diagnostics only.
- Tests run under `npm test` (`vitest run`) and are included in `tsc` via tsconfig `include:["src","tests"]`. Under strict TS, `vi.fn` mocks inspected via `.mock.calls` need typed params — write fetch mocks as `vi.fn(async (_url?: string, _init?: RequestInit) => …)`.
- Diaflow API base is validated by `z.url()`; the server forwards a seal as `Authorization: Bearer <seal>` + `Workspace-Id`, and captures rotation from the `X-Diaflow-Session` response header (existing `DiaflowClient`).
- SDK OAuth types are imported from: `@modelcontextprotocol/sdk/server/auth/router.js`, `.../server/auth/provider.js`, `.../server/auth/clients.js`, `.../server/auth/types.js`, `.../server/auth/middleware/bearerAuth.js`, and `@modelcontextprotocol/sdk/shared/auth.js`.
- `OAuthServerProvider` interface (verbatim shape the provider must satisfy): `get clientsStore()`, `authorize(client, params, res): Promise<void>`, `challengeForAuthorizationCode(client, code): Promise<string>`, `exchangeAuthorizationCode(client, code, codeVerifier?, redirectUri?, resource?): Promise<OAuthTokens>`, `exchangeRefreshToken(client, refreshToken, scopes?, resource?): Promise<OAuthTokens>`, `verifyAccessToken(token): Promise<AuthInfo>`, `revokeToken?(client, request): Promise<void>`.
- `AuthInfo` shape: `{ token: string; clientId: string; scopes: string[]; expiresAt?: number; resource?: URL; extra?: Record<string, unknown> }` — the user's seal + workspaceId travel in `extra`.
- `AuthorizationParams` shape: `{ state?: string; scopes?: string[]; codeChallenge: string; redirectUri: string; resource?: URL }`.

---

## File Structure

**New (all under `src/auth/oauth/`):**
- `token-store.ts` — in-memory pending-logins / auth-codes / access+refresh tokens keyed to `{seal, workspaceId}`.
- `client-store.ts` — in-memory `OAuthRegisteredClientsStore` (DCR).
- `provider.ts` — `DiaflowOAuthProvider implements OAuthServerProvider` (+ acts as the `OAuthTokenVerifier`).
- `login.ts` — server-rendered magic-code login Express router.
- `wiring.ts` — assembles provider + stores + login + `mcpAuthRouter` + `requireBearerAuth`.

**Modified:**
- `src/config.ts` — add `MCP_AUTH_MODE`, derive issuer/resource URLs, require `MCP_PUBLIC_URL` in oauth mode.
- `src/auth/token-provider.ts` — add `SealTokenProvider`.
- `src/tools/context.ts` — `buildContext` accepts an optional seal identity.
- `src/tools/register.ts` — register `auth`/`workspace` tools only for the interactive provider.
- `src/index.ts` — extract `buildHttpApp(cfg)`; branch oauth vs static; scope `express.json()` to `/mcp`.

**Test files mirror source under `tests/auth/oauth/…` and `tests/…`.**

---

## Task 1: Config — `MCP_AUTH_MODE` + issuer/resource derivation

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (add cases; create if absent)

**Interfaces:**
- Consumes: existing `AppConfig`, `loadConfig`.
- Produces: `AppConfig.authMode: "oauth" | "static"`; `AppConfig.oauthIssuerUrl?: string` (origin of `MCP_PUBLIC_URL`); `AppConfig.oauthResourceUrl?: string` (full `MCP_PUBLIC_URL`). In `oauth` mode `MCP_PUBLIC_URL` is required and must be `https://`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/config.test.ts (add to existing file)
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  DIAFLOW_API_BASE: "https://api.diaflow.io",
  MCP_TRANSPORT: "http",
};

describe("MCP_AUTH_MODE", () => {
  it("defaults to static", () => {
    const cfg = loadConfig({ ...base, DIAFLOW_TOKEN: "seal" });
    expect(cfg.authMode).toBe("static");
  });

  it("oauth mode requires an https MCP_PUBLIC_URL and derives issuer + resource", () => {
    const cfg = loadConfig({
      ...base,
      MCP_AUTH_MODE: "oauth",
      MCP_PUBLIC_URL: "https://teammate-mcp.onrender.com/mcp",
    });
    expect(cfg.authMode).toBe("oauth");
    expect(cfg.oauthIssuerUrl).toBe("https://teammate-mcp.onrender.com");
    expect(cfg.oauthResourceUrl).toBe("https://teammate-mcp.onrender.com/mcp");
  });

  it("oauth mode without MCP_PUBLIC_URL throws", () => {
    expect(() => loadConfig({ ...base, MCP_AUTH_MODE: "oauth" })).toThrow();
  });
});
```

> Note: if `loadConfig` currently reads only `process.env`, first refactor it to accept an optional `env: Record<string,string|undefined> = process.env` argument (a one-line signature change) so tests can inject env. Keep the default so existing callers are unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL (`authMode` undefined / no throw).

- [ ] **Step 3: Implement**

In `src/config.ts`, add to the Zod schema (alongside existing fields):

```ts
MCP_AUTH_MODE: z.preprocess(emptyToUndefined, z.enum(["oauth", "static"]).optional()),
```

In the shape returned by `loadConfig` (the object with `diaflowApiBase`, `httpPort`, etc.), add:

```ts
const authMode = parsed.MCP_AUTH_MODE ?? "static";

if (authMode === "oauth") {
  if (!parsed.MCP_PUBLIC_URL || !parsed.MCP_PUBLIC_URL.startsWith("https://")) {
    throw new Error("MCP_AUTH_MODE=oauth requires MCP_PUBLIC_URL to be an https:// URL (e.g. https://host/mcp)");
  }
}

const oauthResourceUrl = authMode === "oauth" ? parsed.MCP_PUBLIC_URL!.replace(/\/+$/, "") : undefined;
const oauthIssuerUrl = oauthResourceUrl ? new URL(oauthResourceUrl).origin : undefined;
```

Add to the returned object: `authMode, oauthIssuerUrl, oauthResourceUrl`. Add the three fields to the `AppConfig` interface:

```ts
authMode: "oauth" | "static";
oauthIssuerUrl?: string;
oauthResourceUrl?: string;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(config): add MCP_AUTH_MODE with oauth issuer/resource derivation"
```

---

## Task 2: In-memory token store

**Files:**
- Create: `src/auth/oauth/token-store.ts`
- Test: `tests/auth/oauth/token-store.test.ts`

**Interfaces:**
- Produces:
  - `interface SealIdentity { seal: string; workspaceId: number | null }`
  - `interface PendingLogin { clientId, redirectUri, state?, codeChallenge, scopes: string[], resource?: string, expiresAt: number }`
  - `interface StoredAuthCode extends SealIdentity { clientId, redirectUri, codeChallenge, scopes: string[], expiresAt: number }`
  - `interface StoredToken extends SealIdentity { clientId, scopes: string[], expiresAt?: number }`
  - `class OAuthTokenStore` with: `createLogin(p): string`, `takeLogin(id): PendingLogin | undefined`, `createAuthCode(d): string`, `peekAuthCode(code): StoredAuthCode | undefined`, `takeAuthCode(code): StoredAuthCode | undefined`, `issueTokens(identity, meta): { accessToken, refreshToken, expiresIn }`, `getAccess(token): StoredToken | undefined`, `getRefresh(token): StoredToken | undefined`, `updateAccessSeal(token, seal): void`, `revoke(token): void`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/auth/oauth/token-store.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/auth/oauth/token-store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/auth/oauth/token-store.ts
import { randomUUID, randomBytes } from "node:crypto";

export interface SealIdentity {
  seal: string;
  workspaceId: number | null;
}
export interface PendingLogin {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}
export interface StoredAuthCode extends SealIdentity {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: number;
}
export interface StoredToken extends SealIdentity {
  clientId: string;
  scopes: string[];
  expiresAt?: number; // seconds since epoch (access tokens only)
}

const LOGIN_TTL_MS = 10 * 60_000;
const AUTH_CODE_TTL_MS = 60_000;
const ACCESS_TOKEN_TTL_S = 3600;

const newSecret = (): string => randomBytes(32).toString("base64url");
const nowMs = (): number => Date.now();
const nowS = (): number => Math.floor(Date.now() / 1000);

export class OAuthTokenStore {
  private readonly logins = new Map<string, PendingLogin>();
  private readonly codes = new Map<string, StoredAuthCode>();
  private readonly access = new Map<string, StoredToken>();
  private readonly refresh = new Map<string, StoredToken>();

  createLogin(p: Omit<PendingLogin, "expiresAt">): string {
    const id = randomUUID();
    this.logins.set(id, { ...p, expiresAt: nowMs() + LOGIN_TTL_MS });
    return id;
  }
  takeLogin(id: string): PendingLogin | undefined {
    const l = this.logins.get(id);
    this.logins.delete(id);
    return l && l.expiresAt >= nowMs() ? l : undefined;
  }

  createAuthCode(d: Omit<StoredAuthCode, "expiresAt">): string {
    const code = newSecret();
    this.codes.set(code, { ...d, expiresAt: nowMs() + AUTH_CODE_TTL_MS });
    return code;
  }
  peekAuthCode(code: string): StoredAuthCode | undefined {
    const c = this.codes.get(code);
    return c && c.expiresAt >= nowMs() ? c : undefined;
  }
  takeAuthCode(code: string): StoredAuthCode | undefined {
    const c = this.peekAuthCode(code);
    this.codes.delete(code);
    return c;
  }

  issueTokens(identity: SealIdentity, meta: { clientId: string; scopes: string[] }): {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  } {
    const accessToken = newSecret();
    const refreshToken = newSecret();
    this.access.set(accessToken, { ...identity, clientId: meta.clientId, scopes: meta.scopes, expiresAt: nowS() + ACCESS_TOKEN_TTL_S });
    this.refresh.set(refreshToken, { ...identity, clientId: meta.clientId, scopes: meta.scopes });
    return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_S };
  }
  getAccess(token: string): StoredToken | undefined {
    const t = this.access.get(token);
    if (!t) return undefined;
    if (t.expiresAt != null && t.expiresAt < nowS()) {
      this.access.delete(token);
      return undefined;
    }
    return t;
  }
  getRefresh(token: string): StoredToken | undefined {
    return this.refresh.get(token);
  }
  updateAccessSeal(token: string, seal: string): void {
    const t = this.access.get(token);
    if (t) this.access.set(token, { ...t, seal }); // replace, do not mutate
  }
  revoke(token: string): void {
    this.access.delete(token);
    this.refresh.delete(token);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/auth/oauth/token-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth/token-store.ts tests/auth/oauth/token-store.test.ts
git commit -m "feat(oauth): in-memory token store keyed to Diaflow seals"
```

---

## Task 3: In-memory OAuth client store (DCR)

**Files:**
- Create: `src/auth/oauth/client-store.ts`
- Test: `tests/auth/oauth/client-store.test.ts`

**Interfaces:**
- Consumes: `OAuthRegisteredClientsStore` (SDK), `OAuthClientInformationFull` (SDK).
- Produces: `class InMemoryClientStore implements OAuthRegisteredClientsStore` with `getClient(id)` and `registerClient(client)` (generates `client_id` + `client_id_issued_at`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/auth/oauth/client-store.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryClientStore } from "../../../src/auth/oauth/client-store.js";

describe("InMemoryClientStore", () => {
  it("registers a client with a generated id and reads it back", () => {
    const store = new InMemoryClientStore();
    const reg = store.registerClient({ redirect_uris: ["https://cb"] });
    expect(reg.client_id).toBeTruthy();
    expect(reg.client_id_issued_at).toBeGreaterThan(0);
    expect(store.getClient(reg.client_id)?.redirect_uris).toEqual(["https://cb"]);
  });

  it("returns undefined for an unknown client", () => {
    expect(new InMemoryClientStore().getClient("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- tests/auth/oauth/client-store.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/auth/oauth/client-store.ts
import { randomUUID } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export class InMemoryClientStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>();

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.clients.set(full.client_id, full);
    return full;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/auth/oauth/client-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth/client-store.ts tests/auth/oauth/client-store.test.ts
git commit -m "feat(oauth): in-memory DCR client store"
```

---

## Task 4: `DiaflowOAuthProvider`

**Files:**
- Create: `src/auth/oauth/provider.ts`
- Test: `tests/auth/oauth/provider.test.ts`

**Interfaces:**
- Consumes: `OAuthTokenStore`, `InMemoryClientStore` (Tasks 2–3); SDK `OAuthServerProvider`, `AuthorizationParams`, `OAuthClientInformationFull`, `OAuthTokens`, `OAuthTokenRevocationRequest`, `AuthInfo`.
- Produces: `class DiaflowOAuthProvider implements OAuthServerProvider` constructed with `{ store, clients, loginPath, scopes }`; also usable as the `OAuthTokenVerifier` (has `verifyAccessToken`). Extra method `updateAccessSeal(token, seal): void` for rotation writeback.

- [ ] **Step 1: Write the failing test**

```ts
// tests/auth/oauth/provider.test.ts
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
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- tests/auth/oauth/provider.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/auth/oauth/provider.ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/auth/oauth/provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth/provider.ts tests/auth/oauth/provider.test.ts
git commit -m "feat(oauth): DiaflowOAuthProvider (authorize/exchange/verify/refresh/revoke)"
```

---

## Task 5: Magic-code login router

**Files:**
- Create: `src/auth/oauth/login.ts`
- Test: `tests/auth/oauth/login.test.ts`

**Interfaces:**
- Consumes: `OAuthTokenStore`; `sendMagicCode`, `verifyMagicCode` from `../magic-auth.js` (existing; `verifyMagicCode(base, email, code, fetchImpl?) → { session: string; workspaceId: number | null }`).
- Produces: `buildLoginRouter(opts: { store, baseUrl, path?, fetchImpl? }): express.Router`. Handles `GET {path}` (email form), `POST {path}` (no `code` field → `sendMagicCode` + render code form; with `code` → `verifyMagicCode` → mint auth code → redirect to client `redirect_uri`).

- [ ] **Step 1: Write the failing test**

```ts
// tests/auth/oauth/login.test.ts
import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { buildLoginRouter } from "../../../src/auth/oauth/login.js";
import { OAuthTokenStore } from "../../../src/auth/oauth/token-store.js";

function startApp(store: OAuthTokenStore, fetchImpl: typeof fetch) {
  const app = express();
  app.use(buildLoginRouter({ store, baseUrl: "https://api.diaflow.io", fetchImpl }));
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => srv.close() });
    });
  });
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("login router", () => {
  it("POST without code sends the magic code and renders the code form", async () => {
    const store = new OAuthTokenStore();
    const fetchImpl = vi.fn(async (_url?: string | URL | Request, _init?: RequestInit) => okJson({ status: "ok" })) as unknown as typeof fetch;
    const { url, close } = await startApp(store, fetchImpl);
    const id = store.createLogin({ clientId: "c1", redirectUri: "https://cb", codeChallenge: "ch", scopes: ["teammate"] });
    const res = await fetch(`${url}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login_id: id, email: "u@x.io" }),
    });
    const html = await res.text();
    expect((fetchImpl as any).mock.calls[0][0]).toContain("/auth/magic-auth/send");
    expect(html).toContain('name="code"');
    close();
  });

  it("POST with a valid code mints an auth code and 302-redirects to the client redirect_uri with state", async () => {
    const store = new OAuthTokenStore();
    const fetchImpl = vi.fn(async (_url?: string | URL | Request, _init?: RequestInit) =>
      okJson({ session: "gAAAA-seal", workspaceId: 1564 })) as unknown as typeof fetch;
    const { url, close } = await startApp(store, fetchImpl);
    const id = store.createLogin({ clientId: "c1", redirectUri: "https://cb.example/done", state: "xyz", codeChallenge: "ch", scopes: ["teammate"] });
    const res = await fetch(`${url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login_id: id, email: "u@x.io", code: "123456" }),
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://cb.example/done");
    expect(loc.searchParams.get("state")).toBe("xyz");
    const mintedCode = loc.searchParams.get("code")!;
    expect(store.peekAuthCode(mintedCode)?.seal).toBe("gAAAA-seal");
    close();
  });

  it("POST with an invalid code re-renders the code form and mints nothing", async () => {
    const store = new OAuthTokenStore();
    const fetchImpl = vi.fn(async (_url?: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ message: "bad code" }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const { url, close } = await startApp(store, fetchImpl);
    const id = store.createLogin({ clientId: "c1", redirectUri: "https://cb", codeChallenge: "ch", scopes: [] });
    const res = await fetch(`${url}/login`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login_id: id, email: "u@x.io", code: "000000" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="code"');
    close();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- tests/auth/oauth/login.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/auth/oauth/login.ts
import express, { Router, type Request, type Response } from "express";
import type { OAuthTokenStore } from "./token-store.js";
import { sendMagicCode, verifyMagicCode } from "../magic-auth.js";

export interface LoginRouterOptions {
  store: OAuthTokenStore;
  baseUrl: string;
  path?: string;
  fetchImpl?: typeof fetch;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function page(inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in — Diaflow Teammate MCP</title><style>body{font-family:system-ui,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem}input{width:100%;padding:.6rem;margin:.4rem 0;box-sizing:border-box}button{width:100%;padding:.6rem;cursor:pointer}.err{color:#b00}</style></head><body>${inner}</body></html>`;
}
function emailForm(loginId: string): string {
  return page(`<h1>Sign in with Diaflow</h1><form method="post"><input type="hidden" name="login_id" value="${esc(loginId)}"><label>Work email<input name="email" type="email" required autofocus></label><button type="submit">Send code</button></form>`);
}
function codeForm(loginId: string, email: string, error?: string): string {
  return page(`<h1>Enter your code</h1>${error ? `<p class="err">${esc(error)}</p>` : ""}<p>We emailed a code to ${esc(email)}.</p><form method="post"><input type="hidden" name="login_id" value="${esc(loginId)}"><input type="hidden" name="email" value="${esc(email)}"><label>Code<input name="code" inputmode="numeric" required autofocus></label><button type="submit">Continue</button></form>`);
}

export function buildLoginRouter(opts: LoginRouterOptions): Router {
  const router = Router();
  const path = opts.path ?? "/login";
  router.use(express.urlencoded({ extended: false }));

  router.get(path, (req: Request, res: Response) => {
    res.type("html").send(emailForm(String(req.query.login_id ?? "")));
  });

  router.post(path, async (req: Request, res: Response) => {
    const loginId = String(req.body.login_id ?? "");
    const email = String(req.body.email ?? "");
    const code = req.body.code ? String(req.body.code) : undefined;

    if (!code) {
      try {
        await sendMagicCode(opts.baseUrl, email, opts.fetchImpl);
      } catch {
        res.status(200).type("html").send(codeForm(loginId, email, "Could not send a code. Check the email and try again."));
        return;
      }
      res.type("html").send(codeForm(loginId, email));
      return;
    }

    let verified: { session: string; workspaceId: number | null };
    try {
      verified = await verifyMagicCode(opts.baseUrl, email, code, opts.fetchImpl);
    } catch {
      res.status(200).type("html").send(codeForm(loginId, email, "Invalid or expired code. Try again."));
      return;
    }

    const login = opts.store.takeLogin(loginId);
    if (!login) {
      res.status(400).type("html").send(page("<h1>Session expired</h1><p>Restart the authorization from your client.</p>"));
      return;
    }

    const authCode = opts.store.createAuthCode({
      seal: verified.session,
      workspaceId: verified.workspaceId,
      clientId: login.clientId,
      redirectUri: login.redirectUri,
      codeChallenge: login.codeChallenge,
      scopes: login.scopes,
    });

    const redirect = new URL(login.redirectUri);
    redirect.searchParams.set("code", authCode);
    if (login.state) redirect.searchParams.set("state", login.state);
    res.redirect(redirect.toString());
  });

  return router;
}
```

> If `verifyMagicCode`'s return field differs from `.session`/`.workspaceId`, match the existing signature in `src/auth/magic-auth.ts` exactly — do not change that file.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/auth/oauth/login.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth/login.ts tests/auth/oauth/login.test.ts
git commit -m "feat(oauth): server-rendered magic-code login router"
```

---

## Task 6: OAuth wiring (metadata + bearer middleware)

**Files:**
- Create: `src/auth/oauth/wiring.ts`
- Test: `tests/auth/oauth/wiring.test.ts`

**Interfaces:**
- Consumes: `AppConfig` (needs `oauthIssuerUrl`, `oauthResourceUrl`, `diaflowApiBase`); SDK `mcpAuthRouter`, `getOAuthProtectedResourceMetadataUrl`, `requireBearerAuth`.
- Produces: `buildOAuthWiring(cfg): { provider: DiaflowOAuthProvider; authRouter: RequestHandler; loginRouter: Router; bearer: RequestHandler; resourceMetadataUrl: string }`. `OAUTH_SCOPES = ["teammate"]`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/auth/oauth/wiring.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { buildOAuthWiring } from "../../../src/auth/oauth/wiring.js";
import type { AppConfig } from "../../../src/config.js";

const cfg = {
  diaflowApiBase: "https://api.diaflow.io",
  authMode: "oauth",
  oauthIssuerUrl: "https://teammate-mcp.onrender.com",
  oauthResourceUrl: "https://teammate-mcp.onrender.com/mcp",
} as unknown as AppConfig;

function start() {
  const app = express();
  const w = buildOAuthWiring(cfg);
  app.use(w.authRouter);
  app.get("/mcp", w.bearer, (_req, res) => res.json({ ok: true }));
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const srv = app.listen(0, () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() }));
  });
}

describe("buildOAuthWiring", () => {
  it("advertises protected-resource metadata with resource + authorization_servers", async () => {
    const { url, close } = await start();
    const res = await fetch(`${url}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("https://teammate-mcp.onrender.com/mcp");
    expect(body.authorization_servers).toContain("https://teammate-mcp.onrender.com");
    close();
  });

  it("a protected route returns 401 with WWW-Authenticate carrying resource_metadata", async () => {
    const { url, close } = await start();
    const res = await fetch(`${url}/mcp`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain("resource_metadata=");
    close();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- tests/auth/oauth/wiring.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/auth/oauth/wiring.ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/auth/oauth/wiring.test.ts`
Expected: PASS. (If the SDK's default rate-limiter interferes with the test, it will not — two requests are well under any limit.)

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth/wiring.ts tests/auth/oauth/wiring.test.ts
git commit -m "feat(oauth): assemble mcpAuthRouter + requireBearerAuth wiring"
```

---

## Task 7: `SealTokenProvider` + `buildContext` seal identity

**Files:**
- Modify: `src/auth/token-provider.ts` (add class), `src/tools/context.ts` (add optional param)
- Test: `tests/tools/context-oauth.test.ts`

**Interfaces:**
- Consumes: existing `TokenProvider` interface; `buildContext(cfg)`.
- Produces:
  - `class SealTokenProvider implements TokenProvider` constructed `(seal: string, workspaceId: number | null, onRotate?: (seal: string) => void)`.
  - `buildContext(cfg, identity?: { seal: string; workspaceId: number | null; onRotate?: (seal: string) => void }): ToolContext` — when `identity` is present it uses `SealTokenProvider`; otherwise unchanged.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools/context-oauth.test.ts
import { describe, it, expect } from "vitest";
import { buildContext } from "../../src/tools/context.js";
import type { AppConfig } from "../../src/config.js";

const cfg = { diaflowApiBase: "https://api.diaflow.io", authMode: "oauth" } as unknown as AppConfig;

describe("buildContext with seal identity", () => {
  it("builds a provider that returns the given seal + workspace", async () => {
    const ctx = buildContext(cfg, { seal: "gAAAA", workspaceId: 1564 });
    expect(await ctx.provider.getToken()).toBe("gAAAA");
    expect(ctx.provider.getWorkspaceId()).toBe(1564);
  });

  it("onRotate updates the seal and calls the writeback", async () => {
    let written = "";
    const ctx = buildContext(cfg, { seal: "old", workspaceId: null, onRotate: (s) => { written = s; } });
    ctx.provider.onRotate("new");
    expect(await ctx.provider.getToken()).toBe("new");
    expect(written).toBe("new");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- tests/tools/context-oauth.test.ts`
Expected: FAIL (`buildContext` ignores 2nd arg / type error).

- [ ] **Step 3: Implement**

In `src/auth/token-provider.ts`, append:

```ts
export class SealTokenProvider implements TokenProvider {
  private seal: string;
  constructor(seal: string, private readonly workspaceId: number | null, private readonly writeRotate?: (seal: string) => void) {
    this.seal = seal;
  }
  async getToken(): Promise<string | null> {
    return this.seal;
  }
  getWorkspaceId(): number | null {
    return this.workspaceId;
  }
  onRotate(seal: string): void {
    this.seal = seal;
    this.writeRotate?.(seal);
  }
  async isConnected(): Promise<boolean> {
    return true;
  }
}
```

In `src/tools/context.ts`, update `buildContext` signature + provider selection:

```ts
import { WorkOSSessionProvider, StaticTokenProvider, SealTokenProvider, type TokenProvider } from "../auth/token-provider.js";

export function buildContext(
  cfg: AppConfig,
  identity?: { seal: string; workspaceId: number | null; onRotate?: (seal: string) => void },
): ToolContext {
  const provider: TokenProvider = identity
    ? new SealTokenProvider(identity.seal, identity.workspaceId, identity.onRotate)
    : cfg.staticToken
      ? new StaticTokenProvider(cfg.staticToken, cfg.staticWorkspaceId ?? null)
      : new WorkOSSessionProvider({ store: new MemorySessionStore(), key: "default", baseUrl: cfg.diaflowApiBase });
  // ...unchanged below (client, apis, return)...
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/tools/context-oauth.test.ts`
Expected: PASS. Also run existing context tests to confirm no regression: `npm test -- tests/tools`.

- [ ] **Step 5: Commit**

```bash
git add src/auth/token-provider.ts src/tools/context.ts tests/tools/context-oauth.test.ts
git commit -m "feat(oauth): SealTokenProvider + buildContext seal identity"
```

---

## Task 8: `register.ts` — gate `auth`/`workspace` tools to the interactive provider

**Files:**
- Modify: `src/tools/register.ts`
- Test: `tests/tools/register-oauth.test.ts`

**Interfaces:**
- Consumes: existing `registerAll`/tool-group registration in `register.ts`; `WorkOSSessionProvider`.
- Produces: `auth` and `workspace` tool groups are registered only when `context.provider instanceof WorkOSSessionProvider`. Under `SealTokenProvider` (oauth) and `StaticTokenProvider` they are skipped.

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools/register-oauth.test.ts
import { describe, it, expect } from "vitest";
import { buildServer } from "../../src/server.js";
import { buildContext } from "../../src/tools/context.js";
import type { AppConfig } from "../../src/config.js";

const cfg = { diaflowApiBase: "https://api.diaflow.io", authMode: "oauth" } as unknown as AppConfig;

// buildServer(ctx) registers tools on an McpServer. We assert auth/workspace tools are absent
// under a seal identity by listing registered tool names via the server's internal registry.
describe("tool registration under oauth (seal) identity", () => {
  it("does not register interactive auth/workspace tools", async () => {
    const ctx = buildContext(cfg, { seal: "s", workspaceId: 1564 });
    const server = buildServer(ctx);
    const names = Object.keys((server as any)._registeredTools ?? {});
    expect(names).not.toContain("send_magic_code");
    expect(names).not.toContain("set_workspace");
    expect(names).toContain("list_teammates");
  });
});
```

> Note: confirm the exact interactive tool names in `src/tools/auth.ts` / `src/tools/workspace.ts` (e.g. `send_magic_code`, `verify_magic_code`, `set_workspace`, `list_workspaces`) and the registry accessor `_registeredTools` on the SDK `McpServer`; adjust the assertion names to the real ones. If the SDK exposes no public registry, assert instead that `buildServer` completed without registering those groups by spying on the group-register functions.

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- tests/tools/register-oauth.test.ts`
Expected: FAIL (interactive tools still registered, or wrong gate).

- [ ] **Step 3: Implement**

In `src/tools/register.ts`, import the interactive provider and gate the two groups:

```ts
import { WorkOSSessionProvider } from "../auth/token-provider.js";

// ...inside registerAll(server, context):
const interactive = context.provider instanceof WorkOSSessionProvider;
if (interactive) {
  registerAuthTools(server, context);
  registerWorkspaceTools(server, context);
}
// all other groups (read/write/avatar/skills/lifecycle/conversation/sub-agents/integration) register unconditionally
```

If the current code already gates on `!(provider instanceof StaticTokenProvider)`, replace that condition with the `interactive` check above so `SealTokenProvider` is also excluded.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/tools/register-oauth.test.ts` then `npm test -- tests/tools`
Expected: PASS; no regression in existing registration tests.

- [ ] **Step 5: Commit**

```bash
git add src/tools/register.ts tests/tools/register-oauth.test.ts
git commit -m "feat(oauth): register interactive auth/workspace tools only for WorkOS provider"
```

---

## Task 9: `index.ts` — oauth-mode HTTP app + per-request seal context

**Files:**
- Modify: `src/index.ts`
- Test: `tests/http-oauth.test.ts`

**Interfaces:**
- Consumes: `buildOAuthWiring` (Task 6), `buildContext` seal identity (Task 7), existing `buildServer`, `StreamableHTTPServerTransport`, `isInitializePost`, session map.
- Produces: exported `buildHttpApp(cfg: AppConfig): express.Express` (no `.listen`) used by both `startHttpServer` and tests. In `oauth` mode it mounts `authRouter` + `loginRouter` at root, protects `/mcp` with `bearer`, scopes `express.json()` to `/mcp`, and on session creation builds the `ToolContext` from `req.auth.extra.{seal,workspaceId}` with an `onRotate` writeback to `wiring.provider.updateAccessSeal(req.auth.token, seal)`. In `static` mode behavior is unchanged (inbound-token gate).

- [ ] **Step 1: Write the failing test**

```ts
// tests/http-oauth.test.ts
import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
import { buildHttpApp } from "../src/index.js";
import type { AppConfig } from "../src/config.js";

const cfg = {
  diaflowApiBase: "https://api.diaflow.io",
  transport: "http",
  authMode: "oauth",
  oauthIssuerUrl: "https://teammate-mcp.onrender.com",
  oauthResourceUrl: "https://teammate-mcp.onrender.com/mcp",
} as unknown as AppConfig;

function start() {
  const app = buildHttpApp(cfg);
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const srv = app.listen(0, () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() }));
  });
}

describe("http app (oauth mode)", () => {
  it("unauthenticated POST /mcp is 401 with resource_metadata in WWW-Authenticate", async () => {
    const { url, close } = await start();
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain("resource_metadata=");
    close();
  });

  it("serves protected-resource metadata", async () => {
    const { url, close } = await start();
    const res = await fetch(`${url}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    expect((await res.json()).resource).toBe("https://teammate-mcp.onrender.com/mcp");
    close();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -- tests/http-oauth.test.ts`
Expected: FAIL (`buildHttpApp` not exported).

- [ ] **Step 3: Implement**

Refactor `startHttpServer` in `src/index.ts` into a pure `buildHttpApp(cfg)` (returns the `express()` app) plus a thin listener. Key structure:

```ts
export function buildHttpApp(cfg: AppConfig): express.Express {
  const app = express();

  if (cfg.authMode === "oauth") {
    const wiring = buildOAuthWiring(cfg);
    app.use(wiring.authRouter);   // /authorize /token /register /revoke + .well-known
    app.use(wiring.loginRouter);  // /login
    app.use("/mcp", wiring.bearer, express.json());
    mountMcp(app, cfg, (req) => {
      const seal = req.auth?.extra?.seal as string | undefined;
      if (!seal) throw new Error("authenticated request missing seal");
      return {
        seal,
        workspaceId: (req.auth?.extra?.workspaceId as number | null) ?? null,
        onRotate: (s: string) => { if (req.auth?.token) wiring.provider.updateAccessSeal(req.auth.token, s); },
      };
    });
    return app;
  }

  // static mode (unchanged): global json + inbound-token gate
  app.use(express.json());
  if (!cfg.inboundToken) {
    console.error("WARNING: MCP_INBOUND_TOKEN is not set — the /mcp endpoint is UNAUTHENTICATED (dev only).");
  }
  app.use("/mcp", (req, res, next) => {
    if (!isInboundAuthorized(req.headers["authorization"], cfg.inboundToken)) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
      return;
    }
    next();
  });
  mountMcp(app, cfg, () => undefined); // static: no per-request identity
  return app;
}
```

Extract the existing POST/GET/DELETE `/mcp` handlers + session map + idle sweep into `mountMcp(app, cfg, identityFor)` where `identityFor(req)` returns the seal identity (or `undefined`). At session creation use it:

```ts
const identity = identityFor(req);
const sessionServer = buildServer(buildContext(cfg, identity));
```

Keep `startHttpServer` as:

```ts
async function startHttpServer(cfg: AppConfig): Promise<void> {
  const app = buildHttpApp(cfg);
  await new Promise<void>((resolve) => {
    app.listen(cfg.httpPort, () => {
      console.error(`diaflow-teammate-mcp listening on :${cfg.httpPort}/mcp`);
      resolve();
    });
  });
}
```

Add imports at top: `import { buildOAuthWiring } from "./auth/oauth/wiring.js";`. The idle-session sweep `setInterval` moves inside `mountMcp`; keep `sweep.unref()`.

- [ ] **Step 4: Run to verify pass**

Run: `npm test -- tests/http-oauth.test.ts`
Expected: PASS. Then full suite: `npm test`. Then `npm run build`.
Expected: all green; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/http-oauth.test.ts
git commit -m "feat(oauth): buildHttpApp with oauth-mode wiring + per-request seal context"
```

---

## Task 10: Docs, deploy config, coverage exclusion, final verification

**Files:**
- Modify: `README.md`, `.env.production.example`, `render.yaml`, `CLAUDE.md`, `vitest.config.ts` (coverage exclude for the new pure-wiring file only if it drags coverage; prefer real tests over exclusions)
- No new test file (docs); run the full suite + build.

- [ ] **Step 1: Update `.env.production.example`**

Add, after the existing auth vars:

```dotenv
# Auth mode: "static" (single service seal + MCP_INBOUND_TOKEN gate) or
# "oauth" (per-user login via Diaflow magic code; required for Diaflow's paste-URL Connect).
MCP_AUTH_MODE=oauth
# oauth mode REQUIRES a public https URL ending in /mcp (issuer = its origin, resource = full URL).
MCP_PUBLIC_URL=https://teammate-mcp.onrender.com/mcp
# In oauth mode, DIAFLOW_TOKEN / MCP_INBOUND_TOKEN are ignored.
```

- [ ] **Step 2: Update `render.yaml`**

Add env vars to the service:

```yaml
      - key: MCP_AUTH_MODE
        value: oauth
```

(Keep `MCP_PUBLIC_URL` `sync:false`; `DIAFLOW_TOKEN`/`MCP_INBOUND_TOKEN` may remain for a fallback to static mode but are unused when `MCP_AUTH_MODE=oauth`.)

- [ ] **Step 3: Update `README.md` + `CLAUDE.md`**

In `README.md`, add an "OAuth mode (per-user auth)" subsection under configuration: explain `MCP_AUTH_MODE=oauth`, the magic-code login at `/login`, DCR/PKCE support, in-memory tokens (re-login after restart), and that this is what makes Diaflow's "Connect" discovery work. In `CLAUDE.md`'s architecture summary, add one paragraph: oauth mode mounts `mcpAuthRouter` + `requireBearerAuth`; `DiaflowOAuthProvider` binds each token to a user seal via magic-code login; static mode unchanged.

- [ ] **Step 4: Full verification**

Run: `npm test -- --coverage`
Expected: all tests pass; coverage ≥ the current bar (~80%+). If the new `src/index.ts` branch lowers coverage and it's already excluded, leave as-is; do not exclude the `src/auth/oauth/*` logic files — they are covered by Tasks 2–6.

Run: `npm run build`
Expected: `tsc` clean, `dist/` emitted.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md .env.production.example render.yaml vitest.config.ts
git commit -m "docs+deploy: document and configure MCP_AUTH_MODE=oauth"
```

---

## Post-implementation manual verification (not a code task)

After deploy in oauth mode:
1. `curl https://<host>/.well-known/oauth-protected-resource/mcp` → 200 with `resource` + `authorization_servers`.
2. `curl -i -X POST https://<host>/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'` → 401 with `WWW-Authenticate: … resource_metadata="…"`.
3. In Diaflow admin, paste `https://<host>/mcp` into "Connect" → it should discover OAuth (no 504), walk the magic-code login, and register with per-user tokens.
