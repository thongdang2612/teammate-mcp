# Personal-Skill Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP tools that let the authenticated caller author and edit their own Diaflow personal skills (`skill_user`) — full CRUD plus editing the `SKILL.md`/file content.

**Architecture:** A new `SkillUserApi` (`src/diaflow/skill-users.ts`) wraps the `/agents/skill-users/*` REST endpoints and exposes two cohesive operations (`writeFile`, `readFile`) that hide Diaflow's presign→PUT-to-S3→persist file flow, reusing `putToPresigned` from `src/diaflow/upload.ts`. A new tools module (`src/tools/skill-authoring.ts`) registers 8 MCP tools over that API. The API and tools mirror the existing `SkillsApi` (`src/diaflow/skills.ts`) / `src/tools/skills.ts` split exactly.

**Tech Stack:** TypeScript (ESM/NodeNext), `@modelcontextprotocol/sdk`, Zod v4, Vitest. Node ≥ 20.

## Global Constraints

- Reference repos `diaflow-backend/` and `diaflow-expo/` are **read-only** — never modify them.
- No secrets in code; all auth flows reuse the existing `DiaflowClient` (Authorization + Workspace-Id headers already handled).
- Immutable style; small focused files (repo rule: files well under 800 lines).
- All Diaflow responses here are **bare models** (no `{data,message,status}` envelope); `DELETE` returns **204** (`client.request<void>` returns `undefined`).
- Presigned PUT content-type is **`application/octet-stream`** — the PUT must send exactly that.
- The new-file presign endpoint (`POST /agents/skill-users/presigned-urls`) looks the skill up **by name**, not id.
- A skill must exist before any file can be presigned (the S3 key embeds its `unique_id`) — so "create with content" is two hops.
- Tool names use the explicit `personal_skill` prefix so the model never confuses them with the teammate-attachment tools (`attach_skill`/`detach_skill`/`list_teammate_skills`/`list_available_skills`).
- `skillId` in every tool is the skill's `unique_id`.
- Coverage target ≥ 80% for new modules.
- Test command: `npx vitest run <path>` (single file) / `npm test` (full). Type-check/build: `npm run build`.

## File Structure

- **Create** `src/diaflow/skill-users.ts` — `SkillUserApi`: endpoint wrappers + `writeFile`/`readFile` cohesive ops.
- **Create** `src/tools/skill-authoring.ts` — `registerSkillAuthoringTools(server, { skillUsers })`, 8 tools.
- **Modify** `src/diaflow/types.ts` — add `PersonalSkill`, `PresignedFileInfo`, `PresignedUrlsResponse`.
- **Modify** `src/tools/context.ts` — add `skillUsers: SkillUserApi` to `ToolContext` + construct it in `buildContext`.
- **Modify** `src/tools/register.ts` — import + call `registerSkillAuthoringTools`.
- **Create** `tests/diaflow/skill-users.test.ts`, `tests/tools/skill-authoring.test.ts`.

## Reference Snippets (existing code the tasks build on — do not re-derive)

`src/diaflow/upload.ts` (reuse verbatim, already exported):
```ts
export async function putToPresigned(
  uploadUrl: string,
  bytes: ArrayBuffer | Uint8Array,
  contentType: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> { /* PUTs bytes; throws "S3 upload failed: HTTP <status>" on non-2xx */ }
```

`src/diaflow/client.ts` (already exists):
```ts
class DiaflowClient {
  request<T>(method: string, path: string, options?: {
    query?: Record<string, string | number | undefined>;
    body?: unknown; workspaceId?: number | null; signal?: AbortSignal;
  }): Promise<T>;   // path is relative to `${baseUrl}/api/v1`; 204 → undefined; non-2xx → throws DiaflowHttpError
  // opts include fetchImpl?: typeof fetch  (constructor option, used by readFile)
}
```

`src/tools/skills.ts` response helpers pattern (mirror these):
```ts
const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const errText = (msg: string) => ({ isError: true as const, content: [{ type: "text" as const, text: msg }] });
```

Test harness pattern (from `tests/diaflow/skills.test.ts`):
```ts
const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });
```

---

### Task 1: Types + `SkillUserApi` CRUD (create/list/get/update/remove)

**Files:**
- Modify: `src/diaflow/types.ts` (append new interfaces at end)
- Create: `src/diaflow/skill-users.ts`
- Test: `tests/diaflow/skill-users.test.ts`

