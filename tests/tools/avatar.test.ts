import { describe, it, expect, vi } from "vitest";
import { registerAvatarTools } from "../../src/tools/avatar.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("avatar tools", () => {
  it("set_teammate_avatar uploads a remote image then patches icon", async () => {
    const teammates = { update: vi.fn(async () => ({ uniqueId: "u1", icon: "k" })) };
    const uploadRemoteImage = vi.fn(async () => ({ key: "agent-teammate-icons/02-07-26/u1_avatar.png", url: "https://cdn/k" }));
    const { server, tools } = fakeServer();
    registerAvatarTools(server as any, { teammates, client: {} as any, uploadRemoteImage, presetHosts: ["cdn.diaflow.io"] } as any);
    await tools["set_teammate_avatar"]({ teammateId: "u1", imageUrl: "https://elsewhere.com/a.png" });
    expect(uploadRemoteImage).toHaveBeenCalled();
    expect(teammates.update).toHaveBeenCalledWith("u1", { icon: "agent-teammate-icons/02-07-26/u1_avatar.png" });
  });

  it("set_teammate_avatar sets a preset URL directly without uploading", async () => {
    const teammates = { update: vi.fn(async () => ({ uniqueId: "u1", icon: "https://cdn.diaflow.io/p.png" })) };
    const uploadRemoteImage = vi.fn();
    const { server, tools } = fakeServer();
    registerAvatarTools(server as any, { teammates, client: {} as any, uploadRemoteImage, presetHosts: ["cdn.diaflow.io"] } as any);
    await tools["set_teammate_avatar"]({ teammateId: "u1", imageUrl: "https://cdn.diaflow.io/p.png" });
    expect(uploadRemoteImage).not.toHaveBeenCalled();
    expect(teammates.update).toHaveBeenCalledWith("u1", { icon: "https://cdn.diaflow.io/p.png" });
  });
});
