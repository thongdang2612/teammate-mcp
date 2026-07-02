import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
}

/**
 * HTTP transport: one MCP server + isolated ToolContext (and thus one isolated
 * WorkOSSessionProvider) per session id, mounted at POST/GET /mcp.
 */
async function startHttpServer(cfg: AppConfig): Promise<void> {
  const app = express();
  app.use(express.json());

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
    let entry = sessionId ? sessions.get(sessionId) : undefined;

    if (!entry) {
      const sessionServer = buildServer(buildContext(cfg));
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id: string): void => {
          sessions.set(id, { transport });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await sessionServer.connect(transport);
      entry = { transport };
    }
    await entry.transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(400).end();
      return;
    }
    await entry.transport.handleRequest(req, res);
  });

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
