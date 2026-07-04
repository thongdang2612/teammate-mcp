# Personal-Skill Authoring — Design Spec

**Date:** 2026-07-04
**Status:** Approved for planning
**Author:** brainstormed with the user

## Goal

Let an MCP caller **author and edit personal skills** (Diaflow `skill_user`), not just
attach/detach existing skills to a teammate. Full CRUD plus editing the skill's file
content (the `SKILL.md` bundle). A complete loop becomes:
`create_personal_skill` → SKILL.md written → `attach_skill` to a teammate.

## Scope

**In scope:** create / list / get / update / delete a personal skill, and
write / read / remove its files — for **personal skills only** (`skill_user`,
`/agents/skill-users/*`), which the authenticated caller fully owns.

**Out of scope (deliberate):**
- **Workspace skills** (`/agents/skill-workspaces/*`) — org-scoped writes need
  Administrator+/`org.skills:write`; not this iteration.
- **System skills** (`/agents/skill-templates`) — admin-only, read-only for us.
- **Async zip status polling** — create/add-files/update trigger an async server-side
  `.skill` zip rebuild; authoring + attaching does not need to block on it. Not exposed
  in v1 (YAGNI).
- **In-place single-file rename** — Diaflow has no wired endpoint for it (the
  `RenameSkillFileUseCase` exists but is unrouted); a rename is remove + write.
- **Import (zip / URL) and LLM `generate`** — separate capabilities, not needed for
  author-and-attach.

## Backend contract (verified against `diaflow-backend`, read-only reference)

Router: `modules/agent_builder/presentation/rest/personal_skill_router.py`, mounted at
`/agents/skill-users`. All endpoints authenticate via `get_current_user` and scope every
row by `user_id` (ownership) + `workspace_id`. **Responses are bare Pydantic models**
(no `{data,message,status}` envelope); `DELETE` returns **204**. Errors are FastAPI
`HTTPException` with a `detail` string.

| Op | Method + path | Request body | Response |
|----|---------------|--------------|----------|
| Create | `POST /agents/skill-users` | `SkillUserCreate {name, description?, files?}` (`files` = `{relative_path: s3_key}`, default `{}`) | `SkillUserResponse` (201) |
| List | `GET /agents/skill-users` | — (supports `skip`/`limit` filter) | `SkillUserResponse[]` |
| Get | `GET /agents/skill-users/{unique_id}` | — | `SkillUserResponse` |
| Update | `PATCH /agents/skill-users/{unique_id}` | `AgentSkillUpdate {name?, description?, files?}` (all optional) | `SkillUserResponse` |
| Delete | `DELETE /agents/skill-users/{unique_id}` | — | 204 |
| Presign new files | `POST /agents/skill-users/presigned-urls` | `AgentSkillPresignedUrlRequest {skill_name, files: string[]}` (paths only) | `AgentSkillPresignedUrlResponse {files: {path: {upload_url, key, url, content_type}}}` |
| Persist files | `POST /agents/skill-users/{unique_id}/files` | `AgentSkillAddFilesRequest {files: {path: s3_key}}` | `SkillUserResponse` |
| Presign edit (existing file) | `POST /agents/skill-users/{unique_id}/files/presigned-edit` | `{file_path}` | `{upload_url, s3_key}` |
| Confirm edit | `POST /agents/skill-users/{unique_id}/files/confirm-edit` | `{file_path, s3_key}` | `{s3_key, file_path}` |
| Remove files | `DELETE /agents/skill-users/{unique_id}/files` | `AgentSkillRemoveFilesRequest {paths: string[]}` | `SkillUserResponse` |
| Read file | `GET /agents/skill-users/{unique_id}/files/{file_path:path}` | — | `{url}` (CloudFront-signed) |

Key backend facts that drive the design:

1. **`presigned-urls` looks the skill up by NAME** (`get_by_name_for_user`), not
   `unique_id` — because the S3 key embeds `skill.unique_id` + `skill.name`. So the
   new-file path needs the skill's `name`, obtained from a prior `get`.
2. **The skill must exist before any file can be presigned** (the S3 key embeds its
   `unique_id`). Therefore "create with content" is two hops: create the (empty) skill,
   then write `SKILL.md`.
