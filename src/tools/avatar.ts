import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiaflowClient } from "../diaflow/client.js";
import type { TeammatesApi } from "../diaflow/teammates.js";
import { listPresetAvatars } from "../diaflow/avatars.js";
import { uploadRemoteImage as defaultUpload } from "../diaflow/upload.js";
import { TEAMMATE_ID_DESC } from "./descriptions.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export interface AvatarToolDeps {
  teammates: TeammatesApi;
  client: DiaflowClient;
  presetHosts?: string[];
  uploadRemoteImage?: typeof defaultUpload;
  now?: () => Date;
}

function isPresetUrl(imageUrl: string, presetHosts: string[]): boolean {
  try {
    const host = new URL(imageUrl).host;
    return presetHosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export function registerAvatarTools(server: McpServer, deps: AvatarToolDeps): void {
  const upload = deps.uploadRemoteImage ?? defaultUpload;
  const presetHosts = deps.presetHosts ?? [];
  const now = deps.now ?? (() => new Date());

  server.registerTool(
    "list_preset_avatars",
    { description: "List Diaflow's curated preset avatars.", inputSchema: { category: z.string().optional() } },
    async (args) => asText(await listPresetAvatars(deps.client, args.category)),
  );

  server.registerTool(
    "set_teammate_avatar",
    {
      description: "Set a teammate's avatar from a remote image URL (uploaded via S3 presign) or a Diaflow preset URL.",
      inputSchema: { teammateId: z.string().min(1).describe(TEAMMATE_ID_DESC), imageUrl: z.string().url() },
    },
    async (args) => {
      let icon: string;
      if (isPresetUrl(args.imageUrl, presetHosts)) {
        icon = args.imageUrl;
      } else {
        const uploaded = await upload(deps.client, { teammateId: args.teammateId, imageUrl: args.imageUrl, date: now() });
        icon = uploaded.key;
      }
      return asText(await deps.teammates.update(args.teammateId, { icon }));
    },
  );
}
