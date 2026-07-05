import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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

/** Per-request seal identity, resolved from the authenticated caller (oauth mode) or absent (static mode). */
type SessionIdentity = Parameters<typeof buildContext>[1];

/**
 * Logs one line per /mcp request. Tool invocations are tagged `[tool-use]` (with `tool=<name>`)
 * so they can be filtered apart from general request noise (`[mcp]` for initialize/tools-list/etc.);
 * everything else keeps the `[mcp]` tag. Reads fields lazily at `finish` so it
 * can run FIRST (before auth + json) yet still see req.body / req.auth once populated — and still
 * log requests rejected before those run (e.g. 401 with no/invalid token). `console.error` (stderr)
 * matches the rest of the file and is captured by Render/Docker.
 */
function mcpRequestLogger(req: Request, res: Response, next: NextFunction): void {
  res.on("finish", () => {
    const body = req.body as { method?: string; params?: { name?: string } } | undefined;
    const rpc = req.method === "POST" && body && typeof body.method === "string" ? body.method : "";
    const tool = rpc === "tools/call" ? (body?.params?.name ?? "?") : "";
    const auth = req.auth ? "auth-ok" : req.headers["authorization"] ? "bearer" : "noauth";
    // Tool invocations get a dedicated `[tool-use]` tag so they can be filtered out of
    // the general request noise (initialize / tools/list / pings) — grep `[tool-use]`
    // for exactly the tools that ran, and `tool=<name>` for a specific tool.
    if (tool) {
      console.error(`[tool-use] tool=${tool} ${auth} -> ${res.statusCode}`);
    } else {
      console.error(`[mcp] ${req.method} ${auth} rpc=${rpc} -> ${res.statusCode}`);
    }
  });
  next();
}

/** Error-handling middleware (registered last) so a thrown/rejected handler is logged, not silent. */
function mcpErrorLogger(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  console.error("[mcp] handler error:", err instanceof Error ? (err.stack ?? err.message) : err);
  if (!res.headersSent) {
    res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
}

/**
 * Mounts POST /mcp as a STATELESS Streamable-HTTP endpoint: a fresh McpServer + isolated
 * ToolContext per request, with `sessionIdGenerator: undefined` (no `Mcp-Session-Id` issued or
 * required). Stateless is what interoperates with MCP clients — like Diaflow's agent runtime —
 * that don't hold a session across requests: the previous stateful/session model caused handshake
 * churn (re-`initialize` on an existing session → 400, out-of-order requests) so `tools/call` never
 * landed, while stateless servers (e.g. Linear's) worked. Each request is authenticated
 * independently upstream and its ToolContext is built from that request's identity, so per-request
 * isolation is inherent (no shared session state, hence no cross-session hijack surface). `GET`
 * (server→client SSE stream) and `DELETE` (session teardown) are meaningless without sessions → 405.
 */
function mountMcp(app: Express, cfg: AppConfig, identityFor: (req: Request) => SessionIdentity): void {
  app.post("/mcp", async (req: Request, res: Response) => {
    const context: ToolContext = buildContext(cfg, identityFor(req));
    const server = buildServer(context);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed: stateless server; use POST /mcp" },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
}

/**
 * Builds the HTTP Express app (no `.listen`) so it can be shared between the real server
 * (`startHttpServer`) and tests. Branches on `cfg.authMode`:
 *  - `oauth`: mounts the SDK auth router (`/authorize`, `/token`, `/register`, `/revoke`, the
 *    `.well-known` metadata) and the magic-code login router at root, protects `/mcp` with the
 *    bearer middleware (scoping `express.json()` to `/mcp` only, so it doesn't interfere with the
 *    auth router's own body parsing on `/token`), and builds each request's `ToolContext` from the
 *    authenticated caller's seal — with a rotation writeback into the token store.
 *  - `static` (default): unchanged inbound behavior — global `express.json()`, the inbound-token
 *    gate on `/mcp`, and no per-request identity (falls back to `cfg.staticToken` / WorkOS session).
 */
export function buildHttpApp(cfg: AppConfig): Express {
  const app = express();
  // Behind Render/Cloud proxies the client IP arrives via X-Forwarded-For. Trust the first proxy
  // hop so express-rate-limit (used by the SDK's OAuth router) can read the real IP instead of
  // throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR, which otherwise breaks /authorize|/token|/register.
  app.set("trust proxy", 1);

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

  app.use("/mcp", mcpRequestLogger);
  // Inbound auth: when MCP_INBOUND_TOKEN is set (required for a public deploy / Diaflow
  // custom-MCP), every /mcp request must present `Authorization: Bearer <MCP_INBOUND_TOKEN>`.
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
        `[boot] Diaflow Teammate MCP up | transport=http (stateless) authMode=${cfg.authMode} ` +
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
