# diaflow-teammate-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript MCP server that exposes Diaflow's Teammate (backend: `agent`) module — read, create, update (incl. avatar via S3 presign), skills attach/detach, and lifecycle — authenticated as a third-party client via Diaflow's headless magic-auth flow.

**Architecture:** A thin, typed HTTP client wraps Diaflow's `/api/v1` API. Auth replicates Diaflow's React-Native login: `magic-auth/send` → `magic-auth/verify` returns a WorkOS sealed session in the JSON `session` field (gated by `X-Client: native` + no `Origin`), which is forwarded as `Authorization: Bearer` on every call and rotated via the `X-Diaflow-Session` response header. Tools are registered on an MCP server (`@modelcontextprotocol/sdk`) over stdio (local) or Streamable HTTP (remote). No Diaflow/WorkOS secrets are needed.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥20 (global `fetch`), `@modelcontextprotocol/sdk`, `zod`, `vitest` (+ `@vitest/coverage-v8`), `tsx` (dev runner).

## Global Constraints

- Runtime: Node ≥ 20 (uses global `fetch`/`Blob`/`AbortController`); TypeScript ESM with `"module"/"moduleResolution": "NodeNext"`; all local imports use explicit `.js` extensions.
- Every Diaflow request MUST send header `X-Client: native` and MUST NOT send `Origin` or `Referer` (this is what returns the sealed session in the body and keeps native routing).
- The sealed session is the value of the **`session`** field in `magic-auth/verify` / `workspace/select` responses (a Fernet `gAAAAA…` string). `access_token` is always null (deprecated legacy-JWT slot) — never use it.
- Authenticated calls send `Authorization: Bearer <session>` and, when a workspace is known, `Workspace-Id: <id>`.
- After every response, if header `X-Diaflow-Session` is present, treat its value as the new sealed session and persist it (rotation).
- Teammate avatar upload: presign via `POST /api/v1/drives/s3/presigned`, raw `PUT` the bytes to the returned `uploadUrl` with ONLY `Content-Type` (no auth header), then persist the returned `key` as `icon`. Max image size 10 MB. Upload folder: `agent-teammate-icons/<dd-mm-yy>`.
- Update teammate body is a dict-of-dicts: `{ "main": { ...fields } }`.
- **Two auth directions (do not conflate):** (a) *outbound* — our MCP → Diaflow API, via a WorkOS sealed session (`WorkOSSessionProvider` interactive, or `StaticTokenProvider` for non-interactive/service deployments); (b) *inbound* — a caller → our MCP over HTTP. When deployed as a Diaflow **custom MCP** (a teammate calls us), Diaflow authenticates to us with a static `Authorization: Bearer <MCP_INBOUND_TOKEN>` we register; the HTTP transport MUST validate it. Diaflow requires **Streamable HTTP + a public HTTPS URL** (no stdio/SSE; localhost/private IPs/plain http are rejected).
- No secrets hardcoded; config via env, validated with zod at startup.
- Files stay focused (< 300 lines); TDD (failing test first); commit after each task.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example
src/
  config.ts                 # zod-validated env
  diaflow/
    errors.ts               # DiaflowHttpError
    client.ts               # DiaflowClient: headers, error mapping, rotation capture
    native-fetch.ts         # unauthenticated native POST helper (magic-auth)
    types.ts                # Agent, AgentDetail, Skill, Presign types
    teammates.ts            # TeammatesApi: CRUD + lifecycle
    skills.ts               # SkillsApi: attach/detach/list
    avatars.ts              # listPresetAvatars
    upload.ts               # presignUpload, putToPresigned, uploadRemoteImage
  auth/
    magic-auth.ts           # sendMagicCode, verifyMagicCode, selectWorkspace
    session-store.ts        # SessionStore interface + MemorySessionStore
    token-provider.ts       # TokenProvider, WorkOSSessionProvider, StaticTokenProvider
  utils/
    slug.ts                 # slugify
    upload-paths.ts         # buildModulePath
  tools/
    context.ts              # ToolContext (provider + apis) shared by handlers
    auth.ts                 # connect_diaflow, submit_code, auth_status
    read.ts                 # list_teammates, get_teammate
    write.ts                # create_teammate, update_teammate, check_teammate_name
    avatar.ts               # set_teammate_avatar, list_preset_avatars
    skills.ts               # list_teammate_skills, list_available_skills, attach_skill, detach_skill
    lifecycle.ts            # publish/offboard/rehire/delete_teammate
    workspace.ts            # set_workspace, list_workspaces
    register.ts             # registerAllTools(server, ctx)
  server.ts                 # buildServer(ctx): McpServer with all tools
  index.ts                  # entry: load config, choose transport (stdio|http)
tests/ (mirrors src/)
```

---

## Task 1: Repo scaffold + config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): AppConfig` where
  `AppConfig = { diaflowApiBase: string; transport: 'stdio' | 'http'; httpPort: number; publicUrl?: string; staticToken?: string; staticWorkspaceId?: number }`.

- [ ] **Step 1: Initialize the repo and install deps**

```bash
cd /Users/thongdang/Desktop/my-stuffs/diaflow-teammate-mcp
git init
npm init -y
npm pkg set type=module
npm install @modelcontextprotocol/sdk zod
npm install -D typescript tsx vitest @vitest/coverage-v8 @types/node
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Write `vitest.config.ts` and `.gitignore` and `.env.example`**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: { provider: "v8", reporter: ["text", "html"], include: ["src/**"] },
  },
});
```

`.gitignore`:
```
node_modules
dist
.env
coverage
```

`.env.example`:
```
DIAFLOW_API_BASE=https://api.diaflow.io
MCP_TRANSPORT=stdio
MCP_HTTP_PORT=8787
MCP_PUBLIC_URL=
# Inbound bearer token that callers (e.g. a Diaflow teammate via custom-MCP) must present on HTTP transport.
# This is the value you register as `key` when adding this server as a Diaflow custom MCP.
MCP_INBOUND_TOKEN=
# Optional StaticTokenProvider (non-interactive / service deployments): paste a Diaflow sealed session.
DIAFLOW_TOKEN=
DIAFLOW_WORKSPACE_ID=
```

- [ ] **Step 4: Add npm scripts**

```bash
npm pkg set scripts.dev="tsx src/index.ts"
npm pkg set scripts.build="tsc"
npm pkg set scripts.test="vitest run"
npm pkg set scripts.test:watch="vitest"
```

- [ ] **Step 5: Write the failing test**

`tests/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("parses a valid environment", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://api.diaflow.io", MCP_TRANSPORT: "stdio" } as any);
    expect(cfg.diaflowApiBase).toBe("https://api.diaflow.io");
    expect(cfg.transport).toBe("stdio");
    expect(cfg.httpPort).toBe(8787);
  });

  it("throws when DIAFLOW_API_BASE is missing", () => {
    expect(() => loadConfig({} as any)).toThrow();
  });

  it("defaults transport to stdio and coerces the port", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://x", MCP_HTTP_PORT: "9000" } as any);
    expect(cfg.transport).toBe("stdio");
    expect(cfg.httpPort).toBe(9000);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — cannot find module `../src/config.js`.

- [ ] **Step 7: Write `src/config.ts`**

```ts
import { z } from "zod";

const schema = z.object({
  DIAFLOW_API_BASE: z.string().url(),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(8787),
  MCP_PUBLIC_URL: z.string().url().optional(),
  MCP_INBOUND_TOKEN: z.string().optional(),
  DIAFLOW_TOKEN: z.string().optional(),
  DIAFLOW_WORKSPACE_ID: z.coerce.number().int().positive().optional(),
});

export interface AppConfig {
  diaflowApiBase: string;
  transport: "stdio" | "http";
  httpPort: number;
  publicUrl?: string;
  inboundToken?: string;
  staticToken?: string;
  staticWorkspaceId?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.parse(env);
  return {
    diaflowApiBase: parsed.DIAFLOW_API_BASE.replace(/\/+$/, ""),
    transport: parsed.MCP_TRANSPORT,
    httpPort: parsed.MCP_HTTP_PORT,
    publicUrl: parsed.MCP_PUBLIC_URL,
    inboundToken: parsed.MCP_INBOUND_TOKEN || undefined,
    staticToken: parsed.DIAFLOW_TOKEN || undefined,
    staticWorkspaceId: parsed.DIAFLOW_WORKSPACE_ID,
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test -- tests/config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold MCP project + config loader"
```

---

## Task 2: Diaflow errors + base HTTP client

**Files:**
- Create: `src/diaflow/errors.ts`, `src/diaflow/client.ts`
- Test: `tests/diaflow/client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class DiaflowHttpError extends Error { status: number; code?: string; detail?: unknown }`.
  - `interface DiaflowClientOptions { baseUrl: string; getToken: () => Promise<string | null>; getWorkspaceId: () => number | null; onRotate?: (seal: string) => void; fetchImpl?: typeof fetch }`.
  - `class DiaflowClient { request<T>(method: string, path: string, opts?: { query?: Record<string, string | number | undefined>; body?: unknown; workspaceId?: number | null }): Promise<T> }`.

- [ ] **Step 1: Write the failing test**

`tests/diaflow/client.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { DiaflowHttpError } from "../../src/diaflow/errors.js";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("DiaflowClient", () => {
  it("sends native headers, bearer token and workspace id; returns parsed JSON", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ total: 0, results: [] }));
    const client = new DiaflowClient({
      baseUrl: "https://api.diaflow.io",
      getToken: async () => "SEAL",
      getWorkspaceId: () => 1564,
      fetchImpl: fetchImpl as any,
    });

    const data = await client.request<{ total: number }>("GET", "/agents", { query: { page: 1, pageSize: 5 } });

    expect(data.total).toBe(0);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.diaflow.io/api/v1/agents?page=1&pageSize=5");
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get("x-client")).toBe("native");
    expect(headers.get("authorization")).toBe("Bearer SEAL");
    expect(headers.get("workspace-id")).toBe("1564");
    expect(headers.has("origin")).toBe(false);
  });

  it("captures a rotated seal from X-Diaflow-Session", async () => {
    const onRotate = vi.fn();
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true }, { headers: { "content-type": "application/json", "x-diaflow-session": "NEWSEAL" } }),
    );
    const client = new DiaflowClient({
      baseUrl: "https://x",
      getToken: async () => "OLD",
      getWorkspaceId: () => null,
      onRotate,
      fetchImpl: fetchImpl as any,
    });
    await client.request("GET", "/agents");
    expect(onRotate).toHaveBeenCalledWith("NEWSEAL");
  });

  it("throws DiaflowHttpError with code+message on 4xx", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ code: "permanent_delete_conflict", message: "must offboard first" }, { status: 409 }),
    );
    const client = new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: fetchImpl as any });
    await expect(client.request("DELETE", "/agents/abc/permanent")).rejects.toMatchObject({
      status: 409,
      code: "permanent_delete_conflict",
    } satisfies Partial<DiaflowHttpError>);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/diaflow/client.test.ts`
Expected: FAIL — cannot find `../../src/diaflow/client.js`.

- [ ] **Step 3: Write `src/diaflow/errors.ts`**

```ts
export class DiaflowHttpError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail?: unknown;

  constructor(status: number, message: string, opts: { code?: string; detail?: unknown } = {}) {
    super(message);
    this.name = "DiaflowHttpError";
    this.status = status;
    this.code = opts.code;
    this.detail = opts.detail;
  }
}
```

- [ ] **Step 4: Write `src/diaflow/client.ts`**

```ts
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

    const res = await this.fetchImpl(url.toString(), { method, headers, body });

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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/diaflow/client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: diaflow http client with native headers, rotation capture, error mapping"
```

---

## Task 3: Auth — magic-auth client

**Files:**
- Create: `src/diaflow/native-fetch.ts`, `src/auth/magic-auth.ts`
- Test: `tests/auth/magic-auth.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `nativePost<T>(baseUrl, path, body, opts?: { bearer?: string; fetchImpl?: typeof fetch }): Promise<{ data: T; rotated?: string }>`.
  - `sendMagicCode(baseUrl, email, fetchImpl?): Promise<void>`.
  - `verifyMagicCode(baseUrl, email, code, fetchImpl?): Promise<VerifyResult>` where `VerifyResult = { session: string; workspaceId: number | null; subdomain?: string }`.
  - `selectWorkspace(baseUrl, seal, workspaceId, fetchImpl?): Promise<{ session: string; workspaceId: number }>`.

- [ ] **Step 1: Write the failing test**

