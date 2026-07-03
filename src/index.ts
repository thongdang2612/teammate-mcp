import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { loadConfig, type AppConfig } from "./config.js";
import { buildContext, type ToolContext } from "./tools/context.js";
import { buildServer } from "./server.js";
import { isInboundAuthorized } from "./auth/inbound-auth.js";
import { buildOAuthWiring } from "./auth/oauth/wiring.js";

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (cfg.transport === "stdio") {
    const server = buildServer(buildContext(cfg));
    await server.connect(new StdioServerTransport());
    return;
  }

  await startHttpServer(cfg);
}

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
  /**
   * The access token (`req.auth?.token`) of the request that created this session — `undefined`
   * in static mode. Every reuse of an existing session must present this same token, otherwise
   * one oauth user could hijack another user's session by guessing/observing its
   * `Mcp-Session-Id` and pairing it with their own (otherwise valid) token. Bound to the token
   * rather than the underlying Diaflow seal because the token survives seal rotation (rotation
   * just updates the token store's record; the token string itself doesn't change), and once the
   * token itself expires the client has to re-initialize anyway.
   */
  identityKey?: string;
}

/** Per-request seal identity, resolved from the authenticated caller (oauth mode) or absent (static mode). */
type SessionIdentity = Parameters<typeof buildContext>[1];

/** How long an idle HTTP session may sit unused before the sweep closes it. */
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
/** How often the idle-session sweep runs. */
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;

function isInitializePost(body: unknown): boolean {
  if (isInitializeRequest(body)) return true;
  return Boolean(body && typeof body === "object" && (body as { method?: unknown }).method === "initialize");
}

/**
 * Constant-time equality for the session-identity comparison, mirroring
 * `auth/inbound-auth.ts`'s `timingSafeEqualStrings` — avoids leaking the token via
 * response-time timing differences.
 */
function tokensEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * True when `entry` was created under a different identity than the caller now presents.
 * `identityKey === undefined` means static mode (no per-request identity at all) — the check is
 * always skipped there, leaving static behavior unchanged.
 */
function sessionIdentityMismatch(entry: SessionEntry, req: Request): boolean {
  return entry.identityKey !== undefined && !tokensEqual(entry.identityKey, req.auth?.token);
}

function rejectSessionIdentityMismatch(res: Response): void {
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: session does not belong to this token" },
    id: null,
  });
}

/**
 * Logs one line per /mcp request (method, short session id, auth state, JSON-RPC method + tool
 * name, final status) so tool-call activity is visible in the platform's log tab. Logs on
 * `finish` to capture the response status. `console.error` (stderr) matches the rest of the file
 * and is captured by Render/Docker.
 */
function mcpRequestLogger(req: Request, res: Response, next: NextFunction): void {
  // Read fields lazily at `finish` so this can run FIRST (before auth + json) and still see
  // req.body / req.auth once later middleware has populated them — while also capturing requests
  // that are rejected before those run (e.g. 401 with no/invalid token).
  res.on("finish", () => {
    const sid = (req.headers["mcp-session-id"] as string | undefined)?.slice(0, 8) ?? "-";
    const body = req.body as { method?: string; params?: { name?: string } } | undefined;
    const rpc = req.method === "POST" && body && typeof body.method === "string" ? body.method : "";
    const tool = rpc === "tools/call" ? (body?.params?.name ?? "?") : "";
    const auth = req.auth ? "auth-ok" : req.headers["authorization"] ? "bearer" : "noauth";
    console.error(`[mcp] ${req.method} sid=${sid} ${auth} rpc=${rpc}${tool ? ":" + tool : ""} -> ${res.statusCode}`);
  });
  next();
}

