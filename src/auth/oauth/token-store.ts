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