`tests/auth/magic-auth.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { sendMagicCode, verifyMagicCode, selectWorkspace } from "../../src/auth/magic-auth.js";

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("magic-auth", () => {
  it("sendMagicCode posts native headers with no Origin", async () => {
    const fetchImpl = vi.fn(async () => ok({ sent: true }));
    await sendMagicCode("https://x", "a@b.com", fetchImpl as any);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://x/api/v1/auth/magic-auth/send");
    const h = new Headers((init as RequestInit).headers);
    expect(h.get("x-client")).toBe("native");
    expect(h.has("origin")).toBe(false);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ email: "a@b.com" });
  });

  it("verifyMagicCode returns the seal from the `session` field", async () => {
    const fetchImpl = vi.fn(async () => ok({ session: "gAAAA_SEAL", accessToken: null, workspaceId: 1564, subdomain: "diaflow427" }));
    const r = await verifyMagicCode("https://x", "a@b.com", "123456", fetchImpl as any);
    expect(r).toEqual({ session: "gAAAA_SEAL", workspaceId: 1564, subdomain: "diaflow427" });
  });

  it("selectWorkspace sends the seal as bearer and returns the new seal", async () => {
    const fetchImpl = vi.fn(async () => ok({ session: "gAAAA_SEAL2", workspaceId: 999 }));
    const r = await selectWorkspace("https://x", "OLD", 999, fetchImpl as any);
    const [, init] = fetchImpl.mock.calls[0];
    const h = new Headers((init as RequestInit).headers);
    expect(h.get("authorization")).toBe("Bearer OLD");
    expect(r).toEqual({ session: "gAAAA_SEAL2", workspaceId: 999 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/auth/magic-auth.test.ts`
Expected: FAIL — cannot find `../../src/auth/magic-auth.js`.

- [ ] **Step 3: Write `src/diaflow/native-fetch.ts`**

```ts
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
```

- [ ] **Step 4: Write `src/auth/magic-auth.ts`**

```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/auth/magic-auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: headless magic-auth client (send/verify/select) returning session seal"
```

---

## Task 4: Session store + token provider

**Files:**
- Create: `src/auth/session-store.ts`, `src/auth/token-provider.ts`
- Test: `tests/auth/token-provider.test.ts`

**Interfaces:**
- Consumes: `sendMagicCode`, `verifyMagicCode`, `selectWorkspace` (Task 3).
- Produces:
  - `interface StoredSession { seal: string; workspaceId: number | null; email?: string }`.
  - `interface SessionStore { get(key: string): Promise<StoredSession | null>; set(key: string, s: StoredSession): Promise<void>; delete(key: string): Promise<void> }`.
  - `class MemorySessionStore implements SessionStore`.
  - `interface TokenProvider { getToken(): Promise<string | null>; getWorkspaceId(): number | null; onRotate(seal: string): void; isConnected(): Promise<boolean> }`.
  - `class WorkOSSessionProvider implements TokenProvider` with `startConnect(email: string): Promise<void>`, `completeConnect(email: string, code: string): Promise<{ workspaceId: number | null }>`, `setWorkspace(id: number): Promise<void>`.
  - `class StaticTokenProvider implements TokenProvider`.

- [ ] **Step 1: Write the failing test**

`tests/auth/token-provider.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { MemorySessionStore } from "../../src/auth/session-store.js";
import { WorkOSSessionProvider, StaticTokenProvider } from "../../src/auth/token-provider.js";
import * as magic from "../../src/auth/magic-auth.js";

describe("WorkOSSessionProvider", () => {
  it("completeConnect stores the seal and exposes it via getToken", async () => {
    vi.spyOn(magic, "verifyMagicCode").mockResolvedValue({ session: "SEAL1", workspaceId: 1564 });
    const store = new MemorySessionStore();
    const p = new WorkOSSessionProvider({ store, key: "default", baseUrl: "https://x" });

    const r = await p.completeConnect("a@b.com", "123456");
    expect(r.workspaceId).toBe(1564);
    expect(await p.getToken()).toBe("SEAL1");
    expect(p.getWorkspaceId()).toBe(1564);
    expect(await p.isConnected()).toBe(true);
  });

  it("onRotate replaces the stored seal", async () => {
    vi.spyOn(magic, "verifyMagicCode").mockResolvedValue({ session: "SEAL1", workspaceId: 1 });
    const store = new MemorySessionStore();
    const p = new WorkOSSessionProvider({ store, key: "default", baseUrl: "https://x" });
    await p.completeConnect("a@b.com", "1");
    p.onRotate("SEAL2");
    expect(await p.getToken()).toBe("SEAL2");
  });

  it("getToken is null before connecting", async () => {
    const p = new WorkOSSessionProvider({ store: new MemorySessionStore(), key: "default", baseUrl: "https://x" });
    expect(await p.getToken()).toBeNull();
    expect(await p.isConnected()).toBe(false);
  });
});

describe("StaticTokenProvider", () => {
  it("returns the configured seal and workspace", async () => {
    const p = new StaticTokenProvider("SEAL", 42);
    expect(await p.getToken()).toBe("SEAL");
    expect(p.getWorkspaceId()).toBe(42);
    expect(await p.isConnected()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/auth/token-provider.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Write `src/auth/session-store.ts`**

```ts
export interface StoredSession {
  seal: string;
  workspaceId: number | null;
  email?: string;
}

export interface SessionStore {
  get(key: string): Promise<StoredSession | null>;
  set(key: string, session: StoredSession): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, StoredSession>();

  async get(key: string): Promise<StoredSession | null> {
    return this.map.get(key) ?? null;
  }
  async set(key: string, session: StoredSession): Promise<void> {
    this.map.set(key, session);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}
```

- [ ] **Step 4: Write `src/auth/token-provider.ts`**

```ts
import type { SessionStore, StoredSession } from "./session-store.js";
import { sendMagicCode, verifyMagicCode, selectWorkspace } from "./magic-auth.js";

export interface TokenProvider {
  getToken(): Promise<string | null>;
  getWorkspaceId(): number | null;
  onRotate(seal: string): void;
  isConnected(): Promise<boolean>;
}

export interface WorkOSSessionProviderOptions {
  store: SessionStore;
  key: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class WorkOSSessionProvider implements TokenProvider {
  private cache: StoredSession | null = null;

  constructor(private readonly opts: WorkOSSessionProviderOptions) {}

  private async load(): Promise<StoredSession | null> {
    if (this.cache) return this.cache;
    this.cache = await this.opts.store.get(this.opts.key);
    return this.cache;
  }

  private async save(session: StoredSession): Promise<void> {
    this.cache = session;
    await this.opts.store.set(this.opts.key, session);
  }

  async startConnect(email: string): Promise<void> {
    await sendMagicCode(this.opts.baseUrl, email, this.opts.fetchImpl);
  }

  async completeConnect(email: string, code: string): Promise<{ workspaceId: number | null }> {
    const r = await verifyMagicCode(this.opts.baseUrl, email, code, this.opts.fetchImpl);
    await this.save({ seal: r.session, workspaceId: r.workspaceId, email });
    return { workspaceId: r.workspaceId };
  }

  async setWorkspace(workspaceId: number): Promise<void> {
    const current = await this.load();
    if (!current) throw new Error("not connected");
    const r = await selectWorkspace(this.opts.baseUrl, current.seal, workspaceId, this.opts.fetchImpl);
    await this.save({ ...current, seal: r.session, workspaceId: r.workspaceId });
  }

  async getToken(): Promise<string | null> {
    return (await this.load())?.seal ?? null;
  }

  getWorkspaceId(): number | null {
    return this.cache?.workspaceId ?? null;
  }

  onRotate(seal: string): void {
    if (!this.cache) return;
    void this.save({ ...this.cache, seal });
  }

  async isConnected(): Promise<boolean> {
    return (await this.load()) != null;
  }
}

export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly seal: string, private readonly workspaceId: number | null = null) {}
  async getToken(): Promise<string | null> {
    return this.seal;
  }
  getWorkspaceId(): number | null {
    return this.workspaceId;
  }
  onRotate(seal: string): void {
    (this as { seal: string }).seal = seal;
  }
  async isConnected(): Promise<boolean> {
    return true;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/auth/token-provider.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: session store + WorkOS/Static token providers with rotation"
```

---

## Task 5: Diaflow types + teammates read API

**Files:**
- Create: `src/diaflow/types.ts`, `src/diaflow/teammates.ts`
- Test: `tests/diaflow/teammates.test.ts`

**Interfaces:**
- Consumes: `DiaflowClient` (Task 2).
- Produces (`types.ts`):
  - `interface Agent { id: number; uniqueId: string; name?: string; title?: string; modelProvider?: string; modelName?: string; icon?: string; description?: string; intelligence?: string; tags?: string[]; status?: string; }`
  - `interface AgentDetail extends Agent { instruction?: string; welcomeMessage?: string; starterPrompts?: { title: string; prompt: string }[]; skills?: { id: number; uniqueId: string; name: string }[]; skillsCount?: number; subAgentsCount?: number; }`
  - `interface TeammatePage { total: number; results: Agent[] }`
  - `interface UpdateTeammateFields { name?: string; title?: string; modelProvider?: string; modelName?: string; modelConfig?: Record<string, unknown>; outputFormat?: string; icon?: string; description?: string; instruction?: string; welcomeMessage?: string; intelligence?: string; starterPrompts?: { title: string; prompt: string }[]; tags?: string[]; }`
  - `interface CreateTeammateFields extends UpdateTeammateFields { modelProvider: string; modelName: string }`
  - plus `PresignResponse`, `PresetAvatar`, `AgentSkillLink`, `AvailableSkill`, `SkillRef` (used by later tasks).
- Produces (`teammates.ts`): `class TeammatesApi { constructor(client: DiaflowClient); list(params): Promise<TeammatePage>; get(uniqueId: string): Promise<AgentDetail>; }` where `list` params = `{ page?: number; pageSize?: number; lifecycle?: "active" | "offboarded"; search?: string; filter?: string; orderBy?: string }`.

- [ ] **Step 1: Write the failing test**

`tests/diaflow/teammates.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { TeammatesApi } from "../../src/diaflow/teammates.js";

function client(fetchImpl: any) {
  return new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl });
}
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("TeammatesApi read", () => {
  it("list passes pagination + lifecycle", async () => {
    const fetchImpl = vi.fn(async () => ok({ total: 1, results: [{ id: 1, uniqueId: "u1", name: "A" }] }));
    const api = new TeammatesApi(client(fetchImpl));
    const page = await api.list({ page: 2, pageSize: 10, lifecycle: "offboarded" });
    expect(page.total).toBe(1);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toContain("/api/v1/agents?");
    expect(url).toContain("page=2");
    expect(url).toContain("pageSize=10");
    expect(url).toContain("lifecycle=offboarded");
  });

  it("get fetches by uniqueId", async () => {
    const fetchImpl = vi.fn(async () => ok({ id: 1, uniqueId: "u1", name: "A", instruction: "hi" }));
    const api = new TeammatesApi(client(fetchImpl));
    const t = await api.get("u1");
    expect(t.uniqueId).toBe("u1");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://x/api/v1/agents/u1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/diaflow/teammates.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Write `src/diaflow/types.ts`**

```ts
export interface StarterPrompt {
  title: string;
  prompt: string;
}

export interface Agent {
  id: number;
  uniqueId: string;
  name?: string;
  title?: string;
  modelProvider?: string;
  modelName?: string;
  icon?: string;
  description?: string;
  intelligence?: string;
  tags?: string[];
  status?: string;
}

export interface AgentSkillBrief {
  id: number;
  uniqueId: string;
  name: string;
}

export interface AgentDetail extends Agent {
  instruction?: string;
  welcomeMessage?: string;
  starterPrompts?: StarterPrompt[];
  skills?: AgentSkillBrief[];
  skillsCount?: number;
  subAgentsCount?: number;
}

export interface TeammatePage {
  total: number;
  results: Agent[];
}

export interface UpdateTeammateFields {
  name?: string;
  title?: string;
  modelProvider?: string;
  modelName?: string;
  modelConfig?: Record<string, unknown>;
  outputFormat?: string;
  icon?: string;
  description?: string;
  instruction?: string;
  welcomeMessage?: string;
  intelligence?: string;
  starterPrompts?: StarterPrompt[];
  tags?: string[];
}

export interface CreateTeammateFields extends UpdateTeammateFields {
  modelProvider: string;
  modelName: string;
}

export interface PresignResponse {
  uploadUrl: string;
  key: string;
  url: string;
}

export interface PresetAvatar {
  url: string;
  category?: string;
}

export interface AgentSkillLink {
  id: number;
  uniqueId?: string;
  name: string;
  source?: string;
}

export interface AvailableSkill {
  id: number;
  uniqueId?: string;
  name: string;
  source?: string;
  isAttached?: boolean;
}

export interface SkillRef {
  skillWorkspaceId?: number;
  skillSystemId?: number;
  skillUserId?: number;
}
```

- [ ] **Step 4: Write `src/diaflow/teammates.ts` (read methods only for now)**

```ts
import type { DiaflowClient } from "./client.js";
import type { AgentDetail, TeammatePage } from "./types.js";

export interface ListParams {
  page?: number;
  pageSize?: number;
  lifecycle?: "active" | "offboarded";
  search?: string;
  filter?: string;
  orderBy?: string;
}

export class TeammatesApi {
  constructor(private readonly client: DiaflowClient) {}

  list(params: ListParams = {}): Promise<TeammatePage> {
    return this.client.request<TeammatePage>("GET", "/agents", {
      query: {
        page: params.page ?? 1,
        pageSize: params.pageSize ?? 20,
        lifecycle: params.lifecycle,
        search: params.search,
        filter: params.filter,
        orderBy: params.orderBy,
      },
    });
  }

  get(uniqueId: string): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("GET", `/agents/${encodeURIComponent(uniqueId)}`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/diaflow/teammates.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: diaflow types + teammates read API (list/get)"
```

---

## Task 6: Tool context + MCP server + auth & read tools (stdio)

**Files:**
- Create: `src/tools/context.ts`, `src/tools/auth.ts`, `src/tools/read.ts`, `src/tools/register.ts`, `src/server.ts`, `src/index.ts`
- Test: `tests/tools/read.test.ts`, `tests/tools/auth.test.ts`

**Interfaces:**
- Consumes: `WorkOSSessionProvider`/`StaticTokenProvider` (Task 4), `DiaflowClient` (Task 2), `TeammatesApi` (Task 5).
- Produces:
  - `interface ToolContext { provider: TokenProvider; client: DiaflowClient; teammates: TeammatesApi; baseUrl: string; }`
  - `function buildContext(cfg: AppConfig): ToolContext`
  - `function registerAllTools(server: McpServer, ctx: ToolContext): void`
  - `function buildServer(ctx: ToolContext): McpServer`
  - Tools: `connect_diaflow`, `submit_code`, `auth_status`, `list_teammates`, `get_teammate`.

- [ ] **Step 1: Write the failing test for read tools**

`tests/tools/read.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/tools/read.test.ts`
Expected: FAIL — cannot find `../../src/tools/read.js`.

- [ ] **Step 3: Write `src/tools/context.ts`**

```ts
import type { AppConfig } from "../config.js";
import { DiaflowClient } from "../diaflow/client.js";
import { TeammatesApi } from "../diaflow/teammates.js";
import { MemorySessionStore } from "../auth/session-store.js";
import { WorkOSSessionProvider, StaticTokenProvider, type TokenProvider } from "../auth/token-provider.js";

export interface ToolContext {
  provider: TokenProvider;
  client: DiaflowClient;
  teammates: TeammatesApi;
  baseUrl: string;
}

export function buildContext(cfg: AppConfig): ToolContext {
  const provider: TokenProvider = cfg.staticToken
    ? new StaticTokenProvider(cfg.staticToken, cfg.staticWorkspaceId ?? null)
    : new WorkOSSessionProvider({ store: new MemorySessionStore(), key: "default", baseUrl: cfg.diaflowApiBase });

  const client = new DiaflowClient({
    baseUrl: cfg.diaflowApiBase,
    getToken: () => provider.getToken(),
    getWorkspaceId: () => provider.getWorkspaceId(),
    onRotate: (seal) => provider.onRotate(seal),
  });

  return { provider, client, teammates: new TeammatesApi(client), baseUrl: cfg.diaflowApiBase };
}
```

- [ ] **Step 4: Write `src/tools/read.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function registerReadTools(server: McpServer, ctx: Pick<ToolContext, "teammates">): void {
  server.registerTool(
    "list_teammates",
    {
      description: "List Diaflow teammates in the active workspace.",
      inputSchema: {
        page: z.number().int().positive().optional(),
        pageSize: z.number().int().positive().max(200).optional(),
        lifecycle: z.enum(["active", "offboarded"]).optional(),
        search: z.string().optional(),
        orderBy: z.string().optional(),
      },
    },
    async (args) => {
      const page = await ctx.teammates.list({
        page: args.page,
        pageSize: args.pageSize,
        lifecycle: args.lifecycle,
        search: args.search,
        orderBy: args.orderBy,
      });
      return asText(page);
    },
  );

  server.registerTool(
    "get_teammate",
    {
      description: "Get full detail for a single teammate by its uniqueId.",
      inputSchema: { teammateId: z.string().min(1) },
    },
    async (args) => asText(await ctx.teammates.get(args.teammateId)),
  );
}
```

- [ ] **Step 5: Run read-tools test to verify it passes**

Run: `npm test -- tests/tools/read.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Write the failing test for auth tools**

`tests/tools/auth.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { registerAuthTools } from "../../src/tools/auth.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("auth tools", () => {
  it("connect_diaflow starts the magic-auth flow", async () => {
    const provider = { startConnect: vi.fn(async () => {}), isConnected: vi.fn(async () => false) };
    const { server, tools } = fakeServer();
    registerAuthTools(server as any, { provider } as any);
    const res = await tools["connect_diaflow"]({ email: "a@b.com" });
    expect(provider.startConnect).toHaveBeenCalledWith("a@b.com");
    expect(res.content[0].text.toLowerCase()).toContain("code");
  });

  it("submit_code completes the flow", async () => {
    const provider = { completeConnect: vi.fn(async () => ({ workspaceId: 1564 })) };
    const { server, tools } = fakeServer();
    registerAuthTools(server as any, { provider } as any);
    const res = await tools["submit_code"]({ email: "a@b.com", code: "123456" });
    expect(provider.completeConnect).toHaveBeenCalledWith("a@b.com", "123456");
    expect(res.content[0].text).toContain("1564");
  });
});
```

- [ ] **Step 7: Run auth-tools test to verify it fails**

Run: `npm test -- tests/tools/auth.test.ts`
Expected: FAIL — cannot find `../../src/tools/auth.js`.

- [ ] **Step 8: Write `src/tools/auth.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkOSSessionProvider } from "../auth/token-provider.js";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

export function registerAuthTools(server: McpServer, ctx: { provider: WorkOSSessionProvider }): void {
  server.registerTool(
    "connect_diaflow",
    {
      description: "Begin Diaflow login: emails a magic code to the given address. Then call submit_code with the code.",
      inputSchema: { email: z.string().email() },
    },
    async (args) => {
      await ctx.provider.startConnect(args.email);
      return text(`A login code was emailed to ${args.email}. Call submit_code with { email, code } to finish connecting.`);
    },
  );

  server.registerTool(
    "submit_code",
    {
      description: "Finish Diaflow login with the emailed magic code.",
      inputSchema: { email: z.string().email(), code: z.string().min(4) },
    },
    async (args) => {
      const r = await ctx.provider.completeConnect(args.email, args.code);
      return text(`Connected to Diaflow. Active workspace: ${r.workspaceId ?? "(none — call set_workspace)"}.`);
    },
  );

  server.registerTool(
    "auth_status",
    {
      description: "Report whether the MCP is connected to Diaflow and which workspace is active.",
      inputSchema: {},
    },
    async () => {
      const connected = await ctx.provider.isConnected();
      return text(connected ? `Connected. Workspace: ${ctx.provider.getWorkspaceId() ?? "(none)"}.` : "Not connected. Call connect_diaflow.");
    },
  );
}
```

- [ ] **Step 9: Run auth-tools test to verify it passes**

Run: `npm test -- tests/tools/auth.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 10: Write `src/tools/register.ts`, `src/server.ts`, `src/index.ts`**

`src/tools/register.ts`:
```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { registerAuthTools } from "./auth.js";
import { registerReadTools } from "./read.js";
import { WorkOSSessionProvider } from "../auth/token-provider.js";

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  // connect/submit_code require the WorkOS provider; register them only then.
  if (ctx.provider instanceof WorkOSSessionProvider) {
    registerAuthTools(server, { provider: ctx.provider });
  }
  registerReadTools(server, ctx);
}
```

`src/server.ts`:
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./tools/context.js";
import { registerAllTools } from "./tools/register.js";

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "diaflow-teammate-mcp", version: "0.1.0" });
  registerAllTools(server, ctx);
  return server;
}
```

`src/index.ts`:
```ts
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
```

- [ ] **Step 11: Verify typecheck/build**

Run: `npm run build`
Expected: `tsc` completes with no errors.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: MCP server (stdio) with connect/submit_code/auth_status + list/get teammate tools"
```

