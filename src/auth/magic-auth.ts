import { nativePost } from "../diaflow/native-fetch.js";

export interface VerifyResult {
  session: string;
  workspaceId: number | null;
  subdomain?: string;
}

interface WorkspaceSelectPayload {
  session?: string | null;
  workspaceId?: number | null;
  subdomain?: string | null;
}

export async function sendMagicCode(baseUrl: string, email: string, fetchImpl?: typeof fetch): Promise<void> {
  await nativePost(baseUrl, "/auth/magic-auth/send", { email }, { fetchImpl });
}

export async function verifyMagicCode(
  baseUrl: string,
  email: string,
  code: string,
  fetchImpl?: typeof fetch,
): Promise<VerifyResult> {
  const { data } = await nativePost<WorkspaceSelectPayload>(baseUrl, "/auth/magic-auth/verify", { email, code }, { fetchImpl });
  if (!data.session) throw new Error("magic-auth verify returned no session seal (check X-Client/native gate)");
  return { session: data.session, workspaceId: data.workspaceId ?? null, subdomain: data.subdomain ?? undefined };
}

export async function selectWorkspace(
  baseUrl: string,
  seal: string,
  workspaceId: number,
  fetchImpl?: typeof fetch,
): Promise<{ session: string; workspaceId: number }> {
  const { data } = await nativePost<WorkspaceSelectPayload>(
    baseUrl,
    "/auth/workspace/select",
    { workspaceId },
    { bearer: seal, fetchImpl },
  );
  const session = data.session ?? seal;
  return { session, workspaceId: data.workspaceId ?? workspaceId };
}
