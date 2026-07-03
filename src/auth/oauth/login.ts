import express, { Router, type Request, type Response } from "express";
import type { OAuthTokenStore } from "./token-store.js";
import { sendMagicCode, verifyMagicCode } from "../magic-auth.js";

/** Just enough of a registered OAuth client to render "X is requesting access" on the login page. */
export interface ClientLookup {
  getClient(clientId: string): { client_name?: string; redirect_uris?: string[] } | undefined;
}

export interface LoginRouterOptions {
  store: OAuthTokenStore;
  baseUrl: string;
  clients: ClientLookup;
  path?: string;
  fetchImpl?: typeof fetch;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in — Diaflow Teammate MCP</title><style>body{font-family:system-ui,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem}input{width:100%;padding:.6rem;margin:.4rem 0;box-sizing:border-box}button{width:100%;padding:.6rem;cursor:pointer}.err{color:#b00}</style></head><body>${inner}</body></html>`;
}
function consentLine(clientName?: string): string {
  return clientName ? `<p><strong>${esc(clientName)}</strong> is requesting access to your Diaflow account.</p>` : "";
}
function emailForm(loginId: string, clientName?: string): string {
  return page(`<h1>Sign in with Diaflow</h1>${consentLine(clientName)}<form method="post"><input type="hidden" name="login_id" value="${esc(loginId)}"><label>Work email<input name="email" type="email" required autofocus></label><button type="submit">Send code</button></form>`);
}
function codeForm(loginId: string, email: string, error?: string, clientName?: string): string {
  return page(`<h1>Enter your code</h1>${consentLine(clientName)}${error ? `<p class="err">${esc(error)}</p>` : ""}<p>We emailed a code to ${esc(email)}.</p><form method="post"><input type="hidden" name="login_id" value="${esc(loginId)}"><input type="hidden" name="email" value="${esc(email)}"><label>Code<input name="code" inputmode="numeric" required autofocus></label><button type="submit">Continue</button></form>`);
}

/**
 * Resolves the display name of the client that started this login, for the consent line on the
 * login page. Returns `undefined` only when there's no `login_id` or no matching pending login
 * (e.g. it expired) — a missing/unknown client still renders with an "An application" fallback,
 * since by that point we know *someone* asked for a login even if we can't name them.
 */
function resolveClientName(opts: LoginRouterOptions, loginId: string): string | undefined {
  if (!loginId) return undefined;
  const login = opts.store.peekLogin(loginId);
  if (!login) return undefined;
  const client = opts.clients.getClient(login.clientId);
  const redirectHost = (() => {
    const uri = client?.redirect_uris?.[0];
    if (!uri) return undefined;
    try {
      return new URL(uri).host;
    } catch {
      return undefined;
    }
  })();
  return client?.client_name || redirectHost || "An application";
}

export function buildLoginRouter(opts: LoginRouterOptions): Router {
  const router = Router();
  const path = opts.path ?? "/login";
  router.use(express.urlencoded({ extended: false }));

  router.get(path, (req: Request, res: Response) => {
    const loginId = String(req.query.login_id ?? "");
    res.type("html").send(emailForm(loginId, resolveClientName(opts, loginId)));
  });

  router.post(path, async (req: Request, res: Response) => {
    const loginId = String(req.body.login_id ?? "");
    const email = String(req.body.email ?? "");
    const code = req.body.code ? String(req.body.code) : undefined;
    const clientName = resolveClientName(opts, loginId);

    if (!code) {
      try {
        await sendMagicCode(opts.baseUrl, email, opts.fetchImpl);
      } catch {
        res.status(200).type("html").send(codeForm(loginId, email, "Could not send a code. Check the email and try again.", clientName));
        return;
      }
      res.type("html").send(codeForm(loginId, email, undefined, clientName));
      return;
    }

    let verified: { session: string; workspaceId: number | null };
    try {
      verified = await verifyMagicCode(opts.baseUrl, email, code, opts.fetchImpl);
    } catch {
      res.status(200).type("html").send(codeForm(loginId, email, "Invalid or expired code. Try again.", clientName));
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