3. **Presigned PUT content-type is `application/octet-stream`** (both presign paths). The
   direct-to-S3 PUT must send that same content-type (the presign response returns it —
   use it verbatim).
4. **`confirm-edit` validates** the new `s3_key` shares the old key's prefix and file
   extension. We pass back exactly the `s3_key` that `presigned-edit` returned, so this
   always holds.
5. **Referenced skills are read-only.** A personal skill imported *by reference* (from a
   system/workspace skill) stores no own `files` — `presigned-edit`/`files` writes 404
   ("file not found in skill") because `skill.files` is empty. The tools target
   self-authored skills; this surfaces as a plain error, which is correct.
6. **Async zip rebuild** fires automatically inside the create/add-files/update use cases
   (`create_skill_user_zip`). We do not wait on it.

## Architecture

Two new modules, mirroring the existing `SkillsApi` (`src/diaflow/skills.ts`) +
skills tools (`src/tools/skills.ts`) split. Reuse `putToPresigned` from
`src/diaflow/upload.ts` for the direct-to-S3 byte upload (already used for avatars).

### New: `src/diaflow/skill-users.ts` — `SkillUserApi`

Thin wrappers over the endpoints above, plus two **cohesive operations** that hide the
S3 dance:

```
class SkillUserApi {
  constructor(client: DiaflowClient)

  // Direct endpoint wrappers
  list(): Promise<PersonalSkill[]>
  get(uniqueId: string): Promise<PersonalSkill>
  create(input: { name: string; description?: string; files?: Record<string,string> }): Promise<PersonalSkill>
  update(uniqueId: string, fields: { name?: string; description?: string }): Promise<PersonalSkill>
  remove(uniqueId: string): Promise<void>                       // 204
  removeFiles(uniqueId: string, paths: string[]): Promise<PersonalSkill>
  getFileUrl(uniqueId: string, filePath: string): Promise<string>   // returns { url } → url

  // Cohesive operations (presign → PUT bytes → persist)
  writeFile(uniqueId: string, path: string, content: string): Promise<void>
  readFile(uniqueId: string, path: string): Promise<string>
}
```

**`writeFile(uniqueId, path, content)`**:
1. `skill = await get(uniqueId)` — need `skill.name` (new-file presign is by name) and
   `skill.files` (to choose the branch).
2. `bytes = new TextEncoder().encode(content)`.
3. If `path` already in `skill.files`:
   a. `{ upload_url, s3_key } = POST …/files/presigned-edit {file_path: path}`
   b. `putToPresigned(upload_url, bytes, "application/octet-stream")`
   c. `POST …/files/confirm-edit {file_path: path, s3_key}`
   Else (new file):
   a. `resp = POST /agents/skill-users/presigned-urls {skill_name: skill.name, files: [path]}`
   b. `info = resp.files[path]`; `putToPresigned(info.upload_url, bytes, info.content_type)`
   c. `POST …/{uniqueId}/files {files: {[path]: info.key}}`

**`readFile(uniqueId, path)`**: `url = await getFileUrl(uniqueId, path)`; then
`fetch(url)` → `res.text()`. Uses the client's `fetchImpl` (injectable for tests).

### New: `src/tools/skill-authoring.ts` — 8 MCP tools

`register` takes `{ skillUsers: SkillUserApi }`. Tool → API mapping:

| Tool | Inputs | Behaviour |
|------|--------|-----------|
| `create_personal_skill` | `name`, `description?`, `content?` | `create({name, description})`; if `content` given, `writeFile(id, "SKILL.md", content)` then re-`get` to return the updated skill |
| `list_personal_skills` | — | `list()` |
| `get_personal_skill` | `skillId` | `get(skillId)` |
| `update_personal_skill` | `skillId`, `name?`, `description?` | `update(skillId, {name, description})` |
| `delete_personal_skill` | `skillId` | `remove(skillId)` → `{ deleted: true }` |
| `write_personal_skill_file` | `skillId`, `path?` (default `"SKILL.md"`), `content` | `writeFile(skillId, path, content)` → `{ written: true, path }` |
| `read_personal_skill_file` | `skillId`, `path?` (default `"SKILL.md"`) | `readFile(skillId, path)` → file text (plain) |
| `remove_personal_skill_file` | `skillId`, `path` | `removeFiles(skillId, [path])` |