**Interfaces:**
- Consumes: `DiaflowClient.request<T>` (see Reference Snippets).
- Produces:
  - `PersonalSkill { id: number; uniqueId: string; workspaceId: number; userId: number; name: string; description: string | null; files: Record<string,string>; isActive: boolean; version: number; createdAt: string; updatedAt: string }`
  - `PresignedFileInfo { uploadUrl: string; key: string; url: string; contentType: string }`
  - `PresignedUrlsResponse { files: Record<string, PresignedFileInfo> }`
  - `class SkillUserApi { constructor(client: DiaflowClient); list(): Promise<PersonalSkill[]>; get(uniqueId: string): Promise<PersonalSkill>; create(input: { name: string; description?: string; files?: Record<string,string> }): Promise<PersonalSkill>; update(uniqueId: string, fields: { name?: string; description?: string }): Promise<PersonalSkill>; remove(uniqueId: string): Promise<void> }`
  - The backend returns snake_case; a private `toPersonalSkill(raw)` mapper converts `unique_id`→`uniqueId`, `workspace_id`→`workspaceId`, `user_id`→`userId`, `is_active`→`isActive`, `created_at`→`createdAt`, `updated_at`→`updatedAt`, and passes through `id`/`name`/`description`/`files`/`version` (files defaults to `{}` if absent).

- [ ] **Step 1: Write the failing test** — append to `tests/diaflow/skill-users.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { DiaflowClient } from "../../src/diaflow/client.js";
import { SkillUserApi } from "../../src/diaflow/skill-users.js";

const ok = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const client = (f: any) => new DiaflowClient({ baseUrl: "https://x", getToken: async () => "t", getWorkspaceId: () => 1, fetchImpl: f });

const RAW = { id: 7, unique_id: "sk1", workspace_id: 1, user_id: 2, name: "My Skill", description: "d", files: { "SKILL.md": "k/SKILL.md" }, is_active: true, version: 3, created_at: "2026-07-04T00:00:00Z", updated_at: "2026-07-04T00:00:00Z" };

describe("SkillUserApi CRUD", () => {
  it("create posts name/description and maps the response to camelCase", async () => {
    const f = vi.fn(async () => ok(RAW, 201));
    const r = await new SkillUserApi(client(f)).create({ name: "My Skill", description: "d" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/skill-users");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ name: "My Skill", description: "d", files: {} });
    expect(r.uniqueId).toBe("sk1");
    expect(r.isActive).toBe(true);
    expect(r.files).toEqual({ "SKILL.md": "k/SKILL.md" });
  });

  it("list maps every item", async () => {
    const f = vi.fn(async () => ok([RAW]));
    const r = await new SkillUserApi(client(f)).list();
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/skill-users");
    expect(r[0].uniqueId).toBe("sk1");
  });

  it("get uses the unique id in the path", async () => {
    const f = vi.fn(async () => ok(RAW));
    await new SkillUserApi(client(f)).get("sk1");
    expect(f.mock.calls[0][0]).toBe("https://x/api/v1/agents/skill-users/sk1");
  });

  it("update PATCHes only the provided fields", async () => {
    const f = vi.fn(async () => ok(RAW));
    await new SkillUserApi(client(f)).update("sk1", { description: "new" });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/skill-users/sk1");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ description: "new" });
  });

  it("remove DELETEs and resolves on 204", async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    await new SkillUserApi(client(f)).remove("sk1");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x/api/v1/agents/skill-users/sk1");
    expect((init as RequestInit).method).toBe("DELETE");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/diaflow/skill-users.test.ts`
Expected: FAIL — cannot find module `../../src/diaflow/skill-users.js`.

- [ ] **Step 3: Append types to `src/diaflow/types.ts`**

```ts
export interface PersonalSkill {
  id: number;
  uniqueId: string;
  workspaceId: number;
  userId: number;
  name: string;
  description: string | null;
  files: Record<string, string>;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PresignedFileInfo {
  uploadUrl: string;
  key: string;
  url: string;
  contentType: string;
}

export interface PresignedUrlsResponse {
  files: Record<string, PresignedFileInfo>;
}
```

- [ ] **Step 4: Create `src/diaflow/skill-users.ts` with CRUD only**

