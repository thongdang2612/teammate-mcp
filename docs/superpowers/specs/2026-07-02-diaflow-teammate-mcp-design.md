# diaflow-teammate-mcp — Design Spec

**Date:** 2026-07-02
**Status:** Draft — awaiting user review
**Author:** brainstormed with Claude Code

## 1. Purpose

A custom **MCP (Model Context Protocol) server** that exposes Diaflow's **Teammate** module as LLM-callable tools: read teammates, create them, update their info (name, model, description, instruction, avatar, tags…), attach/detach skills, and manage their lifecycle (publish / offboard / rehire / permanent delete). It is designed to be **published on a remote server** with **real per-user WorkOS authentication**.

It also supports **conversing with teammates** — posting a message to a teammate and getting its reply — which enables agent-to-agent **orchestration** (a teammate, via this MCP, messages other teammates and combines their answers), plus **sub-agent** management for Diaflow's native orchestrator pattern.

Non-goal (v1): authoring skill *files* (the separate skill-file presign/upload/confirm flow — v1 only attaches/detaches existing skills); live token **streaming** of replies (v1 uses synchronous `stream:false` completions; streaming relay is a later enhancement).

### Conversation / runtime endpoints (verified)

- **Send message:** `POST /api/v1/agent-runtime/completions` — OpenAI-style; accepts our sealed-session Bearer. Use `stream:false` → sync JSON `{ thread_id, session_id, choices:[{message:{role,content}}], usage }`. Body: `{ messages:[{role:"user",content}], stream:false, agent_unique_id, thread_id?, files?:[{filename,path,size?,artifact_url?}], web_search_enabled? }`. `session_id == thread_id`; omit `thread_id` on turn 1 (returned in response), replay it to continue. **Response is snake_case** (unlike the camelCase `/agents` endpoints) — the client must not assume camel here.
- **Sessions:** `GET /agent-runtime/sessions` (list); `GET /agent-runtime/sessions/{id}/history?limit&before_sequence` (durable history); `POST /agent-runtime/sessions/{id}/stop` (cancel a run); `DELETE`/`PUT` for delete/rename.
- **Chat attachments:** `POST /api/v1/drives/s3/presigned` with folder `agent-workspace/{threadId|'new'}/uploads/<dd-mm-yy>` → PUT bytes → reference as `files:[{filename,path:<key>,artifact_url:<cdnUrl>}]` in the completions body.
- **Sub-agents (orchestrator setup):** `GET /agents/{uid}/sub-agents` (list); `POST /agents/{uid}/sub-agents` `{subAgentUniqueId}` (attach existing); `POST /agents/{uid}/sub-agents/create` (create+attach); `DELETE /agents/{uid}/sub-agents/{subUid}` (detach). Runtime delegation to sub-agents is internal to a single orchestrator completion (surfaced as `skill` events with `subagent_task_id`); there is no direct per-sub-agent message endpoint.

## 2. Key facts about the Diaflow API (verified in source)

- **Naming:** product term "Teammate" == backend/URL term `agent`. All endpoints live under `/api/v1/agents`.
- **Base URL:** `${DIAFLOW_API_BASE}/api/v1`.
- **Response envelope:** JSON, camelCase on the wire (backend uses `to_camel_case` alias generator). Lists return `{ total, results[] }`.
- **Auth** (`diaflow-backend/modules/api/deps.py:388-473`) — `get_current_user` accepts, in order:
  1. WorkOS **sealed-session cookie** (`SESSION_COOKIE_NAME`).
  2. WorkOS **sealed session as `Authorization: Bearer <seal>`** (native-app path, DP-1443). Detected via `workos.session.unseal_data(token, WORKOS_COOKIE_PASSWORD)`.
  3. **Legacy JWT** signed with Diaflow `SECRET_KEY`.
  - **Diaflow does NOT accept a raw WorkOS OAuth access token.** This drives the auth design (§4).
- **Workspace scoping:** optional `Workspace-Id` request header; when present it must match the authenticated user's workspace or the request is 403 (`_enforce_workspace_id_header`). Teammate queries are scoped to the caller's workspace.

### 2.1 Endpoint reference (source of truth)

Teammate CRUD/lifecycle — `diaflow-backend/modules/agent_builder/presentation/rest/router.py`:

