import { describe, it, expect, vi } from "vitest";
import { registerSubAgentTools } from "../../src/tools/sub-agents.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("sub-agent tools", () => {
  it("add_sub_agent attaches an existing agent", async () => {
    const subAgents = { attach: vi.fn(async () => ({ ok: true })) };
    const { server, tools } = fakeServer();
    registerSubAgentTools(server as any, { subAgents } as any);
    await tools["add_sub_agent"]({ teammateId: "orch1", subAgentId: "sub1" });
    expect(subAgents.attach).toHaveBeenCalledWith("orch1", "sub1");
  });

  it("create_sub_agent creates + attaches", async () => {
    const subAgents = { create: vi.fn(async () => ({ uniqueId: "sub2" })) };
    const { server, tools } = fakeServer();
    registerSubAgentTools(server as any, { subAgents } as any);
    await tools["create_sub_agent"]({ teammateId: "orch1", modelProvider: "openai", modelName: "gpt-4", name: "Helper" });
    expect(subAgents.create).toHaveBeenCalledWith("orch1", expect.objectContaining({ modelProvider: "openai", modelName: "gpt-4", name: "Helper" }));
  });

  it("list_sub_agents forwards the teammateId", async () => {
    const subAgents = { list: vi.fn(async () => [{ uniqueId: "sub1" }]) };
    const { server, tools } = fakeServer();
    registerSubAgentTools(server as any, { subAgents } as any);
    const res = await tools["list_sub_agents"]({ teammateId: "orch1" });
    expect(subAgents.list).toHaveBeenCalledWith("orch1");
    expect(res.content[0].text).toContain("sub1");
  });

  it("remove_sub_agent detaches and reports success", async () => {
    const subAgents = { detach: vi.fn(async () => {}) };
    const { server, tools } = fakeServer();
    registerSubAgentTools(server as any, { subAgents } as any);
    const res = await tools["remove_sub_agent"]({ teammateId: "orch1", subAgentId: "sub1" });
    expect(subAgents.detach).toHaveBeenCalledWith("orch1", "sub1");
    expect(res.content[0].text).toContain("detached");
  });
});
