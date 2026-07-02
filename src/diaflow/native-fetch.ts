import { DiaflowHttpError } from "./errors.js";

export async function nativePost<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  opts: { bearer?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ data: T; rotated?: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = new Headers({ "X-Client": "native", "Content-Type": "application/json" });
  if (opts.bearer) headers.set("Authorization", `Bearer ${opts.bearer}`);

  const res = await fetchImpl(`${baseUrl}/api/v1${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  const parsed = text ? tryJson(text) : undefined;
  if (!res.ok) {
    const code = str(parsed, "code");
    const message = str(parsed, "message") ?? str(parsed, "detail") ?? `HTTP ${res.status}`;
    throw new DiaflowHttpError(res.status, message, { code, detail: parsed ?? text });
  }
  return { data: parsed as T, rotated: res.headers.get("x-diaflow-session") ?? undefined };
}

function tryJson(t: string): unknown {
  try { return JSON.parse(t); } catch { return t; }
}
function str(o: unknown, k: string): string | undefined {
  if (o && typeof o === "object" && k in o) {
    const v = (o as Record<string, unknown>)[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}