| Tool intent | Method + path | Notes |
|---|---|---|
| List | `GET /agents?page&pageSize&lifecycle&filter&orderBy` | `lifecycle` = `active`(default)\|`offboarded`; → `{total, results[]}` |
| Get | `GET /agents/{uniqueId}` | full `AgentResponse`; offboarded → stripped profile |
| Create | `POST /agents` | required `modelProvider`,`modelName`; optional `name,title,icon,description,instruction,welcomeMessage,intelligence,starterPrompts[],tags[]`; `extra="forbid"` |
| Check name | `POST /agents/check-name` | `{name}` → `{isDuplicate}` |
| Update | `PATCH /agents/{uniqueId}` | **body is dict-of-dicts**: `{ "main": {…AgentUpdate}, "<subUid>": {…} }`; all fields optional |
| Publish | `POST /agents/{uniqueId}/publish` | draft → published |
| Offboard | `POST /agents/{uniqueId}/offboard` | reversible soft-delete (30-day) |
| Rehire | `POST /agents/{uniqueId}/rehire` | offboarded → active (quota-checked) |
| Permanent delete | `DELETE /agents/{uniqueId}/permanent` | 409 `permanent_delete_conflict` if not offboarded first; 204 on success |
| Legacy delete | `DELETE /agents/{uniqueId}` | now only offboards |

`AgentUpdate` / `AgentCreate` fields: `name, title, modelProvider, modelName, modelConfig, outputFormat, icon, description, instruction, welcomeMessage, intelligence, starterPrompts[{title,prompt}], tags[]`. `icon` is a plain string (an S3 key or preset URL).

Skills (attach/detach) — same router:

| Tool intent | Method + path |
|---|---|
| List attached | `GET /agents/{uid}/skill-agents` |
| List available | `GET /agents/{uid}/skill-agents/available` |
| Attach | `POST /agents/{uid}/skill-agents/attach` — body one of `{skillWorkspaceId}`\|`{skillSystemId}`\|`{skillUserId}` |
| Detach | `DELETE /agents/{uid}/skill-agents?skill{Workspace,System,User}Id=` |

Avatar / upload:

| Tool intent | Method + path |
|---|---|
| Preset picker | `GET /avatars` → `{results:[{url, category}]}` (curated, active only) |
| Custom presign | `POST /drives/s3/presigned` — body `{name, type, folder?, file_size?}` → `{uploadUrl, key, url, metadata_id}` |
| S3 upload | raw `PUT <uploadUrl>` with header `Content-Type: <mime>`, body = raw bytes, **no auth header** (signature is in the URL) |
| Persist | set `icon = <key>` via `POST/PATCH /agents` |

### 2.2 The avatar upload flow (the "special" process)

Mirrors `diaflow-expo/packages/fe-core/src/api/upload-api.ts` + `.../domain/teammates/upload-teammate-icon.ts`:

1. **Presign:** `POST /api/v1/drives/s3/presigned` with `{ name: "<teammateId>_<slug(filename)>", type: <mime>, folder: "agent-teammate-icons/<dd-mm-yy>", file_size: <bytes> }` → `{ uploadUrl, key, url }`.
2. **Upload:** raw `PUT <uploadUrl>`, header `Content-Type: <mime>`, body = raw file bytes. No `Authorization`. Success = 2xx.
3. **Persist:** `PATCH /agents/{uniqueId}` body `{ main: { icon: <key> } }` (or `icon` at create).

Notes: folder date format is `dd-mm-yy` (`buildModulePath`). Filename for edits is deterministic (`<teammateId>_<slug>`), overwriting on re-upload. Max size 10 MB (`TEAMMATE_ICON_MAX_SIZE_BYTES`). The stored `icon` is an S3 key, resolved for *display* via a separate CDN-signing mechanism (out of scope — the MCP only writes the key).

## 3. Architecture

- **Runtime:** TypeScript, `@modelcontextprotocol/sdk`. Client behavior is ported ~1:1 from the documented `diaflow-expo` TS client.
- **Transport:** Streamable HTTP (remote, publishable) + stdio (local dev), selected by config.
- **Design principle:** many small, single-purpose files (<300 lines); typed boundaries; immutable request/response shaping; zod validation at the tool boundary.

### 3.1 Module layout

