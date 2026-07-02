import { describe, it, expect, vi } from "vitest";
import { registerReadTools } from "../../src/tools/read.js";
import { TeammatesApi } from "../../src/diaflow/teammates.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  const server = {
    registerTool: (name: string, _def: any, handler: any) => {
      tools[name] = handler;
    },
  };
  return { server, tools };
}

describe("read tools", () => {
  it("list_teammates returns text with the total", async () => {
    const teammates = { list: vi.fn(async () => ({ total: 2, results: [{ id: 1, uniqueId: "u1", name: "A" }] })) } as unknown as TeammatesApi;
    const { server, tools } = fakeServer();
    registerReadTools(server as any, { teammates } as any);
    const res = await tools["list_teammates"]({ pageSize: 5 });
    expect(teammates.list).toHaveBeenCalledWith({ page: undefined, pageSize: 5, lifecycle: undefined, search: undefined, orderBy: undefined });
    expect(res.content[0].text).toContain("\"total\": 2");
  });

  it("get_teammate fetches by id", async () => {
    const teammates = { get: vi.fn(async () => ({ id: 1, uniqueId: "u1", name: "A" })) } as unknown as TeammatesApi;
    const { server, tools } = fakeServer();
    registerReadTools(server as any, { teammates } as any);
    const res = await tools["get_teammate"]({ teammateId: "u1" });
    expect(teammates.get).toHaveBeenCalledWith("u1");
    expect(res.content[0].text).toContain("u1");
  });
});