```ts
import type { DiaflowClient } from "./client.js";
import type { PersonalSkill } from "./types.js";

const BASE = "/agents/skill-users";

interface RawSkill {
  id: number; unique_id: string; workspace_id: number; user_id: number;
  name: string; description: string | null; files?: Record<string, string>;
  is_active: boolean; version: number; created_at: string; updated_at: string;
}

function toPersonalSkill(raw: RawSkill): PersonalSkill {
  return {
    id: raw.id,
    uniqueId: raw.unique_id,
    workspaceId: raw.workspace_id,
    userId: raw.user_id,
    name: raw.name,
    description: raw.description,
    files: raw.files ?? {},
    isActive: raw.is_active,
    version: raw.version,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export class SkillUserApi {
  constructor(private readonly client: DiaflowClient) {}

  async list(): Promise<PersonalSkill[]> {
    const raw = await this.client.request<RawSkill[]>("GET", BASE);
    return raw.map(toPersonalSkill);
  }

  async get(uniqueId: string): Promise<PersonalSkill> {
    return toPersonalSkill(await this.client.request<RawSkill>("GET", `${BASE}/${encodeURIComponent(uniqueId)}`));
  }

  async create(input: { name: string; description?: string; files?: Record<string, string> }): Promise<PersonalSkill> {
    const body = { name: input.name, description: input.description, files: input.files ?? {} };
    return toPersonalSkill(await this.client.request<RawSkill>("POST", BASE, { body }));
  }

  async update(uniqueId: string, fields: { name?: string; description?: string }): Promise<PersonalSkill> {
    return toPersonalSkill(await this.client.request<RawSkill>("PATCH", `${BASE}/${encodeURIComponent(uniqueId)}`, { body: fields }));
  }

  remove(uniqueId: string): Promise<void> {
    return this.client.request<void>("DELETE", `${BASE}/${encodeURIComponent(uniqueId)}`);
  }
}
```

Note on `create` body: the test expects `{ name, description: "d", files: {} }`. When `description` is omitted, JSON.stringify drops the `undefined` key — the backend treats a missing `description` as null, which is correct. The test always passes `description`, so the assertion holds.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/diaflow/skill-users.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Type-check**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/diaflow/types.ts src/diaflow/skill-users.ts tests/diaflow/skill-users.test.ts
git commit -m "feat(skills): SkillUserApi CRUD for personal skills"
```

---

### Task 2: `SkillUserApi` file operations (`writeFile`, `readFile`, `removeFiles`, `getFileUrl`)

**Files:**
- Modify: `src/diaflow/skill-users.ts` (add methods to the class)
- Test: `tests/diaflow/skill-users.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `putToPresigned(uploadUrl, bytes, contentType, fetchImpl?)` from `src/diaflow/upload.ts`; own `get(uniqueId)`, `PresignedUrlsResponse`, `PresignedFileInfo` (Task 1).
- Produces (added to `SkillUserApi`):
  - `getFileUrl(uniqueId: string, filePath: string): Promise<string>` — GET `${BASE}/{id}/files/{path}` → `{ url }` → returns `url`.
  - `removeFiles(uniqueId: string, paths: string[]): Promise<PersonalSkill>` — DELETE `${BASE}/{id}/files` body `{ paths }`.
  - `writeFile(uniqueId: string, path: string, content: string): Promise<void>` — new-vs-edit branch.
  - `readFile(uniqueId: string, path: string): Promise<string>` — signed URL then fetch text.

**Design detail — `writeFile` branching** (mirrors spec §Architecture):
- `skill = await this.get(uniqueId)`; `bytes = new TextEncoder().encode(content)`.
- If `path in skill.files` (edit): `POST ${BASE}/{id}/files/presigned-edit {file_path: path}` → `{ upload_url, s3_key }`; `putToPresigned(upload_url, bytes, "application/octet-stream", this.fetchImpl)`; `POST ${BASE}/{id}/files/confirm-edit {file_path: path, s3_key}`.
- Else (new): `POST ${BASE}/presigned-urls {skill_name: skill.name, files: [path]}` → `PresignedUrlsResponse`; `info = res.files[path]`; `putToPresigned(info.uploadUrl, bytes, info.contentType, this.fetchImpl)`; `POST ${BASE}/{id}/files {files: {[path]: info.key}}`.