```
src/
  index.ts               # bootstrap; pick transport (http|stdio); wire OAuth + tools
  config.ts              # zod-validated env loading
  auth/
    token-provider.ts    # TokenProvider interface (getToken/onRotate); WorkOSSessionProvider (+ StaticTokenProvider fallback)
    magic-auth.ts        # native magic-auth client: send/verify → seal in body; workspace/select
    session-store.ts     # per-user store: current seal + workspace + rotation metadata (mem | redis)
  diaflow/
    client.ts            # base http client: injects Bearer seal + Workspace-Id, unwraps envelope, maps errors
    teammates.ts         # agent CRUD + lifecycle calls
    skills.ts            # skill-agents attach/detach/list
    avatars.ts           # GET /avatars
    upload.ts            # presignUpload, putToPresigned, uploadRemoteImage
    types.ts             # Agent, AgentDetail, Skill, Presign types (ported)
    errors.ts            # DiaflowHttpError + {code,message} mapping
  tools/
    read.ts              # list_teammates, get_teammate
    write.ts             # create_teammate, update_teammate, check_teammate_name
    avatar.ts            # set_teammate_avatar, list_preset_avatars
    skills.ts            # list_teammate_skills, list_available_skills, attach_skill, detach_skill
    lifecycle.ts         # publish/offboard/rehire/delete_teammate
    workspace.ts         # list_workspaces, set_workspace
    register.ts          # registers all tools; resolves per-call auth + workspace context
  utils/
    upload-paths.ts      # buildModulePath -> "<folder>/<dd-mm-yy>"
    slug.ts
```

### 3.2 Data flow

```
Connect (once per user, headless):
  connect_diaflow(email) ─► POST /auth/magic-auth/send   (X-Client: native, no Origin)
  user pastes emailed code ─► POST /auth/magic-auth/verify ─► session = SEAL (in body)
  [if >1 workspace] POST /auth/workspace/select ─► workspace-scoped SEAL → session-store

Per tool call:
  MCP client (Claude) ─► MCP server
     └─ session-store → current seal
     └─ diaflow/client: Authorization: Bearer <seal> + Workspace-Id + X-Client: native ─► /api/v1/agents/...
     ◄─ response (+ rotated seal via X-Diaflow-Session header) → session-store updates
```

## 4. Authentication (decision: third-party WorkOS session capture + forward)

**Context:** We are a *third-party Diaflow user*, not the Diaflow team — no Diaflow source dependency, no Diaflow secrets. Ruled out:
- **User API key** (`X-API-KEY`) — `/agents` uses `get_current_user`, which does not check the API-key path. Not usable on teammate endpoints.
- **Legacy `POST /auth/login` → JWT** — works today but is *deprecated pending the WorkOS cutover* and will be removed. Do not build on it.
- **Minting our own seal** (first-party AuthKit + `WORKOS_COOKIE_PASSWORD`) — requires Diaflow's secret. Off the table.

**Decision: replay Diaflow's real WorkOS login in a browser, capture the sealed-session cookie Diaflow sets, forward it on every API call, and auto-rotate it.** Diaflow's backend mints and sets the sealed session (`SESSION_COOKIE_NAME`) server-side after a successful WorkOS login — so we obtain a valid, RBAC/WorkOS-claim-bearing credential **without any Diaflow secret**. `get_current_user` accepts it as a cookie (path 1) or as `Authorization: Bearer <seal>` (path 2, DP-1443).

Implemented as a swappable `TokenProvider` so future official access (API key / OAuth) is a drop-in:

**`WorkOSSessionProvider` (the v1 provider) — replicates the React Native login, fully headless (no browser):**

The native path returns the sealed session **in the JSON body** in the **`session`** field of `WorkspaceSelectResponse` (a Fernet `gAAAAA…` token; `access_token` stays null — that slot is the deprecated legacy JWT). Gated by two client-settable conditions we satisfy: header **`X-Client: native`** AND **no `Origin`/`Referer`** header (`deps.py native_session_in_body_allowed`). Endpoints under `workos_auth` (no extra prefix beyond `/api/v1`). **Verified 2026-07-02** against a real account: send→verify returns `session`, and `GET /api/v1/agents` with `Authorization: Bearer <session>` + `Workspace-Id` + `X-Client: native` → 200.

