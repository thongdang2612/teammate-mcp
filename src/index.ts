import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { loadConfig, type AppConfig } from "./config.js";
import { buildContext } from "./tools/context.js";
import { buildServer } from "./server.js";
import { isInboundAuthorized } from "./auth/inbound-auth.js";

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
}

/** How long an idle HTTP session may sit unused before the sweep closes it. */
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
/** How often the idle-session sweep runs. */
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;

function isInitializePost(body: unknown): boolean {
  if (isInitializeRequest(body)) return true;
  return Boolean(body && typeof body === "object" && (body as { method?: unknown }).method === "initialize");
}

/**
 * HTTP transport: one MCP server + isolated ToolContext (and thus one isolated
 * WorkOSSessionProvider) per session id, mounted at POST/GET/DELETE /mcp.
 */
async function startHttpServer(cfg: AppConfig): Promise<void> {
  const app = express();
  app.use(express.json());

  if (!cfg.inboundToken) {
    console.error("WARNING: MCP_INBOUND_TOKEN is not set — the /mcp endpoint is UNAUTHENTICATED (dev only).");
  }

  // Inbound auth: when MCP_INBOUND_TOKEN is set (required for a public deploy / Diaflow
  // custom-MCP), every /mcp request must present `Authorization: Bearer <MCP_INBOUND_TOKEN>`.
  app.use("/mcp", (req, res, next) => {
    if (!isInboundAuthorized(req.headers["authorization"], cfg.inboundToken)) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
      return;
    }
    next();
  });

  const sessions = new Map<string, SessionEntry>();

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;

    if (entry) {
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

    const sessionServer = buildServer(buildContext(cfg));
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id: string): void => {
        sessions.set(id, { transport, lastSeen: Date.now() });
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

  await new Promise<void>((resolve) => {
    app.listen(cfg.httpPort, () => {
      console.error(`diaflow-teammate-mcp listening on :${cfg.httpPort}/mcp`);
      resolve();
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