The presign response for the new-file path is snake_case (`upload_url`, `content_type`); add a small mapper `toFileInfo(raw)`.

**`fetchImpl` access:** `readFile` must fetch a non-Diaflow (CloudFront) URL directly. Add a constructor option so tests can inject it. Update the constructor:
```ts
constructor(private readonly client: DiaflowClient, private readonly fetchImpl: typeof fetch = fetch) {}
```
(Task 1's `new SkillUserApi(client)` calls still work — `fetchImpl` defaults to global `fetch`.)

- [ ] **Step 1: Write the failing test** — add to `tests/diaflow/skill-users.test.ts`:

```ts
import { SkillUserApi as _SUA } from "../../src/diaflow/skill-users.js"; // (already imported above; keep single import in practice)

describe("SkillUserApi file ops", () => {
  const RAW = { id: 7, unique_id: "sk1", workspace_id: 1, user_id: 2, name: "My Skill", description: "d", files: { "SKILL.md": "wk/agent/skills/sk1/My Skill/SKILL.md" }, is_active: true, version: 3, created_at: "t", updated_at: "t" };

  it("writeFile EDIT branch: presigned-edit -> PUT octet-stream -> confirm-edit", async () => {
    const calls: any[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body });
      if (url.endsWith("/agents/skill-users/sk1")) return ok(RAW);
      if (url.endsWith("/files/presigned-edit")) return ok({ upload_url: "https://s3/put-edit", s3_key: "wk/agent/skills/sk1/My Skill/SKILL.abc.md" });
      if (url === "https://s3/put-edit") return new Response(null, { status: 200 });
      if (url.endsWith("/files/confirm-edit")) return ok({ s3_key: "x", file_path: "SKILL.md" });
      throw new Error("unexpected " + url);
    });
    await new SkillUserApi(client(f), f as any).writeFile("sk1", "SKILL.md", "# hi");
    const seq = calls.map((c) => c.url.replace("https://x/api/v1", ""));
    expect(seq).toEqual([
      "/agents/skill-users/sk1",
      "/agents/skill-users/sk1/files/presigned-edit",
      "https://s3/put-edit",
      "/agents/skill-users/sk1/files/confirm-edit",
    ]);
    const putCall = calls.find((c) => c.url === "https://s3/put-edit");
    expect((putCall.body as any)).toBeDefined();
    const confirm = JSON.parse(calls.find((c) => c.url.endsWith("confirm-edit")).body);
    expect(confirm).toEqual({ file_path: "SKILL.md", s3_key: "wk/agent/skills/sk1/My Skill/SKILL.abc.md" });
  });

  it("writeFile NEW branch: presigned-urls(by name) -> PUT -> POST files", async () => {
    const calls: any[] = [];
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body });
      if (url.endsWith("/agents/skill-users/sk1")) return ok(RAW);
      if (url.endsWith("/agents/skill-users/presigned-urls")) return ok({ files: { "docs/x.md": { upload_url: "https://s3/put-new", key: "wk/.../docs/x.md", url: "https://cdn/x.md", content_type: "application/octet-stream" } } });
      if (url === "https://s3/put-new") return new Response(null, { status: 200 });
      if (url.endsWith("/agents/skill-users/sk1/files")) return ok(RAW);
      throw new Error("unexpected " + url);
    });
    await new SkillUserApi(client(f), f as any).writeFile("sk1", "docs/x.md", "body");
    const presign = JSON.parse(calls.find((c) => c.url.endsWith("presigned-urls")).body);
    expect(presign).toEqual({ skill_name: "My Skill", files: ["docs/x.md"] });
    const persist = JSON.parse(calls.find((c) => c.url.endsWith("/sk1/files") && c.method === "POST").body);
    expect(persist).toEqual({ files: { "docs/x.md": "wk/.../docs/x.md" } });
  });

  it("readFile resolves the signed url then fetches text", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.endsWith("/files/SKILL.md")) return ok({ url: "https://cdn/signed" });
      if (url === "https://cdn/signed") return new Response("# content", { status: 200 });
      throw new Error("unexpected " + url);
    });
    const r = await new SkillUserApi(client(f), f as any).readFile("sk1", "SKILL.md");
    expect(r).toBe("# content");
  });

  it("removeFiles DELETEs with the paths body", async () => {
    const f = vi.fn(async () => ok(RAW));
    await new SkillUserApi(client(f)).removeFiles("sk1", ["docs/x.md"]);
    const init = f.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body as string)).toEqual({ paths: ["docs/x.md"] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/diaflow/skill-users.test.ts`
Expected: FAIL — `writeFile`/`readFile`/`removeFiles` are not functions.

- [ ] **Step 3: Add the methods to `src/diaflow/skill-users.ts`**

Add the import at top:
```ts
import { putToPresigned } from "./upload.js";
import type { PersonalSkill, PresignedFileInfo } from "./types.js";
```
Change the constructor to accept `fetchImpl` (see Interfaces). Add inside the class:
```ts
  getFileUrl(uniqueId: string, filePath: string): Promise<string> {
    return this.client
      .request<{ url: string }>("GET", `${BASE}/${encodeURIComponent(uniqueId)}/files/${encodeFilePath(filePath)}`)
      .then((r) => r.url);
  }

  async removeFiles(uniqueId: string, paths: string[]): Promise<PersonalSkill> {
    return toPersonalSkill(
      await this.client.request<RawSkill>("DELETE", `${BASE}/${encodeURIComponent(uniqueId)}/files`, { body: { paths } }),
    );
  }

  async writeFile(uniqueId: string, path: string, content: string): Promise<void> {
    const skill = await this.get(uniqueId);
    const bytes = new TextEncoder().encode(content);
    const id = encodeURIComponent(uniqueId);
    if (path in skill.files) {
      const { upload_url, s3_key } = await this.client.request<{ upload_url: string; s3_key: string }>(
        "POST", `${BASE}/${id}/files/presigned-edit`, { body: { file_path: path } },
      );
      await putToPresigned(upload_url, bytes, "application/octet-stream", this.fetchImpl);
      await this.client.request<{ s3_key: string; file_path: string }>(
        "POST", `${BASE}/${id}/files/confirm-edit`, { body: { file_path: path, s3_key } },
      );
      return;
    }
    const presign = await this.client.request<{ files: Record<string, { upload_url: string; key: string; url: string; content_type: string }> }>(
      "POST", `${BASE}/presigned-urls`, { body: { skill_name: skill.name, files: [path] } },
    );
    const info = presign.files[path];
    if (!info) throw new Error(`presign did not return an entry for "${path}"`);
    await putToPresigned(info.upload_url, bytes, info.content_type, this.fetchImpl);
    await this.client.request<RawSkill>("POST", `${BASE}/${id}/files`, { body: { files: { [path]: info.key } } });
  }

  async readFile(uniqueId: string, path: string): Promise<string> {
    const url = await this.getFileUrl(uniqueId, path);
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`skill file read failed: HTTP ${res.status}`);
    return res.text();
  }
```

Add this helper below `toPersonalSkill` (the `{file_path:path}` route allows nested paths, so encode each segment but keep slashes):
```ts
function encodeFilePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}
```

`PresignedFileInfo` is not otherwise referenced in code; keep it in `types.ts` for consumers/tests. If `npm run build` flags it as unused, that's fine — it's an exported interface, not a local.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/diaflow/skill-users.test.ts`
Expected: PASS (9 tests total).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/diaflow/skill-users.ts tests/diaflow/skill-users.test.ts
git commit -m "feat(skills): SkillUserApi file ops (writeFile/readFile/removeFiles)"
```

---

### Task 3: `registerSkillAuthoringTools` — the 8 MCP tools

**Files:**
- Create: `src/tools/skill-authoring.ts`
- Test: `tests/tools/skill-authoring.test.ts`

**Interfaces:**
- Consumes: `SkillUserApi` (Tasks 1-2) — `list/get/create/update/remove/writeFile/readFile/removeFiles`.
- Produces: `registerSkillAuthoringTools(server: McpServer, ctx: { skillUsers: SkillUserApi }): void`.

Tool behaviour (all `skillId` = `unique_id`; default `path` = `"SKILL.md"`):
| Tool | Inputs | Calls | Returns |
|------|--------|-------|---------|
| `create_personal_skill` | `name`, `description?`, `content?` | `create`; if `content` → `writeFile(id,"SKILL.md",content)` then `get(id)` | skill JSON |
| `list_personal_skills` | — | `list()` | array JSON |
| `get_personal_skill` | `skillId` | `get` | skill JSON |
| `update_personal_skill` | `skillId`, `name?`, `description?` | `update` | skill JSON |
| `delete_personal_skill` | `skillId` | `remove` | `{ deleted: true }` |
| `write_personal_skill_file` | `skillId`, `path?`, `content` | `writeFile` | `{ written: true, path }` |
| `read_personal_skill_file` | `skillId`, `path?` | `readFile` | file text (plain) |
| `remove_personal_skill_file` | `skillId`, `path` | `removeFiles(id,[path])` | skill JSON |

- [ ] **Step 1: Write the failing test** — `tests/tools/skill-authoring.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { registerSkillAuthoringTools } from "../../src/tools/skill-authoring.js";

function fakeServer() {
  const tools: Record<string, any> = {};
  return { server: { registerTool: (n: string, _d: any, h: any) => { tools[n] = h; } }, tools };
}

const SKILL = { uniqueId: "sk1", name: "My Skill", description: "d", files: {} };

describe("skill authoring tools", () => {
  it("create_personal_skill without content just creates", async () => {
    const skillUsers = { create: vi.fn(async () => SKILL), writeFile: vi.fn(), get: vi.fn() };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    const res = await tools["create_personal_skill"]({ name: "My Skill", description: "d" });
    expect(skillUsers.create).toHaveBeenCalledWith({ name: "My Skill", description: "d" });
    expect(skillUsers.writeFile).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("sk1");
  });

  it("create_personal_skill with content creates, writes SKILL.md, returns refreshed skill", async () => {
    const skillUsers = {
      create: vi.fn(async () => SKILL),
      writeFile: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ ...SKILL, files: { "SKILL.md": "k" } })),
    };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    const res = await tools["create_personal_skill"]({ name: "My Skill", content: "# hi" });
    expect(skillUsers.writeFile).toHaveBeenCalledWith("sk1", "SKILL.md", "# hi");
    expect(skillUsers.get).toHaveBeenCalledWith("sk1");
    expect(res.content[0].text).toContain("SKILL.md");
  });

  it("write_personal_skill_file defaults path to SKILL.md", async () => {
    const skillUsers = { writeFile: vi.fn(async () => undefined) };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    const res = await tools["write_personal_skill_file"]({ skillId: "sk1", content: "x" });
    expect(skillUsers.writeFile).toHaveBeenCalledWith("sk1", "SKILL.md", "x");
    expect(res.content[0].text).toContain('"written": true');
  });

  it("read_personal_skill_file returns plain text and defaults path", async () => {
    const skillUsers = { readFile: vi.fn(async () => "# content") };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    const res = await tools["read_personal_skill_file"]({ skillId: "sk1" });
    expect(skillUsers.readFile).toHaveBeenCalledWith("sk1", "SKILL.md");
    expect(res.content[0].text).toBe("# content");
  });

  it("delete_personal_skill reports deleted", async () => {
    const skillUsers = { remove: vi.fn(async () => undefined) };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    const res = await tools["delete_personal_skill"]({ skillId: "sk1" });
    expect(skillUsers.remove).toHaveBeenCalledWith("sk1");
    expect(res.content[0].text).toContain('"deleted": true');
  });

  it("remove_personal_skill_file forwards a single-path array", async () => {
    const skillUsers = { removeFiles: vi.fn(async () => SKILL) };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    await tools["remove_personal_skill_file"]({ skillId: "sk1", path: "docs/x.md" });
    expect(skillUsers.removeFiles).toHaveBeenCalledWith("sk1", ["docs/x.md"]);
  });

  it("update_personal_skill forwards only provided fields", async () => {
    const skillUsers = { update: vi.fn(async () => SKILL) };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    await tools["update_personal_skill"]({ skillId: "sk1", name: "New" });
    expect(skillUsers.update).toHaveBeenCalledWith("sk1", { name: "New", description: undefined });
  });

  it("list_personal_skills returns the array", async () => {
    const skillUsers = { list: vi.fn(async () => [SKILL]) };
    const { server, tools } = fakeServer();
    registerSkillAuthoringTools(server as any, { skillUsers } as any);
    const res = await tools["list_personal_skills"]({});
    expect(res.content[0].text).toContain("sk1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tools/skill-authoring.test.ts`
Expected: FAIL — cannot find module `../../src/tools/skill-authoring.js`.

- [ ] **Step 3: Create `src/tools/skill-authoring.ts`**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SkillUserApi } from "../diaflow/skill-users.js";