1. **Connect — magic-auth (device-code style, once per user):**
   - `POST /api/v1/auth/magic-auth/send` `{ email }` (headers `X-Client: native`, no Origin) → Diaflow emails a code.
   - User pastes the code into the MCP (a `connect_diaflow` tool / bootstrap prompt).
   - `POST /api/v1/auth/magic-auth/verify` `{ email, code }` (native headers) → `WorkspaceSelectResponse` with **`session` = sealed session**, `workspaceId`, `subdomain`.
   - If workspace selection is required: `POST /api/v1/auth/workspace/select` `{ workspaceId }` (Bearer = seal, native headers) → workspace-scoped seal.
   - Store `{ seal, workspaceId }` per user in `session-store`.
2. **Call:** forward `Authorization: Bearer <seal>` + `Workspace-Id` on every `/api/v1/agents` request, always with `X-Client: native` and no Origin.
3. **Rotate/stay-alive:** on each response, capture the rotated seal from the **`X-Diaflow-Session`** header (BEARER carrier, `workos_session_manager.py`) and replace the stored one. Re-prompt `connect_diaflow` only when refresh finally fails (401).

Secondary: SSO-only accounts that can't use magic-auth need the browser-based `GET /auth/authorize` → `POST /auth/oauth-exchange` path; deferred to a later `OAuthExchangeProvider`. `StaticTokenProvider` (paste a seal) remains the always-works fallback.

**No browser, no Diaflow/WorkOS secrets, no cross-domain cookie problem** — the seal arrives in an API response body.

### 4.1 Required setup (operator / user)

1. `DIAFLOW_API_BASE` and the user's **workspace id** (or rely on the single-workspace default from verify).
2. The user's Diaflow **email** (magic-auth) — the code is entered interactively at connect time. No password stored.
3. Per-user **session store** (Redis/DB) for prod holding the current seal (+ workspace); in-memory for dev.
4. Public HTTPS host for the remote deployment.
5. **No WorkOS/Diaflow secrets, no browser runtime** required.

### 4.2 De-risking spike — ✅ DONE (verified 2026-07-02)

Verified end-to-end with plain HTTP against a real account: (a) `magic-auth/send` → `magic-auth/verify` with `X-Client: native` + no Origin returns the seal in the **`session`** field (`gAAAAA…` Fernet); (b) `GET /api/v1/agents` with `Authorization: Bearer <session>` + `Workspace-Id` + `X-Client: native` → **200** `{total,results}`; single-workspace account, so no `workspace/select` needed. **Still to observe during implementation:** the **`X-Diaflow-Session`** rotation header + session lifetime (appears near expiry). **Fallbacks:** `StaticTokenProvider` (manual seal paste) or the `oauth-exchange` browser path for SSO-only accounts.

## 5. Configuration (env, zod-validated at startup)

`DIAFLOW_API_BASE`, `MCP_PUBLIC_URL`, `MCP_TRANSPORT` (`http`|`stdio`), `SESSION_STORE` (`memory`|`redis`) + `REDIS_URL`, optional `DIAFLOW_TOKEN` (StaticTokenProvider fallback). Per-user email + workspace are supplied at connect time, not as global config. **No WorkOS/Diaflow secrets, no browser runtime.** No secrets hardcoded.

## 6. Tools (v1 surface)

**Workspace:** default to the session's workspace; `set_workspace({workspaceId})` overrides for the session; every teammate tool accepts an optional `workspaceId` override. `list_workspaces()` if a workspaces endpoint is available.

