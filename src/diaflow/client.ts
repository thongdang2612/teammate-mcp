import { DiaflowHttpError } from "./errors.js";

export interface DiaflowClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  getWorkspaceId: () => number | null;
  onRotate?: (seal: string) => void;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  workspaceId?: number | null;
  signal?: AbortSignal;
}

export class DiaflowClient {
  constructor(private readonly opts: DiaflowClientOptions) {}

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.opts.baseUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(options.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers = new Headers({ "X-Client": "native" });
    const token = await this.opts.getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const ws = options.workspaceId ?? this.opts.getWorkspaceId();
    if (ws != null) headers.set("Workspace-Id", String(ws));

    let body: string | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }

    const res = await this.fetchImpl(url.toString(), { method, headers, body, signal: options.signal });

    const rotated = res.headers.get("x-diaflow-session");
    if (rotated) this.opts.onRotate?.(rotated);

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;

    if (!res.ok) {
      const code = pickString(parsed, "code");
      const message = pickString(parsed, "message") ?? pickString(parsed, "detail") ?? `HTTP ${res.status}`;
      throw new DiaflowHttpError(res.status, message, { code, detail: parsed ?? text });
    }
    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pickString(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}