const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] });

const SKILL_ID = "The personal skill's unique id (the uniqueId returned by create_personal_skill / list_personal_skills).";
const DEFAULT_FILE = "SKILL.md";

export function registerSkillAuthoringTools(server: McpServer, ctx: { skillUsers: SkillUserApi }): void {
  server.registerTool(
    "create_personal_skill",
    {
      description:
        "Create a new PERSONAL skill you own (name + optional description). Pass `content` to also write its SKILL.md in the same call. " +
        "This creates a skill DEFINITION; use attach_skill afterwards to add it to a teammate.",
      inputSchema: {
        name: z.string().min(1),
        description: z.string().optional(),
        content: z.string().optional().describe("Initial SKILL.md content. If given, it is written after the skill is created."),
      },
    },
    async (args) => {
      const skill = await ctx.skillUsers.create({ name: args.name, description: args.description });
      if (args.content === undefined) return asText(skill);
      await ctx.skillUsers.writeFile(skill.uniqueId, DEFAULT_FILE, args.content);
      return asText(await ctx.skillUsers.get(skill.uniqueId));
    },
  );

  server.registerTool(
    "list_personal_skills",
    { description: "List the personal skills you own.", inputSchema: {} },
    async () => asText(await ctx.skillUsers.list()),
  );

  server.registerTool(
    "get_personal_skill",
    { description: "Get one personal skill by id, including its files map.", inputSchema: { skillId: z.string().min(1).describe(SKILL_ID) } },
    async (args) => asText(await ctx.skillUsers.get(args.skillId)),
  );

  server.registerTool(
    "update_personal_skill",
    {
      description: "Update a personal skill's name and/or description. To change file CONTENT, use write_personal_skill_file instead.",
      inputSchema: { skillId: z.string().min(1).describe(SKILL_ID), name: z.string().optional(), description: z.string().optional() },
    },
    async (args) => asText(await ctx.skillUsers.update(args.skillId, { name: args.name, description: args.description })),
  );

  server.registerTool(
    "delete_personal_skill",
    { description: "Delete a personal skill you own.", inputSchema: { skillId: z.string().min(1).describe(SKILL_ID) } },
    async (args) => {
      await ctx.skillUsers.remove(args.skillId);
      return asText({ deleted: true, skillId: args.skillId });
    },
  );

  server.registerTool(
    "write_personal_skill_file",
    {
      description: "Write (create or overwrite) one file inside a personal skill. `path` defaults to SKILL.md. Content is plain text.",
      inputSchema: {
        skillId: z.string().min(1).describe(SKILL_ID),
        path: z.string().min(1).optional().describe('Relative file path within the skill. Defaults to "SKILL.md".'),
        content: z.string(),
      },
    },
    async (args) => {
      const path = args.path ?? DEFAULT_FILE;
      await ctx.skillUsers.writeFile(args.skillId, path, args.content);
      return asText({ written: true, path });
    },
  );

  server.registerTool(
    "read_personal_skill_file",
    {
      description: "Read one file's text from a personal skill. `path` defaults to SKILL.md.",
      inputSchema: { skillId: z.string().min(1).describe(SKILL_ID), path: z.string().min(1).optional().describe('Defaults to "SKILL.md".') },
    },
    async (args) => asText(await ctx.skillUsers.readFile(args.skillId, args.path ?? DEFAULT_FILE)),
  );

  server.registerTool(
    "remove_personal_skill_file",
    {
      description: "Remove one file from a personal skill by its relative path.",
      inputSchema: { skillId: z.string().min(1).describe(SKILL_ID), path: z.string().min(1) },
    },
    async (args) => asText(await ctx.skillUsers.removeFiles(args.skillId, [args.path])),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tools/skill-authoring.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Type-check**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/skill-authoring.ts tests/tools/skill-authoring.test.ts
git commit -m "feat(tools): personal-skill authoring tools (create/list/get/update/delete/file ops)"
```

---

### Task 4: Wire into context + register the tool group

**Files:**
- Modify: `src/tools/context.ts`
- Modify: `src/tools/register.ts`

**Interfaces:**
- Consumes: `SkillUserApi` (Task 1), `registerSkillAuthoringTools` (Task 3).
- Produces: `ToolContext.skillUsers: SkillUserApi`, registered unconditionally in `registerAllTools`.

- [ ] **Step 1: Modify `src/tools/context.ts`**

Add the import after line 4 (`import { SkillsApi } ...`):
```ts
import { SkillUserApi } from "../diaflow/skill-users.js";
```
Add to the `ToolContext` interface (after `skills: SkillsApi;`):
```ts
  skillUsers: SkillUserApi;
```
Add to the returned object (after `skills: new SkillsApi(client),`):
```ts
    skillUsers: new SkillUserApi(client),
```

- [ ] **Step 2: Modify `src/tools/register.ts`**

Add the import after line 7 (`import { registerSkillTools } ...`):
```ts
import { registerSkillAuthoringTools } from "./skill-authoring.js";
```
Add the registration call right after line 27 (`registerSkillTools(server, { skills: ctx.skills });`):
```ts
  registerSkillAuthoringTools(server, { skillUsers: ctx.skillUsers });
```

- [ ] **Step 3: Type-check + full test suite**

Run: `npm run build && npm test`
Expected: build clean; all tests pass (existing suite + the new `skill-users` and `skill-authoring` files). No existing test references `ToolContext` in a way that breaks from the added required field, because `buildContext` now populates it; if any test constructs a `ToolContext` literal by hand and fails to compile, add `skillUsers: new SkillUserApi(client)` (or a mock) to that literal.

- [ ] **Step 4: Commit**

```bash
git add src/tools/context.ts src/tools/register.ts
git commit -m "feat(tools): wire personal-skill authoring into context + register"
```

---

### Task 5: README tool inventory

**Files:**
- Modify: `README.md` (the "Tool inventory" section)

**Interfaces:** none (docs only).

- [ ] **Step 1: Locate the skills group in the inventory**

Run: `grep -n "attach_skill\|list_teammate_skills\|## Tool inventory\|skills" README.md`
Expected: finds the skills subsection listing `list_teammate_skills`, `list_available_skills`, `attach_skill`, `detach_skill`.

- [ ] **Step 2: Add the new tools**

Under the skills group (or a new "skill authoring" subgroup adjacent to it), add entries describing the 8 new tools, matching the surrounding formatting exactly:
```
- **create_personal_skill** — create a personal skill you own (name/description, optional SKILL.md content).
- **list_personal_skills** — list personal skills you own.
- **get_personal_skill** — get one personal skill (incl. its files map).
- **update_personal_skill** — update a personal skill's name/description.
- **delete_personal_skill** — delete a personal skill you own.
- **write_personal_skill_file** — create/overwrite one file (defaults to SKILL.md).
- **read_personal_skill_file** — read one file's text (defaults to SKILL.md).
- **remove_personal_skill_file** — remove one file by path.
```
Adjust bullet/heading style to match how the existing skill tools are listed (verify with the grep output before editing).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add personal-skill authoring tools to README inventory"
```

---

## Self-Review

**1. Spec coverage:**
- CRUD (create/list/get/update/delete) → Task 1 + Task 3. ✅
- File ops (write/read/remove) with presign→PUT→persist branching → Task 2 + Task 3. ✅
- `create_personal_skill` two-hop (create then write SKILL.md) → Task 3 handler. ✅
- Types `PersonalSkill`/`PresignedFileInfo` → Task 1. ✅
- Context + register wiring, unconditional → Task 4. ✅
- Tool naming explicit (`personal_skill`) → Task 3. ✅
- Reuse `putToPresigned` → Task 2. ✅
- Tests mirror existing patterns → all tasks. ✅
- README inventory → Task 5. ✅
- Deferred items (workspace skills, zip-status polling, in-place file rename, import/generate) → correctly absent. ✅

**2. Placeholder scan:** No TBD/TODO; every code step has full code; every test has assertions. ✅

**3. Type consistency:** `SkillUserApi` methods (`list/get/create/update/remove/writeFile/readFile/removeFiles/getFileUrl`), `PersonalSkill.uniqueId`, and the `{ skillUsers }` ctx shape are identical across Tasks 1-4. Tool names identical across Task 3 and Task 5. `content_type` (snake) on the new-file presign vs the `"application/octet-stream"` literal on the edit PUT is intentional and consistent with the backend (edit presign returns only `{upload_url, s3_key}`). ✅