---

## Task 7: Teammates write API + write tools

**Files:**
- Modify: `src/diaflow/teammates.ts` (add write methods + top-level type imports)
- Create: `src/tools/write.ts`
- Modify: `src/tools/register.ts` (register write tools)
- Test: `tests/diaflow/teammates-write.test.ts`, `tests/tools/write.test.ts`

**Interfaces:**
- Consumes: `DiaflowClient`, `CreateTeammateFields`, `UpdateTeammateFields`, `AgentDetail`.
- Produces (added to `TeammatesApi`):
  - `create(fields: CreateTeammateFields): Promise<AgentDetail>` → `POST /agents`.
  - `update(uniqueId: string, fields: UpdateTeammateFields): Promise<AgentDetail>` → `PATCH /agents/{id}` with body `{ main: fields }`.
  - `checkName(name: string): Promise<{ isDuplicate: boolean }>` → `POST /agents/check-name`.
- Produces tools: `create_teammate`, `update_teammate`, `check_teammate_name`.

- [ ] **Step 1: Write the failing API test**

`tests/diaflow/teammates-write.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { TeammatesApi } from "../../src/diaflow/teammates.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("TeammatesApi write", () => {
  it("create posts the fields", async () => {
    const f = vi.fn(async () => ok({ id: 1, uniqueId: "u1", name: "A" }, 201));
    const api = new TeammatesApi(client(f));
    await api.create({ modelProvider: "openai", modelName: "gpt-4", name: "A" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ modelProvider: "openai", modelName: "gpt-4", name: "A" });
  });

  it("update wraps fields under `main`", async () => {
    const f = vi.fn(async () => ok({ id: 1, uniqueId: "u1", name: "B" }));
    const api = new TeammatesApi(client(f));
    await api.update("u1", { name: "B", icon: "agent-teammate-icons/02-07-26/u1_a.png" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/u1");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ main: { name: "B", icon: "agent-teammate-icons/02-07-26/u1_a.png" } });
  });

  it("checkName posts the name", async () => {
    const f = vi.fn(async () => ok({ isDuplicate: true }));
    const api = new TeammatesApi(client(f));
    const r = await api.checkName("A");
    expect(r.isDuplicate).toBe(true);
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/check-name");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/diaflow/teammates-write.test.ts`
Expected: FAIL — `create`/`update`/`checkName` are not functions.

- [ ] **Step 3: Add write methods to `src/diaflow/teammates.ts`**