/** Error-handling middleware (registered last) so a thrown/rejected handler is logged, not silent. */
function mcpErrorLogger(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  console.error("[mcp] handler error:", err instanceof Error ? err.stack ?? err.message : err);
  if (!res.headersSent) {
    res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
}

/**
 * Mounts POST/GET/DELETE /mcp: one MCP server + isolated ToolContext (and thus one isolated
 * TokenProvider) per session id. `identityFor` resolves the per-request seal identity to build
 * that ToolContext with — `undefined` in static mode, `{ seal, workspaceId, onRotate }` in oauth
 * mode (derived from the authenticated caller).
 */
function mountMcp(app: Express, cfg: AppConfig, identityFor: (req: Request) => SessionIdentity): void {
  const sessions = new Map<string, SessionEntry>();

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;

    if (entry) {
      if (sessionIdentityMismatch(entry, req)) {
        rejectSessionIdentityMismatch(res);
        return;
      }
      entry.lastSeen = Date.now();
      await entry.transport.handleRequest(req, res, req.body);
      return;
    }

    // Only a fresh `initialize` request may create a new session server. A non-initialize
    // POST with no/unknown session id would otherwise silently spin up an untracked server.
    if (!isInitializePost(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: no valid session ID provided" },
        id: null,
      });
      return;
    }

    const context: ToolContext = buildContext(cfg, identityFor(req));
    const sessionServer = buildServer(context);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id: string): void => {
        sessions.set(id, { transport, lastSeen: Date.now(), identityKey: req.auth?.token });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await sessionServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(400).end();
      return;
    }
    if (sessionIdentityMismatch(entry, req)) {
      rejectSessionIdentityMismatch(res);
      return;
    }
    entry.lastSeen = Date.now();
    await entry.transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(400).end();
      return;
    }
    if (sessionIdentityMismatch(entry, req)) {
      rejectSessionIdentityMismatch(res);
      return;
    }
    await entry.transport.handleRequest(req, res);
    sessions.delete(sessionId as string);
  });

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeen > SESSION_IDLE_TTL_MS) {
        sessions.delete(id);
        entry.transport.close().catch(() => {});
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweep.unref();
}

/**
 * Builds the HTTP Express app (no `.listen`) so it can be shared between the real server
 * (`startHttpServer`) and tests. Branches on `cfg.authMode`:
 *  - `oauth`: mounts the SDK auth router (`/authorize`, `/token`, `/register`, `/revoke`, the
 *    `.well-known` metadata) and the magic-code login router at root, protects `/mcp` with the
 *    bearer middleware (scoping `express.json()` to `/mcp` only, so it doesn't interfere with the
 *    auth router's own body parsing on `/token`), and builds each session's `ToolContext` from the
 *    authenticated caller's seal — with a rotation writeback into the token store.
 *  - `static` (default): unchanged today's behavior — global `express.json()`, the inbound-token
 *    gate on `/mcp`, and no per-request identity (falls back to `cfg.staticToken` / WorkOS session).
 */
export function buildHttpApp(cfg: AppConfig): Express {
  const app = express();

  if (cfg.authMode === "oauth") {
    const wiring = buildOAuthWiring(cfg);
    app.use(wiring.authRouter); // /authorize /token /register /revoke + .well-known
    app.use(wiring.loginRouter); // /login
    app.use("/mcp", mcpRequestLogger, wiring.bearer, express.json());

    mountMcp(app, cfg, (req) => {
      const seal = req.auth?.extra?.seal as string | undefined;
      if (!seal) throw new Error("authenticated request missing seal");
      return {
        seal,
        workspaceId: (req.auth?.extra?.workspaceId as number | null) ?? null,
        onRotate: (s: string) => {
          if (req.auth?.token) wiring.provider.updateAccessSeal(req.auth.token, s);
        },
      };
    });

    app.use(mcpErrorLogger);
    return app;
  }

  // static mode (unchanged): global json + inbound-token gate
  app.use(express.json());

  if (!cfg.inboundToken) {
    console.error("WARNING: MCP_INBOUND_TOKEN is not set — the /mcp endpoint is UNAUTHENTICATED (dev only).");
  }

  // Inbound auth: when MCP_INBOUND_TOKEN is set (required for a public deploy / Diaflow
  // custom-MCP), every /mcp request must present `Authorization: Bearer <MCP_INBOUND_TOKEN>`.
  app.use("/mcp", mcpRequestLogger);
  app.use("/mcp", (req, res, next) => {
    if (!isInboundAuthorized(req.headers["authorization"], cfg.inboundToken)) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
      return;
    }
    next();
  });

  mountMcp(app, cfg, () => undefined); // static: no per-request identity

  app.use(mcpErrorLogger);
  return app;
}

async function startHttpServer(cfg: AppConfig): Promise<void> {
  const app = buildHttpApp(cfg);
  await new Promise<void>((resolve) => {
    app.listen(cfg.httpPort, () => {
      console.error(
        `[boot] Diaflow Teammate MCP up | transport=http authMode=${cfg.authMode} ` +
          `port=${cfg.httpPort} publicUrl=${cfg.oauthResourceUrl ?? cfg.publicUrl ?? "-"} ` +
          `apiBase=${cfg.diaflowApiBase} inboundToken=${cfg.inboundToken ? "set" : "unset"}`,
      );
      resolve();
    });
  });
}

// Only run as the server entrypoint when executed directly (`node dist/index.js` / `tsx src/index.ts`),
// not when imported (e.g. `buildHttpApp` from tests) — importing this module must not have side effects.
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
