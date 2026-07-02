import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { buildContext } from "./tools/context.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (cfg.transport === "stdio") {
    const server = buildServer(buildContext(cfg));
    await server.connect(new StdioServerTransport());
    return;
  }
  throw new Error("HTTP transport is implemented in a later task; set MCP_TRANSPORT=stdio for now.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
