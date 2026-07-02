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
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

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