| Tool | Input (zod) | Backend call |
|---|---|---|
| `connect_diaflow` | `email` → then `code` (two-step) | `POST /auth/magic-auth/send` + `/verify` (+ `workspace/select`) |
| `auth_status` | — | reports connected/expired + active workspace |
| `list_teammates` | `page?, pageSize?, lifecycle?, search?, orderBy?, workspaceId?` | `GET /agents` |
| `get_teammate` | `teammateId, workspaceId?` | `GET /agents/{id}` |
| `create_teammate` | `modelProvider, modelName, name?, title?, description?, instruction?, welcomeMessage?, intelligence?, starterPrompts?, tags?, avatarUrl?, workspaceId?` | `POST /agents` (+ avatar flow if `avatarUrl`) |
| `update_teammate` | `teammateId, <any AgentUpdate fields>, workspaceId?` | `PATCH /agents/{id}` `{main:{…}}` |
| `check_teammate_name` | `name, workspaceId?` | `POST /agents/check-name` |
| `set_teammate_avatar` | `teammateId, imageUrl, workspaceId?` | preset shortcut OR presign→PUT→PATCH |
| `list_preset_avatars` | `category?` | `GET /avatars` |
| `list_teammate_skills` | `teammateId, workspaceId?` | `GET /agents/{id}/skill-agents` |
| `list_available_skills` | `teammateId, workspaceId?` | `GET …/skill-agents/available` |
| `attach_skill` | `teammateId, skillWorkspaceId?\|skillSystemId?\|skillUserId?, workspaceId?` | `POST …/skill-agents/attach` |
| `detach_skill` | `teammateId, skillWorkspaceId?\|skillSystemId?\|skillUserId?, workspaceId?` | `DELETE …/skill-agents` |
| `publish_teammate` | `teammateId, workspaceId?` | `POST …/publish` |
| `offboard_teammate` | `teammateId, workspaceId?` | `POST …/offboard` |
| `rehire_teammate` | `teammateId, workspaceId?` | `POST …/rehire` |
| `delete_teammate` | `teammateId, force?, workspaceId?` | `DELETE …/permanent` (if `force`, offboard first) |
| `message_teammate` | `teammateId, message, threadId?, attachmentUrls?, webSearch?` | `POST /agent-runtime/completions` (`stream:false`); returns `{threadId, reply}` |
| `list_conversations` | `agentId?, page?, pageSize?` | `GET /agent-runtime/sessions` |
| `get_conversation` | `sessionId, limit?` | `GET /agent-runtime/sessions/{id}/history` |
| `stop_conversation` | `sessionId` | `POST /agent-runtime/sessions/{id}/stop` |
| `list_sub_agents` | `teammateId` | `GET /agents/{uid}/sub-agents` |
| `add_sub_agent` | `teammateId, subAgentId` | `POST /agents/{uid}/sub-agents` `{subAgentUniqueId}` |
| `create_sub_agent` | `teammateId, modelProvider, modelName, name?, …` | `POST /agents/{uid}/sub-agents/create` |
| `remove_sub_agent` | `teammateId, subAgentId` | `DELETE /agents/{uid}/sub-agents/{subUid}` |

## 7. Error handling

- `diaflow/client` throws `DiaflowHttpError { status, code?, message, detail? }`. Lifecycle 4xx bodies are `{code, message}` — surface `code` (e.g. `permanent_delete_conflict`) so the tool result is actionable.
- Tool layer converts `DiaflowHttpError` into a structured MCP tool error with a human message + machine `code`. Never swallow.
- Upload: guard size (≤10MB), sniff/validate content-type, timeout + abort on the download and the S3 PUT, verify 2xx before persisting the key.
- Auth: 401 → refresh-and-retry-once → else signal re-auth.

## 8. Testing (TDD, ≥80%)

- **Unit:** `diaflow/client` (mocked fetch: envelope unwrap, header injection, error mapping); `upload` (presign→PUT ordering, size/type guards, PUT sends no auth header + correct Content-Type); `auth` (seal storage, refresh-on-expiry, retry-once); every tool's zod schema (valid/invalid).
- **Integration:** run tools against a mock Diaflow HTTP server asserting exact request shapes (dict-of-dicts PATCH body, presign payload, attach body variants).
- **Auth spike test** (§4.2) gates the rest.

## 9. Open questions

1. Exact `X-Diaflow-Session` rotation lifetime; whether `workspace/select` is required for multi-workspace accounts; and the magic-auth verify response shape when workspace selection is pending (resolved by §4.2 spike). SSO-only accounts (no magic-auth) need the deferred `oauth-exchange` browser path.
2. Is there a `/workspaces` list endpoint for `list_workspaces`, or is the workspace fixed per session? (Confirm during implementation; degrade to session-only if absent.)
3. Does `create_teammate` accept `avatarUrl` inline (upload-then-create), or must avatar be set post-create via `set_teammate_avatar`? (Create takes a plain `icon` string; simplest is: create, then run avatar flow, then patch. Confirm ordering.)
4. Preset-vs-custom detection in `set_teammate_avatar`: treat any Diaflow-owned CDN/avatar host URL as a direct-set; everything else as download+presign+upload. Confirm the host allowlist.
