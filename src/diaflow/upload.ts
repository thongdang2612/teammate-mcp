import type { DiaflowClient } from "./client.js";
import type { PresignResponse } from "./types.js";
import { slugify } from "../utils/slug.js";
import { buildModulePath } from "../utils/upload-paths.js";

const MAX_BYTES = 10 * 1024 * 1024;
const TEAMMATE_ICON_FOLDER = "agent-teammate-icons";

export function presignUpload(
  client: DiaflowClient,
  params: { name: string; type: string; folder: string; fileSize?: number },
): Promise<PresignResponse> {
  return client.request<PresignResponse>("POST", "/drives/s3/presigned", {
    body: { name: params.name, type: params.type, folder: params.folder, file_size: params.fileSize },
  });
}

export async function putToPresigned(
  uploadUrl: string,
  bytes: ArrayBuffer | Uint8Array,
  contentType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes as BodyInit,
  });
  if (!res.ok) throw new Error(`S3 upload failed: HTTP ${res.status}`);
}

function extensionFor(contentType: string): string {
  const map: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
  return map[contentType] ?? "png";
}

export async function uploadRemoteImage(
  client: DiaflowClient,
  params: { teammateId: string; imageUrl: string; date: Date; fetchImpl?: typeof fetch; maxBytes?: number },
): Promise<{ key: string; url: string }> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const maxBytes = params.maxBytes ?? MAX_BYTES;

  const dl = await fetchImpl(params.imageUrl);
  if (!dl.ok) throw new Error(`failed to download image: HTTP ${dl.status}`);
  const contentType = dl.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
  const buf = new Uint8Array(await dl.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error(`image size ${buf.byteLength} exceeds max ${maxBytes} bytes`);

  const filename = `${params.teammateId}_${slugify(`avatar.${extensionFor(contentType)}`)}`;
  const folder = buildModulePath(TEAMMATE_ICON_FOLDER, params.date);
  const presigned = await presignUpload(client, { name: filename, type: contentType, folder, fileSize: buf.byteLength });
  await putToPresigned(presigned.uploadUrl, buf, contentType, fetchImpl);
  return { key: presigned.key, url: presigned.url };
}