Change the top import line to include the write types:
```ts
import type { AgentDetail, TeammatePage, CreateTeammateFields, UpdateTeammateFields } from "./types.js";
```
Add these methods inside the `TeammatesApi` class:
```ts
  create(fields: CreateTeammateFields): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("POST", "/agents", { body: fields });
  }

  update(uniqueId: string, fields: UpdateTeammateFields): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("PATCH", `/agents/${encodeURIComponent(uniqueId)}`, { body: { main: fields } });
  }

  checkName(name: string): Promise<{ isDuplicate: boolean }> {
    return this.client.request<{ isDuplicate: boolean }>("POST", "/agents/check-name", { body: { name } });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/diaflow/teammates-write.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing write-tools test**

`tests/tools/write.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { registerWriteTools } from "../../src/tools/write.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("write tools", () => {
  it("create_teammate calls the api", async () => {
    const teammates = { create: vi.fn(async () => ({ id: 1, uniqueId: "u1", name: "A" })) };
    const { server, tools } = fakeServer();
    registerWriteTools(server as any, { teammates } as any);
    const res = await tools["create_teammate"]({ modelProvider: "openai", modelName: "gpt-4", name: "A" });
    expect(teammates.create).toHaveBeenCalledWith(expect.objectContaining({ modelProvider: "openai", modelName: "gpt-4", name: "A" }));
    expect(res.content[0].text).toContain("u1");
  });

  it("update_teammate strips teammateId out of the fields", async () => {
    const teammates = { update: vi.fn(async () => ({ id: 1, uniqueId: "u1", name: "B" })) };
    const { server, tools } = fakeServer();
    registerWriteTools(server as any, { teammates } as any);
    await tools["update_teammate"]({ teammateId: "u1", name: "B" });
    expect(teammates.update).toHaveBeenCalledWith("u1", { name: "B" });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- tests/tools/write.test.ts`
Expected: FAIL — cannot find `../../src/tools/write.js`.

- [ ] **Step 7: Write `src/tools/write.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const starterPrompt = z.object({ title: z.string(), prompt: z.string() });

export function registerWriteTools(server: McpServer, ctx: Pick<ToolContext, "teammates">): void {
  server.registerTool(
    "create_teammate",
    {
      description: "Create a new teammate. modelProvider and modelName are required.",
      inputSchema: {
        modelProvider: z.string().min(1),
        modelName: z.string().min(1),
        name: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        instruction: z.string().optional(),
        welcomeMessage: z.string().optional(),
        intelligence: z.string().optional(),
        starterPrompts: z.array(starterPrompt).optional(),
        tags: z.array(z.string()).optional(),
        icon: z.string().optional(),
      },
    },
    async (args) => asText(await ctx.teammates.create(args)),
  );

  server.registerTool(
    "update_teammate",
    {
      description: "Update a teammate's fields (name, model, description, instruction, tags, icon, ...).",
      inputSchema: {
        teammateId: z.string().min(1),
        name: z.string().optional(),
        title: z.string().optional(),
        modelProvider: z.string().optional(),
        modelName: z.string().optional(),
        outputFormat: z.string().optional(),
        description: z.string().optional(),
        instruction: z.string().optional(),
        welcomeMessage: z.string().optional(),
        intelligence: z.string().optional(),
        starterPrompts: z.array(starterPrompt).optional(),
        tags: z.array(z.string()).optional(),
        icon: z.string().optional(),
      },
    },
    async (args) => {
      const { teammateId, ...fields } = args;
      return asText(await ctx.teammates.update(teammateId, fields));
    },
  );

  server.registerTool(
    "check_teammate_name",
    {
      description: "Check whether a teammate name is already taken in the workspace.",
      inputSchema: { name: z.string().min(1) },
    },
    async (args) => asText(await ctx.teammates.checkName(args.name)),
  );
}
```

- [ ] **Step 8: Register write tools in `src/tools/register.ts`**

Add `import { registerWriteTools } from "./write.js";` and call `registerWriteTools(server, ctx);` inside `registerAllTools` (after `registerReadTools`).

- [ ] **Step 9: Run tests + build to verify**

Run: `npm test -- tests/tools/write.test.ts` → PASS (2 tests).
Run: `npm run build` → no errors.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: teammate create/update/check-name API + write tools"
```

---

## Task 8: Upload utilities (slug, paths) + presign/PUT/remote-image

**Files:**
- Create: `src/utils/slug.ts`, `src/utils/upload-paths.ts`, `src/diaflow/upload.ts`
- Test: `tests/utils/upload-paths.test.ts`, `tests/diaflow/upload.test.ts`

**Interfaces:**
- Consumes: `DiaflowClient`, `PresignResponse`.
- Produces:
  - `slugify(input: string): string`.
  - `buildModulePath(folder: string, date: Date): string` → `"<folder>/<dd-mm-yy>"`.
  - `presignUpload(client, params: { name: string; type: string; folder: string; fileSize?: number }): Promise<PresignResponse>` → `POST /drives/s3/presigned` body `{ name, type, folder, file_size }`.
  - `putToPresigned(uploadUrl: string, bytes: ArrayBuffer | Uint8Array, contentType: string, fetchImpl?: typeof fetch): Promise<void>`.
  - `uploadRemoteImage(client, params: { teammateId: string; imageUrl: string; date: Date; fetchImpl?: typeof fetch; maxBytes?: number }): Promise<{ key: string; url: string }>`.

- [ ] **Step 1: Write the failing utils test**

`tests/utils/upload-paths.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { slugify } from "../../src/utils/slug.js";
import { buildModulePath } from "../../src/utils/upload-paths.js";

describe("upload utils", () => {
  it("slugify lowercases and hyphenates", () => {
    expect(slugify("My Avatar (v2).PNG")).toBe("my-avatar-v2-.png");
  });

  it("buildModulePath formats dd-mm-yy", () => {
    const d = new Date(Date.UTC(2026, 6, 2)); // 2 Jul 2026
    expect(buildModulePath("agent-teammate-icons", d)).toBe("agent-teammate-icons/02-07-26");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/utils/upload-paths.test.ts`
Expected: FAIL — cannot find modules.

- [ ] **Step 3: Write `src/utils/slug.ts`**

```ts
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
```

- [ ] **Step 4: Write `src/utils/upload-paths.ts`**

```ts
export function buildModulePath(folder: string, date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(date.getUTCFullYear()).slice(-2);
  return `${folder}/${dd}-${mm}-${yy}`;
}
```

- [ ] **Step 5: Run utils test to verify it passes**

Run: `npm test -- tests/utils/upload-paths.test.ts`
Expected: PASS (2 tests). (If `slugify("My Avatar (v2).PNG")` produces a different exact string, run it once, read the actual value, and lock the assertion to that value — the intent is lowercase + hyphenated + preserved extension.)

- [ ] **Step 6: Write the failing upload test**

`tests/diaflow/upload.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { presignUpload, putToPresigned, uploadRemoteImage } from "../../src/diaflow/upload.js";

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("upload", () => {
  it("presignUpload posts snake_case file_size", async () => {
    const f = vi.fn(async () => ok({ uploadUrl: "https://s3/put", key: "k", url: "https://cdn/k" }));
    const r = await presignUpload(client(f), { name: "u1_a.png", type: "image/png", folder: "agent-teammate-icons/02-07-26", fileSize: 10 });
    expect(r.key).toBe("k");
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ name: "u1_a.png", type: "image/png", folder: "agent-teammate-icons/02-07-26", file_size: 10 });
  });

  it("putToPresigned PUTs bytes with Content-Type and no auth header", async () => {
    const f = vi.fn(async () => new Response(null, { status: 200 }));
    await putToPresigned("https://s3/put", new Uint8Array([1, 2, 3]), "image/png", f as any);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://s3/put");
    expect((init as RequestInit).method).toBe("PUT");
    const h = new Headers((init as RequestInit).headers);
    expect(h.get("content-type")).toBe("image/png");
    expect(h.has("authorization")).toBe(false);
  });

  it("putToPresigned throws on non-2xx", async () => {
    const f = vi.fn(async () => new Response("denied", { status: 403 }));
    await expect(putToPresigned("https://s3/put", new Uint8Array([1]), "image/png", f as any)).rejects.toThrow();
  });

  it("uploadRemoteImage downloads, presigns, PUTs, returns key", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const f = vi.fn(async (url: string) => {
      if (url === "https://remote/a.png") return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
      if (url.endsWith("/drives/s3/presigned")) return ok({ uploadUrl: "https://s3/put", key: "agent-teammate-icons/02-07-26/u1_a.png", url: "https://cdn/k" });
      if (url === "https://s3/put") return new Response(null, { status: 200 });
      throw new Error("unexpected " + url);
    });
    const r = await uploadRemoteImage(client(f), { teammateId: "u1", imageUrl: "https://remote/a.png", date: new Date(Date.UTC(2026, 6, 2)), fetchImpl: f as any });
    expect(r.key).toBe("agent-teammate-icons/02-07-26/u1_a.png");
  });

  it("uploadRemoteImage rejects images over the size cap", async () => {
    const big = new Uint8Array(11 * 1024 * 1024);
    const f = vi.fn(async () => new Response(big, { status: 200, headers: { "content-type": "image/png" } }));
    await expect(
      uploadRemoteImage(client(f), { teammateId: "u1", imageUrl: "https://remote/big.png", date: new Date(), fetchImpl: f as any }),
    ).rejects.toThrow(/size/i);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `npm test -- tests/diaflow/upload.test.ts`
Expected: FAIL — cannot find `../../src/diaflow/upload.js`.

- [ ] **Step 8: Write `src/diaflow/upload.ts`**

```ts
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
```

- [ ] **Step 9: Run test to verify it passes**

Run: `npm test -- tests/diaflow/upload.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: S3 presign + PUT + uploadRemoteImage (teammate avatar flow)"
```

---

## Task 9: Avatars API + avatar tools

**Files:**
- Create: `src/diaflow/avatars.ts`, `src/tools/avatar.ts`
- Modify: `src/tools/register.ts`
- Test: `tests/diaflow/avatars.test.ts`, `tests/tools/avatar.test.ts`

**Interfaces:**
- Consumes: `DiaflowClient`, `TeammatesApi.update`, `uploadRemoteImage`, `PresetAvatar`.
- Produces:
  - `listPresetAvatars(client, category?: string): Promise<PresetAvatar[]>` → `GET /avatars` returns `{ results: PresetAvatar[] }`.
  - Tools: `list_preset_avatars`, `set_teammate_avatar`.
  - `set_teammate_avatar({ teammateId, imageUrl })`: if `imageUrl` host matches a Diaflow CDN/preset host → set `icon = imageUrl` directly; else `uploadRemoteImage` then set `icon = key`. Then `PATCH /agents/{id}` `{ main: { icon } }`.

- [ ] **Step 1: Write the failing avatars API test**

`tests/diaflow/avatars.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { listPresetAvatars } from "../../src/diaflow/avatars.js";

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("avatars", () => {
  it("listPresetAvatars returns results", async () => {
    const f = vi.fn(async () => ok({ results: [{ url: "https://cdn/a.png", category: "robots" }] }));
    const client = new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f as any });
    const r = await listPresetAvatars(client);
    expect(r).toEqual([{ url: "https://cdn/a.png", category: "robots" }]);
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/avatars");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/diaflow/avatars.test.ts`
Expected: FAIL — cannot find `../../src/diaflow/avatars.js`.

- [ ] **Step 3: Write `src/diaflow/avatars.ts`**

```ts
import type { DiaflowClient } from "./client.js";
import type { PresetAvatar } from "./types.js";

export async function listPresetAvatars(client: DiaflowClient, category?: string): Promise<PresetAvatar[]> {
  const res = await client.request<{ results: PresetAvatar[] }>("GET", "/avatars", {
    query: { category },
  });
  return res.results ?? [];
}
```

- [ ] **Step 4: Run avatars API test to verify it passes**

Run: `npm test -- tests/diaflow/avatars.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Write the failing avatar-tools test**

`tests/tools/avatar.test.ts`:
```ts
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
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- tests/tools/avatar.test.ts`
Expected: FAIL — cannot find `../../src/tools/avatar.js`.

- [ ] **Step 7: Write `src/tools/avatar.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiaflowClient } from "../diaflow/client.js";
import type { TeammatesApi } from "../diaflow/teammates.js";
import { listPresetAvatars } from "../diaflow/avatars.js";
import { uploadRemoteImage as defaultUpload } from "../diaflow/upload.js";

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
      inputSchema: { teammateId: z.string().min(1), imageUrl: z.string().url() },
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
```

- [ ] **Step 8: Run avatar-tools test to verify it passes**

Run: `npm test -- tests/tools/avatar.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Register avatar tools**

In `src/tools/register.ts` add `import { registerAvatarTools } from "./avatar.js";` and call
`registerAvatarTools(server, { teammates: ctx.teammates, client: ctx.client, presetHosts: [new URL(ctx.baseUrl).host] });`
(The preset host list should include the Diaflow CDN host; start with the API host and refine once the real CDN host is confirmed — see spec §9 open question #4.)

- [ ] **Step 10: Build + full test run**

Run: `npm run build` → no errors.
Run: `npm test` → all suites PASS.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: avatar tools (preset list + set_teammate_avatar via presign upload)"
```

---

## Task 10: Skills API + skills tools

**Files:**
- Create: `src/diaflow/skills.ts`, `src/tools/skills.ts`
- Modify: `src/tools/context.ts` (add `skills` to context), `src/tools/register.ts`
- Test: `tests/diaflow/skills.test.ts`, `tests/tools/skills.test.ts`

**Interfaces:**
- Consumes: `DiaflowClient`, `AgentSkillLink`, `AvailableSkill`, `SkillRef`.
- Produces:
  - `class SkillsApi { constructor(client); listAttached(uniqueId): Promise<AgentSkillLink[]>; listAvailable(uniqueId): Promise<AvailableSkill[]>; attach(uniqueId, ref: SkillRef): Promise<unknown>; detach(uniqueId, ref: SkillRef): Promise<void>; }`
    - listAttached → `GET /agents/{id}/skill-agents`
    - listAvailable → `GET /agents/{id}/skill-agents/available`
    - attach → `POST /agents/{id}/skill-agents/attach` body = the SkillRef
    - detach → `DELETE /agents/{id}/skill-agents` with query = the SkillRef
  - Tools: `list_teammate_skills`, `list_available_skills`, `attach_skill`, `detach_skill`.

- [ ] **Step 1: Write the failing skills API test**

`tests/diaflow/skills.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { SkillsApi } from "../../src/diaflow/skills.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("SkillsApi", () => {
  it("attach posts the skill ref body", async () => {
    const f = vi.fn(async () => ok({ ok: true }, 201));
    await new SkillsApi(client(f)).attach("u1", { skillWorkspaceId: 5 });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/u1/skill-agents/attach");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ skillWorkspaceId: 5 });
  });

  it("detach deletes with the ref as query", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    await new SkillsApi(client(f)).detach("u1", { skillSystemId: 9 });
    const [url, init] = f.mock.calls[0];
    expect((init as RequestInit).method).toBe("DELETE");
    expect(url).toBe("https://x/api/v1/agents/u1/skill-agents?skillSystemId=9");
  });

  it("listAttached returns the array", async () => {
    const f = vi.fn(async () => ok([{ id: 1, name: "S" }]));
    const r = await new SkillsApi(client(f)).listAttached("u1");
    expect(r).toHaveLength(1);
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/u1/skill-agents");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/diaflow/skills.test.ts`
Expected: FAIL — cannot find `../../src/diaflow/skills.js`.

- [ ] **Step 3: Write `src/diaflow/skills.ts`**

```ts
import type { DiaflowClient } from "./client.js";
import type { AgentSkillLink, AvailableSkill, SkillRef } from "./types.js";

function refToQuery(ref: SkillRef): Record<string, number | undefined> {
  return { skillWorkspaceId: ref.skillWorkspaceId, skillSystemId: ref.skillSystemId, skillUserId: ref.skillUserId };
}

export class SkillsApi {
  constructor(private readonly client: DiaflowClient) {}

  listAttached(uniqueId: string): Promise<AgentSkillLink[]> {
    return this.client.request<AgentSkillLink[]>("GET", `/agents/${encodeURIComponent(uniqueId)}/skill-agents`);
  }

  listAvailable(uniqueId: string): Promise<AvailableSkill[]> {
    return this.client.request<AvailableSkill[]>("GET", `/agents/${encodeURIComponent(uniqueId)}/skill-agents/available`);
  }

  attach(uniqueId: string, ref: SkillRef): Promise<unknown> {
    return this.client.request<unknown>("POST", `/agents/${encodeURIComponent(uniqueId)}/skill-agents/attach`, { body: ref });
  }

  detach(uniqueId: string, ref: SkillRef): Promise<void> {
    return this.client.request<void>("DELETE", `/agents/${encodeURIComponent(uniqueId)}/skill-agents`, { query: refToQuery(ref) });
  }
}
```

- [ ] **Step 4: Run skills API test to verify it passes**

Run: `npm test -- tests/diaflow/skills.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing skills-tools test**

`tests/tools/skills.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { registerSkillTools } from "../../src/tools/skills.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("skill tools", () => {
  it("attach_skill forwards exactly one id", async () => {
    const skills = { attach: vi.fn(async () => ({ ok: true })) };
    const { server, tools } = fakeServer();
    registerSkillTools(server as any, { skills } as any);
    await tools["attach_skill"]({ teammateId: "u1", skillWorkspaceId: 5 });
    expect(skills.attach).toHaveBeenCalledWith("u1", { skillWorkspaceId: 5, skillSystemId: undefined, skillUserId: undefined });
  });

  it("attach_skill rejects when no id is given", async () => {
    const skills = { attach: vi.fn() };
    const { server, tools } = fakeServer();
    registerSkillTools(server as any, { skills } as any);
    const res = await tools["attach_skill"]({ teammateId: "u1" });
    expect(res.isError).toBe(true);
    expect(skills.attach).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- tests/tools/skills.test.ts`
Expected: FAIL — cannot find `../../src/tools/skills.js`.

- [ ] **Step 7: Write `src/tools/skills.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillsApi } from "../diaflow/skills.js";
import type { SkillRef } from "../diaflow/types.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const errText = (msg: string) => ({ isError: true as const, content: [{ type: "text" as const, text: msg }] });

const refShape = {
  skillWorkspaceId: z.number().int().positive().optional(),
  skillSystemId: z.number().int().positive().optional(),
  skillUserId: z.number().int().positive().optional(),
};

function toRef(args: { skillWorkspaceId?: number; skillSystemId?: number; skillUserId?: number }): SkillRef | null {
  const provided = [args.skillWorkspaceId, args.skillSystemId, args.skillUserId].filter((v) => v !== undefined);
  if (provided.length !== 1) return null;
  return { skillWorkspaceId: args.skillWorkspaceId, skillSystemId: args.skillSystemId, skillUserId: args.skillUserId };
}

export function registerSkillTools(server: McpServer, ctx: { skills: SkillsApi }): void {
  server.registerTool(
    "list_teammate_skills",
    { description: "List skills attached to a teammate.", inputSchema: { teammateId: z.string().min(1) } },
    async (args) => asText(await ctx.skills.listAttached(args.teammateId)),
  );

  server.registerTool(
    "list_available_skills",
    { description: "List skills that can be attached to a teammate.", inputSchema: { teammateId: z.string().min(1) } },
    async (args) => asText(await ctx.skills.listAvailable(args.teammateId)),
  );

  server.registerTool(
    "attach_skill",
    { description: "Attach a skill to a teammate. Provide exactly one of skillWorkspaceId / skillSystemId / skillUserId.", inputSchema: { teammateId: z.string().min(1), ...refShape } },
    async (args) => {
      const ref = toRef(args);
      if (!ref) return errText("Provide exactly one of skillWorkspaceId, skillSystemId, skillUserId.");
      return asText(await ctx.skills.attach(args.teammateId, ref));
    },
  );

  server.registerTool(
    "detach_skill",
    { description: "Detach a skill from a teammate. Provide exactly one of skillWorkspaceId / skillSystemId / skillUserId.", inputSchema: { teammateId: z.string().min(1), ...refShape } },
    async (args) => {
      const ref = toRef(args);
      if (!ref) return errText("Provide exactly one of skillWorkspaceId, skillSystemId, skillUserId.");
      await ctx.skills.detach(args.teammateId, ref);
      return asText({ detached: true });
    },
  );
}
```

- [ ] **Step 8: Run skills-tools test to verify it passes**

Run: `npm test -- tests/tools/skills.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Wire SkillsApi into context + register**

In `src/tools/context.ts`: `import { SkillsApi } from "../diaflow/skills.js";`, add `skills: SkillsApi;` to `ToolContext`, and set `skills: new SkillsApi(client)` in the returned object.
In `src/tools/register.ts`: `import { registerSkillTools } from "./skills.js";` and call `registerSkillTools(server, { skills: ctx.skills });`.

- [ ] **Step 10: Build + full test**

Run: `npm run build` → no errors.
Run: `npm test` → all PASS.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: skills attach/detach/list API + tools"
```

---

## Task 11: Lifecycle API + lifecycle tools

**Files:**
- Modify: `src/diaflow/teammates.ts` (add lifecycle methods)
- Create: `src/tools/lifecycle.ts`
- Modify: `src/tools/register.ts`
- Test: `tests/diaflow/teammates-lifecycle.test.ts`, `tests/tools/lifecycle.test.ts`

**Interfaces:**
- Consumes: `DiaflowClient`, `AgentDetail`, `DiaflowHttpError`.
- Produces (added to `TeammatesApi`):
  - `publish(uniqueId): Promise<AgentDetail>` → `POST /agents/{id}/publish`
  - `offboard(uniqueId): Promise<AgentDetail>` → `POST /agents/{id}/offboard`
  - `rehire(uniqueId): Promise<AgentDetail>` → `POST /agents/{id}/rehire`
  - `permanentDelete(uniqueId): Promise<void>` → `DELETE /agents/{id}/permanent`
- Produces tools: `publish_teammate`, `offboard_teammate`, `rehire_teammate`, `delete_teammate` (with `force` → offboard-then-delete on `permanent_delete_conflict`).

- [ ] **Step 1: Write the failing lifecycle API test**

`tests/diaflow/teammates-lifecycle.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { TeammatesApi } from "../../src/diaflow/teammates.js";

const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("TeammatesApi lifecycle", () => {
  it("offboard posts to /offboard", async () => {
    const f = vi.fn(async () => ok({ uniqueId: "u1", status: "offboarded" }));
    await new TeammatesApi(client(f)).offboard("u1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/u1/offboard");
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("permanentDelete deletes /permanent and tolerates 204", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    await new TeammatesApi(client(f)).permanentDelete("u1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/u1/permanent");
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/diaflow/teammates-lifecycle.test.ts`
Expected: FAIL — methods not functions.

- [ ] **Step 3: Add lifecycle methods to `src/diaflow/teammates.ts`**

Add inside the `TeammatesApi` class:
```ts
  publish(uniqueId: string): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("POST", `/agents/${encodeURIComponent(uniqueId)}/publish`);
  }
  offboard(uniqueId: string): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("POST", `/agents/${encodeURIComponent(uniqueId)}/offboard`);
  }
  rehire(uniqueId: string): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("POST", `/agents/${encodeURIComponent(uniqueId)}/rehire`);
  }
  permanentDelete(uniqueId: string): Promise<void> {
    return this.client.request<void>("DELETE", `/agents/${encodeURIComponent(uniqueId)}/permanent`);
  }
```

- [ ] **Step 4: Run lifecycle API test to verify it passes**

Run: `npm test -- tests/diaflow/teammates-lifecycle.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing lifecycle-tools test**

`tests/tools/lifecycle.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { registerLifecycleTools } from "../../src/tools/lifecycle.js";
import { DiaflowHttpError } from "../../src/diaflow/errors.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("lifecycle tools", () => {
  it("delete_teammate without force calls permanentDelete once", async () => {
    const teammates = { permanentDelete: vi.fn(async () => {}), offboard: vi.fn() };
    const { server, tools } = fakeServer();
    registerLifecycleTools(server as any, { teammates } as any);
    await tools["delete_teammate"]({ teammateId: "u1" });
    expect(teammates.permanentDelete).toHaveBeenCalledWith("u1");
    expect(teammates.offboard).not.toHaveBeenCalled();
  });

  it("delete_teammate with force offboards then permanent-deletes on conflict", async () => {
    const teammates = {
      offboard: vi.fn(async () => ({})),
      permanentDelete: vi
        .fn()
        .mockRejectedValueOnce(new DiaflowHttpError(409, "must offboard first", { code: "permanent_delete_conflict" }))
        .mockResolvedValueOnce(undefined),
    };
    const { server, tools } = fakeServer();
    registerLifecycleTools(server as any, { teammates } as any);
    await tools["delete_teammate"]({ teammateId: "u1", force: true });
    expect(teammates.offboard).toHaveBeenCalledWith("u1");
    expect(teammates.permanentDelete).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- tests/tools/lifecycle.test.ts`
Expected: FAIL — cannot find `../../src/tools/lifecycle.js`.

- [ ] **Step 7: Write `src/tools/lifecycle.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TeammatesApi } from "../diaflow/teammates.js";
import { DiaflowHttpError } from "../diaflow/errors.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

export function registerLifecycleTools(server: McpServer, ctx: { teammates: TeammatesApi }): void {
  server.registerTool(
    "publish_teammate",
    { description: "Publish a draft teammate.", inputSchema: { teammateId: z.string().min(1) } },
    async (args) => asText(await ctx.teammates.publish(args.teammateId)),
  );

  server.registerTool(
    "offboard_teammate",
    { description: "Offboard (reversible soft-delete) a teammate.", inputSchema: { teammateId: z.string().min(1) } },
    async (args) => asText(await ctx.teammates.offboard(args.teammateId)),
  );

  server.registerTool(
    "rehire_teammate",
    { description: "Rehire (restore) an offboarded teammate.", inputSchema: { teammateId: z.string().min(1) } },
    async (args) => asText(await ctx.teammates.rehire(args.teammateId)),
  );

  server.registerTool(
    "delete_teammate",
    {
      description: "Permanently delete a teammate. A teammate must be offboarded first; pass force:true to offboard-then-delete in one step.",
      inputSchema: { teammateId: z.string().min(1), force: z.boolean().optional() },
    },
    async (args) => {
      try {
        await ctx.teammates.permanentDelete(args.teammateId);
      } catch (err) {
        if (args.force && err instanceof DiaflowHttpError && err.code === "permanent_delete_conflict") {
          await ctx.teammates.offboard(args.teammateId);
          await ctx.teammates.permanentDelete(args.teammateId);
        } else {
          throw err;
        }
      }
      return asText({ deleted: true, teammateId: args.teammateId });
    },
  );
}
```

- [ ] **Step 8: Run lifecycle-tools test to verify it passes**

Run: `npm test -- tests/tools/lifecycle.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Register lifecycle tools + full run**

In `src/tools/register.ts` add `import { registerLifecycleTools } from "./lifecycle.js";` and call `registerLifecycleTools(server, ctx);`.
Run: `npm run build` → no errors.
Run: `npm test` → all PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: teammate lifecycle API + tools (publish/offboard/rehire/delete)"
```

---

## Task 12: set_workspace + list_workspaces tools (graceful degrade)

**Files:**
- Create: `src/tools/workspace.ts`
- Modify: `src/tools/register.ts`
- Test: `tests/tools/workspace.test.ts`

**Interfaces:**
- Consumes: `WorkOSSessionProvider.setWorkspace` (Task 4), `DiaflowClient`.
- Produces: tools `set_workspace`, `list_workspaces`.
  - `set_workspace({ workspaceId })` → `provider.setWorkspace(workspaceId)`.
  - `list_workspaces()` → `GET /workspaces`; on a `DiaflowHttpError` with status 404/405 return a friendly "not supported; workspace is fixed to the session" message (spec §9 Q2 degrade).

- [ ] **Step 1: Write the failing test**

`tests/tools/workspace.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { registerWorkspaceTools } from "../../src/tools/workspace.js";
import { DiaflowHttpError } from "../../src/diaflow/errors.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("workspace tools", () => {
  it("set_workspace calls provider.setWorkspace", async () => {
    const provider = { setWorkspace: vi.fn(async () => {}), getWorkspaceId: () => 7 };
    const client = { request: vi.fn() };
    const { server, tools } = fakeServer();
    registerWorkspaceTools(server as any, { provider, client } as any);
    await tools["set_workspace"]({ workspaceId: 7 });
    expect(provider.setWorkspace).toHaveBeenCalledWith(7);
  });

  it("list_workspaces degrades gracefully on 404", async () => {
    const provider = { getWorkspaceId: () => 7 };
    const client = { request: vi.fn(async () => { throw new DiaflowHttpError(404, "nope"); }) };
    const { server, tools } = fakeServer();
    registerWorkspaceTools(server as any, { provider, client } as any);
    const res = await tools["list_workspaces"]({});
    expect(res.content[0].text.toLowerCase()).toContain("not");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/tools/workspace.test.ts`
Expected: FAIL — cannot find `../../src/tools/workspace.js`.

- [ ] **Step 3: Write `src/tools/workspace.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiaflowClient } from "../diaflow/client.js";
import type { WorkOSSessionProvider } from "../auth/token-provider.js";
import { DiaflowHttpError } from "../diaflow/errors.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });

export function registerWorkspaceTools(server: McpServer, ctx: { provider: WorkOSSessionProvider; client: DiaflowClient }): void {
  server.registerTool(
    "set_workspace",
    { description: "Switch the active Diaflow workspace for subsequent teammate operations.", inputSchema: { workspaceId: z.number().int().positive() } },
    async (args) => {
      await ctx.provider.setWorkspace(args.workspaceId);
      return asText(`Active workspace set to ${ctx.provider.getWorkspaceId()}.`);
    },
  );

  server.registerTool(
    "list_workspaces",
    { description: "List workspaces available to the connected user.", inputSchema: {} },
    async () => {
      try {
        return asText(await ctx.client.request<unknown>("GET", "/workspaces"));
      } catch (err) {
        if (err instanceof DiaflowHttpError && (err.status === 404 || err.status === 405)) {
          return asText(`Listing workspaces is not supported by this Diaflow instance; the active workspace is ${ctx.provider.getWorkspaceId() ?? "(none)"}.`);
        }
        throw err;
      }
    },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/tools/workspace.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Register (only for the WorkOS provider) + full run**

In `src/tools/register.ts`, add:
```ts
import { registerWorkspaceTools } from "./workspace.js";
// inside registerAllTools, within the existing `if (ctx.provider instanceof WorkOSSessionProvider)` block:
registerWorkspaceTools(server, { provider: ctx.provider, client: ctx.client });
```
Run: `npm run build` → no errors.
Run: `npm test` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: set_workspace + list_workspaces (graceful degrade) tools"
```

---

## Task 13: Streamable HTTP transport (remote deployment)

**Files:**
- Modify: `src/index.ts` (add HTTP transport branch)
- Test: `tests/http-smoke.test.ts`

**Interfaces:**
- Consumes: `buildServer`, `buildContext` (Task 6), MCP SDK `StreamableHTTPServerTransport`.
- Produces: an HTTP server that mounts the MCP endpoint at `/mcp`, with one `McpServer`+`ToolContext` per session id (each connected user gets an isolated `WorkOSSessionProvider`).

- [ ] **Step 1: Write a failing smoke test for the session factory**

`tests/http-smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildContext } from "../src/tools/context.js";

describe("http session factory", () => {
  it("builds an isolated context per call", () => {
    const cfg = loadConfig({ DIAFLOW_API_BASE: "https://x", MCP_TRANSPORT: "http" } as any);
    const a = buildContext(cfg);
    const b = buildContext(cfg);
    expect(a.provider).not.toBe(b.provider); // isolated per session
  });
});
```

- [ ] **Step 2: Run test to verify it passes (documents the requirement)**

Run: `npm test -- tests/http-smoke.test.ts`
Expected: PASS — `buildContext` already returns fresh instances per call. (If it ever shares a provider, this test catches the regression.)

- [ ] **Step 3: Install HTTP deps**

```bash
npm install express
npm install -D @types/express
```

- [ ] **Step 4: Add the HTTP branch to `src/index.ts`**

Replace the `throw new Error("HTTP transport ...")` line with:
```ts
  // HTTP transport: one MCP server + context per session.
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());

  // Inbound auth: when MCP_INBOUND_TOKEN is set (required for a public deploy / Diaflow custom-MCP),
  // every /mcp request must present `Authorization: Bearer <MCP_INBOUND_TOKEN>`.
  app.use("/mcp", (req, res, next) => {
    if (!cfg.inboundToken) return next(); // open only when no token configured (local dev)
    const header = req.headers["authorization"];
    const expected = `Bearer ${cfg.inboundToken}`;
    if (header !== expected) {
      res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
      return;
    }
    next();
  });

  const sessions = new Map<string, { transport: InstanceType<typeof StreamableHTTPServerTransport> }>();

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let entry = sessionId ? sessions.get(sessionId) : undefined;

    if (!entry) {
      const sessionServer = buildServer(buildContext(cfg));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (id: string) => sessions.set(id, { transport }),
      });
      await sessionServer.connect(transport);
      entry = { transport };
    }
    await entry.transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const entry = sessionId ? sessions.get(sessionId) : undefined;
    if (!entry) {
      res.status(400).end();
      return;
    }
    await entry.transport.handleRequest(req, res);
  });

  app.listen(cfg.httpPort, () => console.error(`diaflow-teammate-mcp listening on :${cfg.httpPort}/mcp`));
  return;
```
(`crypto.randomUUID` is a global on Node ≥ 20. Keep the stdio branch above unchanged. If the installed SDK's `StreamableHTTPServerTransport` constructor options differ, adjust to match its typings — the contract is: generate a session id, register the transport on init, and delegate to `handleRequest`.)

- [ ] **Step 5: Run smoke test + build**

Run: `npm test -- tests/http-smoke.test.ts` → PASS.
Run: `npm run build` → no errors.

- [ ] **Step 6: Manual HTTP check (optional but recommended)**

```bash
MCP_TRANSPORT=http DIAFLOW_API_BASE=https://api.diaflow.io npm run dev &
# In another shell, initialize a session:
curl -sS -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' -i | head -30
# Expect a 200 with an mcp-session-id header. Kill the server when done.
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: streamable HTTP transport with per-session isolation"
```

---

## Task 14: End-to-end manual verification + README + CLAUDE.md

**Files:**
- Create: `README.md`
- Modify: `CLAUDE.md` (fill in the "Status" section with real commands + tool list)

**Interfaces:** none (documentation + manual verification).

- [ ] **Step 1: Manual stdio E2E against the real API**

Configure `.env` with `DIAFLOW_API_BASE`. Start the server via an MCP client (e.g. Claude Desktop config pointing to `tsx src/index.ts`), then:
1. Call `connect_diaflow` with your email.
2. Call `submit_code` with the emailed code.
3. Call `auth_status` → expect connected + workspace 1564.
4. Call `list_teammates` → expect `{ total, results }`.
5. Call `create_teammate` (a throwaway), `set_teammate_avatar` with a public image URL, `get_teammate` to confirm `icon` is set, then `offboard_teammate` + `delete_teammate { force: true }` to clean up.
Record any request-shape mismatches and fix the corresponding API method + its unit test.

- [ ] **Step 2: Write `README.md`**

Include: what it is; install (`npm install`); configure (`.env` from `.env.example`); run stdio (`npm run dev`); run HTTP (`MCP_TRANSPORT=http npm run dev`); the connect→submit_code auth flow; and the full tool list. Write real content — no placeholders.

- [ ] **Step 3: Update `CLAUDE.md` Status section**

Replace the "Status: Brainstorming/spec phase" section with the real dev commands (`npm test`, `npm run build`, `npm run dev`), the auth-flow summary, and the tool inventory.

- [ ] **Step 4: Full test + build + coverage**

Run: `npm test -- --coverage`
Expected: all suites PASS; coverage ≥ 80% on `src/**`. Add small unit tests for any uncovered branches (e.g. `auth_status` not-connected path, `list_workspaces` success path, `StaticTokenProvider.onRotate`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: README + CLAUDE.md status; complete e2e verification"
```

---

## Task 15: Diaflow custom-MCP self-registration + attach-to-teammate

**Files:**
- Create: `src/diaflow/custom-mcp.ts`, `src/tools/integration.ts`
- Modify: `src/tools/register.ts`
- Test: `tests/diaflow/custom-mcp.test.ts`, `tests/tools/integration.test.ts`

**Context:** Lets this MCP register itself as a Diaflow `mcp_custom` resource and attach itself to a teammate, so a teammate can call our teammate-management tools. Requires an outbound Diaflow session (works with either provider) and, for the registered `key`, our own `MCP_INBOUND_TOKEN`. Diaflow only accepts a **public HTTPS Streamable-HTTP** URL, so `MCP_PUBLIC_URL` must be an `https://…/mcp` endpoint (validated here to fail fast with a clear message rather than a Diaflow SSRF rejection).

**Interfaces:**
- Consumes: `DiaflowClient`, provider `getWorkspaceId()`.
- Produces:
  - `registerCustomMcp(client, wsId: number, params: { url: string; name: string; key?: string; tools?: { name: string }[] }): Promise<{ resourceId: number; created: boolean }>` → `POST /workspaces/{wsId}/resources/mcp/upsert`.
  - `attachMcpToAgent(client, agentUniqueId: string, resourceId: number, actions?: string[]): Promise<unknown>` → `POST /agents/{id}/apps` with `nodeType: "mcp_custom__{resourceId}"`.
  - Tools: `register_self_as_custom_mcp` (uses `MCP_PUBLIC_URL` + `MCP_INBOUND_TOKEN`), `attach_self_to_teammate`.

- [ ] **Step 1: Write the failing API test**

`tests/diaflow/custom-mcp.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { registerCustomMcp, attachMcpToAgent } from "../../src/diaflow/custom-mcp.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1564, fetchImpl: f });

describe("custom-mcp", () => {
  it("registerCustomMcp posts the upsert body to the workspace path", async () => {
    const f = vi.fn(async () => ok({ resourceId: 123, created: true }));
    const r = await registerCustomMcp(client(f), 1564, { url: "https://m/mcp", name: "N", key: "K" });
    expect(r).toEqual({ resourceId: 123, created: true });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/workspaces/1564/resources/mcp/upsert");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      url: "https://m/mcp", name: "N", resourceType: "mcp_custom", key: "K",
      config: { transport: "streamable_http", authType: "bearer" },
    });
  });

  it("attachMcpToAgent posts the mcp_custom node type", async () => {
    const f = vi.fn(async () => ok({ uniqueId: "u1" }));
    await attachMcpToAgent(client(f), "u1", 123, ["list_teammates"]);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/u1/apps");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ nodeType: "mcp_custom__123", resourceId: 123, actions: ["list_teammates"] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/diaflow/custom-mcp.test.ts`
Expected: FAIL — cannot find `../../src/diaflow/custom-mcp.js`.

- [ ] **Step 3: Write `src/diaflow/custom-mcp.ts`**

```ts
import type { DiaflowClient } from "./client.js";

export function registerCustomMcp(
  client: DiaflowClient,
  workspaceId: number,
  params: { url: string; name: string; key?: string; description?: string; tools?: { name: string }[] },
): Promise<{ resourceId: number; created: boolean }> {
  return client.request<{ resourceId: number; created: boolean }>(
    "POST",
    `/workspaces/${workspaceId}/resources/mcp/upsert`,
    {
      body: {
        url: params.url,
        name: params.name,
        description: params.description,
        resourceType: "mcp_custom",
        key: params.key,
        config: {
          transport: "streamable_http",
          authType: params.key ? "bearer" : "none",
          ...(params.tools ? { tools: params.tools } : {}),
        },
      },
    },
  );
}

export function attachMcpToAgent(
  client: DiaflowClient,
  agentUniqueId: string,
  resourceId: number,
  actions?: string[],
): Promise<unknown> {
  return client.request<unknown>("POST", `/agents/${encodeURIComponent(agentUniqueId)}/apps`, {
    body: { nodeType: `mcp_custom__${resourceId}`, resourceId, ...(actions ? { actions } : {}) },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/diaflow/custom-mcp.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing integration-tools test**

`tests/tools/integration.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { registerIntegrationTools } from "../../src/tools/integration.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("integration tools", () => {
  it("register_self_as_custom_mcp rejects a non-https public url", async () => {
    const { server, tools } = fakeServer();
    registerIntegrationTools(server as any, {
      client: {} as any,
      provider: { getWorkspaceId: () => 1564 } as any,
      publicUrl: "http://insecure/mcp",
      inboundToken: "K",
      registerCustomMcp: vi.fn(),
    } as any);
    const res = await tools["register_self_as_custom_mcp"]({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text.toLowerCase()).toContain("https");
  });

  it("register_self_as_custom_mcp registers with the public url + inbound token", async () => {
    const registerCustomMcp = vi.fn(async () => ({ resourceId: 9, created: true }));
    const { server, tools } = fakeServer();
    registerIntegrationTools(server as any, {
      client: {} as any,
      provider: { getWorkspaceId: () => 1564 } as any,
      publicUrl: "https://m.example.com/mcp",
      inboundToken: "K",
      registerCustomMcp,
    } as any);
    const res = await tools["register_self_as_custom_mcp"]({ name: "Mine" });
    expect(registerCustomMcp).toHaveBeenCalledWith(expect.anything(), 1564, expect.objectContaining({ url: "https://m.example.com/mcp", name: "Mine", key: "K" }));
    expect(res.content[0].text).toContain("9");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- tests/tools/integration.test.ts`
Expected: FAIL — cannot find `../../src/tools/integration.js`.

- [ ] **Step 7: Write `src/tools/integration.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiaflowClient } from "../diaflow/client.js";
import type { TokenProvider } from "../auth/token-provider.js";
import { registerCustomMcp as defaultRegister, attachMcpToAgent as defaultAttach } from "../diaflow/custom-mcp.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });
const errText = (msg: string) => ({ isError: true as const, content: [{ type: "text" as const, text: msg }] });

export interface IntegrationDeps {
  client: DiaflowClient;
  provider: Pick<TokenProvider, "getWorkspaceId">;
  publicUrl?: string;
  inboundToken?: string;
  registerCustomMcp?: typeof defaultRegister;
  attachMcpToAgent?: typeof defaultAttach;
}

export function registerIntegrationTools(server: McpServer, deps: IntegrationDeps): void {
  const register = deps.registerCustomMcp ?? defaultRegister;
  const attach = deps.attachMcpToAgent ?? defaultAttach;

  server.registerTool(
    "register_self_as_custom_mcp",
    {
      description: "Register THIS MCP server as a Diaflow custom MCP resource (requires MCP_PUBLIC_URL https + MCP_INBOUND_TOKEN).",
      inputSchema: { name: z.string().optional() },
    },
    async (args) => {
      const ws = deps.provider.getWorkspaceId();
      if (ws == null) return errText("No active workspace. Connect and/or set_workspace first.");
      if (!deps.publicUrl || !deps.publicUrl.startsWith("https://")) return errText("MCP_PUBLIC_URL must be a public https:// URL ending in /mcp (Diaflow rejects http/localhost/private).");
      const r = await register(deps.client, ws, { url: deps.publicUrl, name: args.name ?? "Diaflow Teammate MCP", key: deps.inboundToken });
      return asText(r);
    },
  );

  server.registerTool(
    "attach_self_to_teammate",
    {
      description: "Attach a registered custom-MCP resource to a teammate so it can call this server's tools.",
      inputSchema: { teammateId: z.string().min(1), resourceId: z.number().int().positive(), actions: z.array(z.string()).optional() },
    },
    async (args) => asText(await attach(deps.client, args.teammateId, args.resourceId, args.actions)),
  );
}
```

- [ ] **Step 8: Run integration-tools test to verify it passes**

Run: `npm test -- tests/tools/integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Register integration tools + full run**

In `src/tools/context.ts`: add `publicUrl?: string; inboundToken?: string;` to `ToolContext` and set them from `cfg.publicUrl` / `cfg.inboundToken` in `buildContext`.
In `src/tools/register.ts`: `import { registerIntegrationTools } from "./integration.js";` and call
`registerIntegrationTools(server, { client: ctx.client, provider: ctx.provider, publicUrl: ctx.publicUrl, inboundToken: ctx.inboundToken });`.
Run: `npm run build` → no errors.
Run: `npm test` → all PASS.

- [ ] **Step 10: Document the manual connection flow in README (Task 14 §)**

Add a "Use as a Diaflow custom MCP" section: deploy with `MCP_TRANSPORT=http`, a public HTTPS `MCP_PUBLIC_URL=…/mcp`, and an `MCP_INBOUND_TOKEN`; provide a non-interactive outbound credential (`DIAFLOW_TOKEN` = a sealed session, since teammate runtime can't do the magic-auth code step); then either call `register_self_as_custom_mcp` + `attach_self_to_teammate`, or do it manually:
```
POST /api/v1/workspaces/{wsId}/resources/mcp/upsert   { url, name, resourceType:"mcp_custom", key:<MCP_INBOUND_TOKEN>, config:{transport:"streamable_http",authType:"bearer"} }
POST /api/v1/agents/{agentUniqueId}/apps              { nodeType:"mcp_custom__{resourceId}", resourceId, actions:[...] }
```

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: self-register as Diaflow custom MCP + attach-to-teammate tools"
```

---

## Task 16: Conversation runtime — message a teammate + sessions

**Files:**
- Create: `src/diaflow/conversations.ts`, `src/tools/conversation.ts`
- Modify: `src/diaflow/upload.ts` (add `uploadChatAttachment`), `src/utils/upload-paths.ts` (add `buildAgentUploadPath`), `src/diaflow/types.ts` (add `FileRef`, `CompletionResult`), `src/tools/context.ts` + `src/tools/register.ts`
- Test: `tests/diaflow/conversations.test.ts`, `tests/tools/conversation.test.ts`

**Context:** The runtime endpoints are under `/agent-runtime` and return **snake_case** (unlike `/agents`). Use `stream:false` for a single JSON reply. `session_id == thread_id`.

**Interfaces:**
- Consumes: `DiaflowClient`, `presignUpload`/`putToPresigned` (Task 8).
- Produces:
  - `types.ts`: `interface FileRef { filename: string; path: string; size?: number; artifact_url?: string }`; `interface CompletionResult { threadId: string; reply: string; usage?: { totalTokens?: number } }`.
  - `buildAgentUploadPath(threadId: string | undefined, date: Date): string` → `agent-workspace/{threadId|'new'}/uploads/<dd-mm-yy>`.
  - `uploadChatAttachment(client, params: { url: string; threadId?: string; date: Date; fetchImpl?: typeof fetch; maxBytes?: number }): Promise<FileRef>`.
  - `class ConversationsApi { constructor(client); sendMessage(params: { teammateId?: string; message: string; threadId?: string; files?: FileRef[]; webSearch?: boolean }): Promise<CompletionResult>; listSessions(params?: { agentId?: string; page?: number; pageSize?: number }): Promise<unknown>; getHistory(sessionId: string, opts?: { limit?: number; beforeSequence?: number }): Promise<unknown>; stop(sessionId: string): Promise<void>; }`.
  - Tools: `message_teammate`, `list_conversations`, `get_conversation`, `stop_conversation`.

- [ ] **Step 1: Write the failing ConversationsApi test**

`tests/diaflow/conversations.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { ConversationsApi } from "../../src/diaflow/conversations.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("ConversationsApi", () => {
  it("sendMessage posts stream:false with agent_unique_id and parses the reply", async () => {
    const f = vi.fn(async () => ok({ thread_id: "T1", session_id: "T1", choices: [{ message: { role: "assistant", content: "hi there" } }] }));
    const api = new ConversationsApi(client(f));
    const r = await api.sendMessage({ teammateId: "u1", message: "hello" });
    expect(r).toEqual({ threadId: "T1", reply: "hi there", usage: undefined });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agent-runtime/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ stream: false, agent_unique_id: "u1", messages: [{ role: "user", content: "hello" }] });
    expect(body.thread_id).toBeUndefined();
  });

  it("sendMessage replays thread_id and omits agent_unique_id on continuation", async () => {
    const f = vi.fn(async () => ok({ thread_id: "T1", choices: [{ message: { content: "more" } }] }));
    const api = new ConversationsApi(client(f));
    const r = await api.sendMessage({ message: "again", threadId: "T1" });
    expect(r.reply).toBe("more");
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thread_id).toBe("T1");
    expect(body.agent_unique_id).toBeUndefined();
  });

  it("stop posts to the stop endpoint", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    await new ConversationsApi(client(f)).stop("T1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agent-runtime/sessions/T1/stop");
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/diaflow/conversations.test.ts`
Expected: FAIL — cannot find `../../src/diaflow/conversations.js`.

- [ ] **Step 3: Add types to `src/diaflow/types.ts`**

Append:
```ts
export interface FileRef {
  filename: string;
  path: string;
  size?: number;
  artifact_url?: string;
}

export interface CompletionResult {
  threadId: string;
  reply: string;
  usage?: { totalTokens?: number };
}
```

- [ ] **Step 4: Write `src/diaflow/conversations.ts`**

```ts
import type { DiaflowClient } from "./client.js";
import type { CompletionResult, FileRef } from "./types.js";

interface CompletionResponse {
  thread_id?: string;
  session_id?: string;
  choices?: { message?: { role?: string; content?: string } }[];
  usage?: { total_tokens?: number };
}

export class ConversationsApi {
  constructor(private readonly client: DiaflowClient) {}

  async sendMessage(params: {
    teammateId?: string;
    message: string;
    threadId?: string;
    files?: FileRef[];
    webSearch?: boolean;
  }): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: params.message }],
      stream: false,
    };
    if (params.teammateId) body.agent_unique_id = params.teammateId;
    if (params.threadId) body.thread_id = params.threadId;
    if (params.files?.length) body.files = params.files;
    if (params.webSearch !== undefined) body.web_search_enabled = params.webSearch;

    const res = await this.client.request<CompletionResponse>("POST", "/agent-runtime/completions", { body });
    return {
      threadId: res.thread_id ?? res.session_id ?? params.threadId ?? "",
      reply: res.choices?.[0]?.message?.content ?? "",
      usage: res.usage ? { totalTokens: res.usage.total_tokens } : undefined,
    };
  }

  listSessions(params: { agentId?: string; page?: number; pageSize?: number } = {}): Promise<unknown> {
    return this.client.request<unknown>("GET", "/agent-runtime/sessions", {
      query: { agent_id: params.agentId, page: params.page, pageSize: params.pageSize },
    });
  }

  getHistory(sessionId: string, opts: { limit?: number; beforeSequence?: number } = {}): Promise<unknown> {
    return this.client.request<unknown>("GET", `/agent-runtime/sessions/${encodeURIComponent(sessionId)}/history`, {
      query: { limit: opts.limit ?? 50, before_sequence: opts.beforeSequence },
    });
  }

  stop(sessionId: string): Promise<void> {
    return this.client.request<void>("POST", `/agent-runtime/sessions/${encodeURIComponent(sessionId)}/stop`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/diaflow/conversations.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Add `buildAgentUploadPath` + `uploadChatAttachment`**

Append to `src/utils/upload-paths.ts`:
```ts
export function buildAgentUploadPath(threadId: string | undefined, date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(date.getUTCFullYear()).slice(-2);
  return `agent-workspace/${threadId ?? "new"}/uploads/${dd}-${mm}-${yy}`;
}
```
Append to `src/diaflow/upload.ts` (reuses `presignUpload`/`putToPresigned`/`slugify`, and import `buildAgentUploadPath` + `FileRef`):
```ts
import { buildAgentUploadPath } from "../utils/upload-paths.js";
import type { FileRef } from "./types.js";

const MAX_CHAT_BYTES = 25 * 1024 * 1024;

export async function uploadChatAttachment(
  client: DiaflowClient,
  params: { url: string; threadId?: string; date: Date; fetchImpl?: typeof fetch; maxBytes?: number },
): Promise<FileRef> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const maxBytes = params.maxBytes ?? MAX_CHAT_BYTES;
  const dl = await fetchImpl(params.url);
  if (!dl.ok) throw new Error(`failed to download attachment: HTTP ${dl.status}`);
  const contentType = dl.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  const buf = new Uint8Array(await dl.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new Error(`attachment size ${buf.byteLength} exceeds max ${maxBytes} bytes`);
  const nameFromUrl = new URL(params.url).pathname.split("/").pop() || "file";
  const filename = slugify(nameFromUrl) || "file";
  const folder = buildAgentUploadPath(params.threadId, params.date);
  const presigned = await presignUpload(client, { name: filename, type: contentType, folder, fileSize: buf.byteLength });
  await putToPresigned(presigned.uploadUrl, buf, contentType, fetchImpl);
  return { filename, path: presigned.key, size: buf.byteLength, artifact_url: presigned.url };
}
```

- [ ] **Step 7: Write the failing conversation-tools test**

`tests/tools/conversation.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { registerConversationTools } from "../../src/tools/conversation.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

describe("conversation tools", () => {
  it("message_teammate sends text and returns the reply + threadId", async () => {
    const conversations = { sendMessage: vi.fn(async () => ({ threadId: "T1", reply: "done" })) };
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any, uploadChatAttachment: vi.fn() } as any);
    const res = await tools["message_teammate"]({ teammateId: "u1", message: "go" });
    expect(conversations.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ teammateId: "u1", message: "go", threadId: undefined, files: undefined }));
    expect(res.content[0].text).toContain("T1");
    expect(res.content[0].text).toContain("done");
  });

  it("message_teammate uploads attachmentUrls first", async () => {
    const conversations = { sendMessage: vi.fn(async () => ({ threadId: "T1", reply: "ok" })) };
    const uploadChatAttachment = vi.fn(async () => ({ filename: "a.png", path: "k", artifact_url: "u" }));
    const { server, tools } = fakeServer();
    registerConversationTools(server as any, { conversations, client: {} as any, uploadChatAttachment } as any);
    await tools["message_teammate"]({ teammateId: "u1", message: "look", attachmentUrls: ["https://r/a.png"] });
    expect(uploadChatAttachment).toHaveBeenCalledTimes(1);
    expect(conversations.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ files: [{ filename: "a.png", path: "k", artifact_url: "u" }] }));
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `npm test -- tests/tools/conversation.test.ts`
Expected: FAIL — cannot find `../../src/tools/conversation.js`.

- [ ] **Step 9: Write `src/tools/conversation.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiaflowClient } from "../diaflow/client.js";
import type { ConversationsApi } from "../diaflow/conversations.js";
import type { FileRef } from "../diaflow/types.js";
import { uploadChatAttachment as defaultUpload } from "../diaflow/upload.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });

export interface ConversationDeps {
  conversations: ConversationsApi;
  client: DiaflowClient;
  uploadChatAttachment?: typeof defaultUpload;
  now?: () => Date;
}

export function registerConversationTools(server: McpServer, deps: ConversationDeps): void {
  const upload = deps.uploadChatAttachment ?? defaultUpload;
  const now = deps.now ?? (() => new Date());

  server.registerTool(
    "message_teammate",
    {
      description: "Post a message to a teammate and get its reply (synchronous). Omit teammateId to continue an existing thread. Use for agent-to-agent orchestration.",
      inputSchema: {
        message: z.string().min(1),
        teammateId: z.string().optional(),
        threadId: z.string().optional(),
        attachmentUrls: z.array(z.string().url()).optional(),
        webSearch: z.boolean().optional(),
      },
    },
    async (args) => {
      let files: FileRef[] | undefined;
      if (args.attachmentUrls?.length) {
        files = [];
        for (const url of args.attachmentUrls) {
          files.push(await upload(deps.client, { url, threadId: args.threadId, date: now() }));
        }
      }
      const r = await deps.conversations.sendMessage({
        teammateId: args.teammateId,
        message: args.message,
        threadId: args.threadId,
        files,
        webSearch: args.webSearch,
      });
      return asText(r);
    },
  );

  server.registerTool(
    "list_conversations",
    { description: "List conversation sessions, optionally filtered by teammate.", inputSchema: { agentId: z.string().optional(), page: z.number().int().positive().optional(), pageSize: z.number().int().positive().optional() } },
    async (args) => asText(await deps.conversations.listSessions(args)),
  );

  server.registerTool(
    "get_conversation",
    { description: "Get the message history of a conversation session.", inputSchema: { sessionId: z.string().min(1), limit: z.number().int().positive().optional() } },
    async (args) => asText(await deps.conversations.getHistory(args.sessionId, { limit: args.limit })),
  );

  server.registerTool(
    "stop_conversation",
    { description: "Stop/cancel an in-progress conversation run.", inputSchema: { sessionId: z.string().min(1) } },
    async (args) => {
      await deps.conversations.stop(args.sessionId);
      return asText({ stopped: true, sessionId: args.sessionId });
    },
  );
}
```

- [ ] **Step 10: Run conversation-tools test to verify it passes**

Run: `npm test -- tests/tools/conversation.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 11: Wire into context + register**

In `src/tools/context.ts`: `import { ConversationsApi } from "../diaflow/conversations.js";`, add `conversations: ConversationsApi;` to `ToolContext`, set `conversations: new ConversationsApi(client)`.
In `src/tools/register.ts`: `import { registerConversationTools } from "./conversation.js";` and call `registerConversationTools(server, { conversations: ctx.conversations, client: ctx.client });`.
Run: `npm run build` → no errors. Run: `npm test` → all PASS.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: message_teammate + conversation session tools (agent-to-agent orchestration)"
```

---

## Task 17: Sub-agents (orchestrator structure)

**Files:**
- Create: `src/diaflow/sub-agents.ts`, `src/tools/sub-agents.ts`
- Modify: `src/tools/context.ts`, `src/tools/register.ts`
- Test: `tests/diaflow/sub-agents.test.ts`, `tests/tools/sub-agents.test.ts`

**Interfaces:**
- Consumes: `DiaflowClient`, `AgentDetail`, `CreateTeammateFields`.
- Produces:
  - `class SubAgentsApi { constructor(client); list(uniqueId): Promise<AgentDetail[]>; attach(uniqueId, subAgentUniqueId): Promise<unknown>; create(uniqueId, fields: CreateTeammateFields): Promise<AgentDetail>; detach(uniqueId, subUniqueId): Promise<void>; }`
    - list → `GET /agents/{uid}/sub-agents`
    - attach → `POST /agents/{uid}/sub-agents` `{ subAgentUniqueId }`
    - create → `POST /agents/{uid}/sub-agents/create` (body = CreateTeammateFields)
    - detach → `DELETE /agents/{uid}/sub-agents/{subUid}`
  - Tools: `list_sub_agents`, `add_sub_agent`, `create_sub_agent`, `remove_sub_agent`.

- [ ] **Step 1: Write the failing API test**

`tests/diaflow/sub-agents.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { SubAgentsApi } from "../../src/diaflow/sub-agents.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

describe("SubAgentsApi", () => {
  it("attach posts subAgentUniqueId", async () => {
    const f = vi.fn(async () => ok({ ok: true }, 201));
    await new SubAgentsApi(client(f)).attach("orch1", "sub1");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/orch1/sub-agents");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ subAgentUniqueId: "sub1" });
  });

  it("detach deletes the sub-agent path", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    await new SubAgentsApi(client(f)).detach("orch1", "sub1");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/orch1/sub-agents/sub1");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("create posts to /sub-agents/create", async () => {
    const f = vi.fn(async () => ok({ uniqueId: "sub2" }, 201));
    await new SubAgentsApi(client(f)).create("orch1", { modelProvider: "openai", modelName: "gpt-4", name: "Helper" });
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/orch1/sub-agents/create");
    expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)).toMatchObject({ modelProvider: "openai", modelName: "gpt-4", name: "Helper" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/diaflow/sub-agents.test.ts`
Expected: FAIL — cannot find `../../src/diaflow/sub-agents.js`.

- [ ] **Step 3: Write `src/diaflow/sub-agents.ts`**

```ts
import type { DiaflowClient } from "./client.js";
import type { AgentDetail, CreateTeammateFields } from "./types.js";

export class SubAgentsApi {
  constructor(private readonly client: DiaflowClient) {}

  list(uniqueId: string): Promise<AgentDetail[]> {
    return this.client.request<AgentDetail[]>("GET", `/agents/${encodeURIComponent(uniqueId)}/sub-agents`);
  }

  attach(uniqueId: string, subAgentUniqueId: string): Promise<unknown> {
    return this.client.request<unknown>("POST", `/agents/${encodeURIComponent(uniqueId)}/sub-agents`, {
      body: { subAgentUniqueId },
    });
  }

  create(uniqueId: string, fields: CreateTeammateFields): Promise<AgentDetail> {
    return this.client.request<AgentDetail>("POST", `/agents/${encodeURIComponent(uniqueId)}/sub-agents/create`, { body: fields });
  }

  detach(uniqueId: string, subUniqueId: string): Promise<void> {
    return this.client.request<void>("DELETE", `/agents/${encodeURIComponent(uniqueId)}/sub-agents/${encodeURIComponent(subUniqueId)}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/diaflow/sub-agents.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the failing sub-agent-tools test**

`tests/tools/sub-agents.test.ts`:
```ts
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
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test -- tests/tools/sub-agents.test.ts`
Expected: FAIL — cannot find `../../src/tools/sub-agents.js`.

- [ ] **Step 7: Write `src/tools/sub-agents.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SubAgentsApi } from "../diaflow/sub-agents.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

const starterPrompt = z.object({ title: z.string(), prompt: z.string() });

export function registerSubAgentTools(server: McpServer, ctx: { subAgents: SubAgentsApi }): void {
  server.registerTool(
    "list_sub_agents",
    { description: "List the sub-agents attached to an orchestrator teammate.", inputSchema: { teammateId: z.string().min(1) } },
    async (args) => asText(await ctx.subAgents.list(args.teammateId)),
  );

  server.registerTool(
    "add_sub_agent",
    { description: "Attach an existing teammate as a sub-agent of an orchestrator teammate.", inputSchema: { teammateId: z.string().min(1), subAgentId: z.string().min(1) } },
    async (args) => asText(await ctx.subAgents.attach(args.teammateId, args.subAgentId)),
  );

  server.registerTool(
    "create_sub_agent",
    {
      description: "Create a new teammate and attach it as a sub-agent of an orchestrator in one step.",
      inputSchema: {
        teammateId: z.string().min(1),
        modelProvider: z.string().min(1),
        modelName: z.string().min(1),
        name: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        instruction: z.string().optional(),
        welcomeMessage: z.string().optional(),
        intelligence: z.string().optional(),
        starterPrompts: z.array(starterPrompt).optional(),
        tags: z.array(z.string()).optional(),
        icon: z.string().optional(),
      },
    },
    async (args) => {
      const { teammateId, ...fields } = args;
      return asText(await ctx.subAgents.create(teammateId, fields));
    },
  );

  server.registerTool(
    "remove_sub_agent",
    { description: "Detach a sub-agent from an orchestrator teammate.", inputSchema: { teammateId: z.string().min(1), subAgentId: z.string().min(1) } },
    async (args) => {
      await ctx.subAgents.detach(args.teammateId, args.subAgentId);
      return asText({ detached: true, teammateId: args.teammateId, subAgentId: args.subAgentId });
    },
  );
}
```

- [ ] **Step 8: Run sub-agent-tools test to verify it passes**

Run: `npm test -- tests/tools/sub-agents.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 9: Wire into context + register**

In `src/tools/context.ts`: `import { SubAgentsApi } from "../diaflow/sub-agents.js";`, add `subAgents: SubAgentsApi;` to `ToolContext`, set `subAgents: new SubAgentsApi(client)`.
In `src/tools/register.ts`: `import { registerSubAgentTools } from "./sub-agents.js";` and call `registerSubAgentTools(server, { subAgents: ctx.subAgents });`.
Run: `npm run build` → no errors. Run: `npm test` → all PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: sub-agent API + tools (orchestrator structure)"
```

---

## Self-Review

**Spec coverage:**
- §2.1 read (list/get) → Tasks 5–6. ✅
- §2.1 create/check-name/update → Task 7. ✅
- §2.1 lifecycle (publish/offboard/rehire/permanent-delete) → Task 11. ✅
- §2.1 skills attach/detach/list → Task 10. ✅
- §2.2 avatar presign→PUT→persist → Tasks 8–9. ✅
- §3.1 module layout → Tasks 1–13 create every file listed. ✅
- §4 magic-auth headless login + rotation → Tasks 2 (rotation capture), 3 (magic-auth), 4 (provider). ✅ (§4.2 spike already executed and verified before planning.)
- §5 config → Task 1. ✅
- §6 tools (connect_diaflow, auth_status, list/get, create/update/check-name, set_avatar/list_presets, skills×4, lifecycle×4, set_workspace/list_workspaces) → Tasks 6,7,9,10,11,12. `submit_code` added as the second half of `connect_diaflow` (the emailed-code step) — a documented refinement of the spec's single `connect_diaflow` entry. ✅
- §7 error handling (code surfaced, no swallow, upload guards, 401 handling) → Task 2 (error mapping) + Task 8 (size/type/2xx guards) + Task 11 (409 code branch). Note: automatic 401 refresh-and-retry is NOT separately implemented — acceptable for v1 because seals rotate via `X-Diaflow-Session`; if hard 401s occur in Task 14 E2E, add a retry-once wrapper in `DiaflowClient.request` and re-prompt connect. Flagged, not silently dropped.
- §8 testing (unit for client/upload/auth/tools, integration via mocked fetch) → every task is TDD; Task 14 adds coverage gate + real E2E. ✅
- §9 open questions: Q1 rotation lifetime — observed in Task 14 E2E; Q2 list_workspaces degrade — Task 12; Q3 avatar-at-create ordering — resolved as create-then-set (avatar is its own tool; `create_teammate` accepts a preset `icon` string only); Q4 preset host allowlist — Task 9 Step 9 (start with API host, refine). ✅
- Diaflow custom-MCP integration (reverse direction: a teammate calls this server) → Task 15 (register-self + attach tools) + Task 13 inbound `Authorization: Bearer <MCP_INBOUND_TOKEN>` gate on the HTTP `/mcp` endpoint. Constraint captured: Streamable HTTP + public HTTPS only; non-interactive outbound credential (`StaticTokenProvider`/`DIAFLOW_TOKEN`) required for teammate-runtime use since there's no human to complete magic-auth. ✅
- Conversation runtime — message a teammate + sessions (`message_teammate`, `list_conversations`, `get_conversation`, `stop_conversation`) → Task 16, via `POST /agent-runtime/completions` with `stream:false`. Chat attachments reuse presign→PUT (Task 8) with the `agent-workspace/{threadId}/uploads` folder. **Note:** `/agent-runtime` responses are snake_case — `ConversationsApi` reads snake keys (`thread_id`, `choices[].message.content`), distinct from the camelCase `/agents` endpoints. ✅
- Orchestration / sub-agents (`list_sub_agents`, `add_sub_agent`, `create_sub_agent`, `remove_sub_agent`) → Task 17. Agent-to-agent orchestration is achieved by a caller (or a Diaflow teammate via the custom-MCP integration) invoking `message_teammate` against other teammates; native sub-agent delegation is internal to one orchestrator completion (no per-sub-agent message endpoint) — captured in the spec, not a tool. ✅
- v1 uses synchronous (`stream:false`) completions; live SSE streaming relay is explicitly deferred. Long orchestration runs rely on the sync call's timeout; HITL `tool_confirmation` interrupts are not surfaced in sync mode (a streaming variant would be needed for interactive approval) — flagged, not silently dropped. ✅

**Placeholder scan:** No "TBD"/"implement later"/"add error handling" without code. Every code step shows full code. The only deferred item (explicit 401-retry wrapper) is called out with rationale, not left as a silent TODO.

**Type consistency:** `TokenProvider` methods (`getToken`/`getWorkspaceId`/`onRotate`/`isConnected`) are used identically in `DiaflowClient` options (Task 2) and `buildContext` (Task 6). `TeammatesApi` method names (`list`/`get`/`create`/`update`/`checkName`/`publish`/`offboard`/`rehire`/`permanentDelete`) are consistent across Tasks 5, 7, 11 and their tool consumers. `SkillRef` shape matches between `types.ts`, `SkillsApi`, and `tools/skills.ts`. `PresignResponse` fields (`uploadUrl`/`key`/`url`) match between `types.ts`, `upload.ts`, and the client test. `verifyMagicCode` returns `{ session, workspaceId, subdomain }` consistently in Tasks 3 and 4. `ListParams` includes `search` from the outset (Task 5) so `list_teammates` passing `search` is type-safe.
```