Tool names are deliberately explicit (`personal_skill`) so the model never confuses these
skill-**authoring** tools with the existing teammate-**attachment** tools
(`attach_skill` / `detach_skill` / `list_teammate_skills` / `list_available_skills`).
`skillId` is the skill's `unique_id`.

### Edits

- `src/diaflow/types.ts` — add `PersonalSkill` and the presign response types.
- `src/tools/context.ts` (`buildContext`) — construct `skillUsers: new SkillUserApi(client)`
  and add it to `ToolContext`.
- `src/tools/register.ts` — register the new tool group **unconditionally** (like the
  read/write/skills groups). Not auth/workspace-gated: personal skills are scoped by the
  authenticated user, which works in both OAuth per-user and static-token modes.
- `src/diaflow/upload.ts` — no change; `putToPresigned` is already exported.

## Types (`src/diaflow/types.ts`)

```ts
export interface PersonalSkill {
  id: number;
  uniqueId: string;          // maps from unique_id
  workspaceId: number;
  userId: number;
  name: string;
  description: string | null;
  files: Record<string, string>;   // relative_path -> s3_key
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PresignedFileInfo {
  uploadUrl: string;    // upload_url
  key: string;
  url: string;
  contentType: string;  // content_type
}
```

**Field mapping:** the backend returns snake_case (`unique_id`, `upload_url`,
`content_type`, `skill_system_id`, …). `SkillUserApi` maps the fields it needs into the
camelCase interfaces above. Only the fields the tools use need mapping; extras are
ignored. (This mirrors how existing API modules adapt Diaflow responses.)

## Error handling

- Non-2xx from any Diaflow call → `DiaflowHttpError` (thrown by `client.request`),
  surfaced to the caller as the tool's error text — consistent with existing tools.
- The S3 PUT (`putToPresigned`) throws on non-2xx; `writeFile` lets it propagate.
- Writing to a **referenced** (read-only) skill → backend 404 "file not found in skill"
  → surfaced as-is. Acceptable: it correctly tells the caller the skill isn't editable.
- `read_personal_skill_file` on a missing path → backend 404 → surfaced.
- Validation at the tool boundary via Zod: `name`/`content` non-empty strings,
  `skillId`/`path` non-empty strings.

## Testing (TDD, mocked — no live backend)

Mirror existing patterns in `tests/diaflow/skills.test.ts` and `tests/tools/skills.test.ts`.

**`tests/diaflow/skill-users.test.ts`** — mock `DiaflowClient` (and `fetchImpl` for S3
PUT + file read):
- `create` / `list` / `get` / `update` / `remove` hit the right method+path (verify 204
  handling for `remove`).
- `writeFile` **new-file branch**: `get` → `presigned-urls` (by `skill.name`) → PUT to
  `upload_url` with returned `content_type` → `POST …/files` with `{path: key}`. Assert
  the exact call sequence and payloads.
- `writeFile` **edit branch** (path already in `skill.files`): `presigned-edit` → PUT →
  `confirm-edit` with the returned `s3_key`. Assert sequence.
- `readFile`: `getFileUrl` → `fetch(url)` → returns text.
- `removeFiles`: DELETE with `{paths}`.

**`tests/tools/skill-authoring.test.ts`** — mock `SkillUserApi`:
- Each of the 8 tools forwards the right args and formats output (plain text for
  `read_personal_skill_file`; JSON for the rest).
- `create_personal_skill` with `content` calls `create` then `writeFile("SKILL.md", …)`
  then returns the refreshed skill; without `content`, only `create`.
- `write_personal_skill_file` defaults `path` to `"SKILL.md"`.

Coverage target ≥ 80% for the new modules (project standard).

## Global constraints

- **TypeScript, ESM/NodeNext, Zod v4, Vitest** — match the existing codebase.
- **Reference repos are read-only** — do not modify `diaflow-backend` / `diaflow-expo`.
- **No secrets in code**; auth flows unchanged (reuse `DiaflowClient`).
- **Immutable style, small focused files** (per repo rules): API module and tools module
  each stay well under the size limits.
- Follow existing `asText` / `errText` tool-response helpers and `TEAMMATE_ID_DESC`-style
  shared descriptions where relevant.

## Open questions

None. (Workspace-skill authoring and async-status polling are explicitly deferred, not
unresolved.)
