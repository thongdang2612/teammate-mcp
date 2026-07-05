import { describe, it, expect, vi } from "vitest";
import { registerAllTools, installToolUseLogging } from "../../src/tools/register.js";
import { buildContext } from "../../src/tools/context.js";
import { loadConfig } from "../../src/config.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("registerAllTools", () => {
  it("registers auth + workspace tools for a WorkOSSessionProvider context", () => {
    const ctx = buildContext(loadConfig({ DIAFLOW_API_BASE: "https://x" } as any));
    const { server, tools } = fakeServer();
    registerAllTools(server as any, ctx);
    expect(tools["connect_diaflow"]).toBeDefined();
    expect(tools["set_workspace"]).toBeDefined();
    expect(tools["list_teammates"]).toBeDefined();
    expect(tools["publish_teammate"]).toBeDefined();
    expect(tools["message_teammate"]).toBeDefined();
    expect(tools["list_sub_agents"]).toBeDefined();
  });

  it("omits auth + workspace tools for a StaticTokenProvider context", () => {
    const ctx = buildContext(loadConfig({ DIAFLOW_API_BASE: "https://x", DIAFLOW_TOKEN: "SEAL" } as any));
    const { server, tools } = fakeServer();
    registerAllTools(server as any, ctx);
    expect(tools["connect_diaflow"]).toBeUndefined();
    expect(tools["set_workspace"]).toBeUndefined();
    expect(tools["list_teammates"]).toBeDefined();
  });
});

describe("installToolUseLogging", () => {
  it("logs a [tool-use] ok line for every tool and passes the result through", async () => {
    const { server, tools } = fakeServer();
    installToolUseLogging(server as any);
    server.registerTool("demo", {} as any, (async (a: any) => ({ ok: a.x })) as any);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: any) => { lines.push(String(m)); });
    try {
      const res = await tools["demo"]({ x: 1 }, {});
      expect(res).toEqual({ ok: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(lines.some((l) => l.includes("[tool-use] tool=demo -> ok"))).toBe(true);
  });

  it("logs a [tool-use] throw line and rethrows when a tool handler fails", async () => {
    const { server, tools } = fakeServer();
    installToolUseLogging(server as any);
    server.registerTool("boom", {} as any, (async () => { throw new Error("nope"); }) as any);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: any) => { lines.push(String(m)); });
    try {
      await expect(tools["boom"]({}, {})).rejects.toThrow("nope");
    } finally {
      spy.mockRestore();
    }
    expect(lines.some((l) => l.includes("[tool-use] tool=boom -> throw"))).toBe(true);
  });
});
