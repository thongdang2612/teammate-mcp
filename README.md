# diaflow-teammate-mcp

An MCP (Model Context Protocol) server that exposes Diaflow's **Teammate** module — Diaflow's AI agents/assistants — as LLM-callable tools. It wraps the Diaflow HTTP API for listing/creating/updating teammates, managing avatars (via a two-step S3 presign-then-upload flow), attaching skills, running the publish/offboard/rehire lifecycle, sending messages, managing sub-agents, and registering itself as a Diaflow custom MCP so a Diaflow teammate can call it directly.

It speaks MCP over both **stdio** (for local clients like Claude Desktop) and **Streamable HTTP** (for remote/hosted deployments, including being registered as a Diaflow custom-MCP resource).

## Install

Requires Node.js >= 20.

```bash
npm install
```

## Configure

Copy `.env.example` to `.env` and fill in the values you need:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `DIAFLOW_API_BASE` | yes | Base URL of the Diaflow backend, e.g. `https://api.diaflow.io`. All API calls are made against `${DIAFLOW_API_BASE}/api/v1/...`. |
| `MCP_TRANSPORT` | no (default `stdio`) | `stdio` for a local process-per-client server, or `http` to run a Streamable-HTTP server. |
| `MCP_HTTP_PORT` | no (default `8787`) | Port the HTTP transport listens on. Only used when `MCP_TRANSPORT=http`. |
| `MCP_PUBLIC_URL` | only for custom-MCP registration | The public `https://.../mcp` URL this server is reachable at. Required to call `register_self_as_custom_mcp` — Diaflow rejects `http://`/localhost/private URLs. |
| `MCP_INBOUND_TOKEN` | recommended for any non-local HTTP deploy | Bearer token that callers must present (`Authorization: Bearer <token>`) on every request to `/mcp`. This is also the value you register as the custom-MCP resource's `key`, so Diaflow authenticates itself back to this server. If unset, the HTTP transport accepts unauthenticated requests — fine for local dev, unsafe for a public deploy. |
| `DIAFLOW_TOKEN` | optional | A non-interactive Diaflow "sealed session" token. When set, the server skips the interactive `connect_diaflow`/`submit_code` flow entirely and authenticates every request with this fixed token (see `StaticTokenProvider`). Use this for service/teammate-runtime deployments where there is no human to click through a magic-code login. Ignored when `MCP_AUTH_MODE=oauth`. |
| `DIAFLOW_WORKSPACE_ID` | optional, pairs with `DIAFLOW_TOKEN` | Fixes the active workspace when using a static token (a static token has no `set_workspace`/`list_workspaces` capability). |
| `MCP_AUTH_MODE` | no (default `static`) | `static` (single service seal + `MCP_INBOUND_TOKEN` gate, described above) or `oauth` (per-user login via Diaflow magic code — see [OAuth mode (per-user auth)](#oauth-mode-per-user-auth) below). `oauth` mode requires `MCP_PUBLIC_URL` and ignores `DIAFLOW_TOKEN`/`MCP_INBOUND_TOKEN`. |

## OAuth mode (per-user auth)

Setting `MCP_AUTH_MODE=oauth` switches `/mcp` from the single shared-secret model above to a real per-user OAuth flow, backed by a self-hosted authorization server built on the MCP SDK's `mcpAuthRouter`/`requireBearerAuth`:

- **Dynamic Client Registration (DCR) + PKCE.** Any MCP client (including Diaflow's own "Connect" flow) can `POST /register` to obtain a `client_id` with no manual setup, then run a standard authorization-code-with-PKCE flow against `/authorize` and `/token`. This is what lets Diaflow's admin UI paste in `https://<host>/mcp` and have discovery succeed automatically, instead of timing out looking for OAuth metadata.
- **Magic-code login at `/login`.** Instead of Diaflow account passwords, `/authorize` redirects the browser to a small hosted login UI (`GET/POST /login`) that walks the user through Diaflow's existing magic-code flow (enter work email → enter the emailed code) before minting the authorization code.
- **Per-user tokens.** Each issued access token is bound to the sealed Diaflow session obtained from that user's own login — every MCP session authenticated with that token acts as that user, in their own workspace, not a shared service identity.
- **In-memory token/client/login state (v1).** Tokens, registered clients, and in-flight logins all live in process memory (no database). This means all connected users must re-login after a server restart or redeploy — acceptable for the current single-instance deployment, but a limitation to be aware of before scaling to multiple instances or expecting long-lived sessions across deploys.
- **Known limitation:** if an MCP session outlives the access token that created it, the seal-rotation writeback still targets that original token — inherent to the in-memory v1 design.

To enable it, set `MCP_AUTH_MODE=oauth` and `MCP_PUBLIC_URL` (see `.env.production.example`); `DIAFLOW_TOKEN`/`MCP_INBOUND_TOKEN` are not used in this mode.

## Run

**stdio** (e.g. for Claude Desktop or any local MCP client):

```bash
npm run dev
```

This runs `tsx src/index.ts` directly against `.env`. For a compiled run: `npm run build && node dist/src/index.js`.

**HTTP** (Streamable HTTP transport, mounted at `POST/GET /mcp`):

```bash
MCP_TRANSPORT=http npm run dev
```

Each new session (no `Mcp-Session-Id` header, or an `initialize` call) gets its own isolated `McpServer` + Diaflow auth session, so multiple clients/users don't share connection state.

## Authentication flow (interactive / `WorkOSSessionProvider`)

When `DIAFLOW_TOKEN` is **not** set, the server manages an interactive magic-code login and exposes it as three tools:

1. **`connect_diaflow { email }`** — starts the login; Diaflow emails a one-time code to `email`.
2. **`submit_code { email, code }`** — completes the login; the server stores the returned sealed session and active workspace in memory (per stdio process, or per HTTP session).
3. **`auth_status`** — reports whether the server is connected and which workspace is active.

Once connected, `set_workspace { workspaceId }` and `list_workspaces` let the caller switch/inspect workspaces. All other tools use whichever workspace is currently active. The Diaflow API may rotate the session seal on any response (`X-Diaflow-Session` header); the server transparently re-persists the rotated seal so the session stays valid.

When `DIAFLOW_TOKEN` **is** set, the server uses `StaticTokenProvider` instead: auth/workspace tools (`connect_diaflow`, `submit_code`, `auth_status`, `set_workspace`, `list_workspaces`) are not registered at all, and every request is authenticated with the fixed token against the fixed `DIAFLOW_WORKSPACE_ID`. This is the mode intended for a Diaflow teammate calling this server as a custom MCP (see below) — there's no human available to complete a magic-code login.

## Tool inventory

All tools are registered by `src/tools/register.ts`. Names below match `server.registerTool(...)` calls exactly.

**Auth** (only registered when using the interactive `WorkOSSessionProvider`, i.e. `DIAFLOW_TOKEN` unset) — `src/tools/auth.ts`
- `connect_diaflow` — begin login; emails a magic code.
- `submit_code` — finish login with the emailed code.
- `auth_status` — report connection + active workspace.

**Read** — `src/tools/read.ts`
- `list_teammates` — list teammates in the active workspace (pagination, lifecycle filter, search, ordering).
- `get_teammate` — full detail for one teammate by `uniqueId`.

**Write** — `src/tools/write.ts`
- `create_teammate` — create a teammate (`modelProvider`/`modelName` required).
- `update_teammate` — update a teammate's fields (name, model, description, instruction, tags, icon, ...).
- `check_teammate_name` — check whether a name is already taken in the workspace.

**Avatar** — `src/tools/avatar.ts`
- `set_teammate_avatar` — set a teammate's avatar from a remote image URL (downloaded and re-uploaded via S3 presign) or a recognized Diaflow preset-CDN URL (used as-is).
- `list_preset_avatars` — list Diaflow's curated preset avatars.

**Skills** — `src/tools/skills.ts`
- `list_teammate_skills` — skills currently attached to a teammate.
- `list_available_skills` — skills that can be attached to a teammate.
- `attach_skill` — attach a skill; provide exactly one of `skillWorkspaceId` / `skillSystemId` / `skillUserId`.
- `detach_skill` — detach a skill; same one-of-three-ids contract.

**Lifecycle** — `src/tools/lifecycle.ts`
- `publish_teammate` — publish a draft teammate.
- `offboard_teammate` — offboard (reversible soft-delete).
- `rehire_teammate` — restore an offboarded teammate.
- `delete_teammate` — permanently delete; a teammate must be offboarded first, or pass `force: true` to offboard-then-delete in one call.

**Workspace** (only registered with `WorkOSSessionProvider`) — `src/tools/workspace.ts`
- `set_workspace` — switch the active workspace for subsequent calls.
- `list_workspaces` — list workspaces available to the connected user (degrades to a text note if the backend doesn't support listing).

**Conversation** — `src/tools/conversation.ts`
- `message_teammate` — post a message to a teammate and get its synchronous reply; omit `teammateId` to continue an existing thread. Useful for agent-to-agent orchestration. Optional `attachmentUrls` are uploaded (S3 presign) before sending.
- `list_conversations` — list conversation sessions, optionally filtered by teammate.
- `get_conversation` — get a conversation session's message history.
- `stop_conversation` — cancel an in-progress conversation run.

**Sub-agents** — `src/tools/sub-agents.ts`
- `list_sub_agents` — sub-agents attached to an orchestrator teammate.
- `add_sub_agent` — attach an existing teammate as a sub-agent.
- `create_sub_agent` — create a new teammate and attach it as a sub-agent in one step.
- `remove_sub_agent` — detach a sub-agent.

**Integration** — `src/tools/integration.ts`
- `register_self_as_custom_mcp` — register this MCP server itself as a Diaflow custom-MCP resource in the active workspace (requires `MCP_PUBLIC_URL` and, for authenticated deploys, `MCP_INBOUND_TOKEN`).
- `attach_self_to_teammate` — attach a registered custom-MCP resource to a teammate so that teammate can call this server's tools at runtime.

## Manual verification

There is no automated live-API E2E test (it would require a real Diaflow account, an emailed magic-auth code, and a live MCP client) — the auth loop and every tool are covered by unit tests against a mocked `fetch`/`DiaflowClient` (`npm test`). To manually verify against the real API:

1. Set `DIAFLOW_API_BASE` in `.env` and start the server (`npm run dev`, stdio) against an MCP client (e.g. point Claude Desktop's config at `tsx src/index.ts` in this directory with your `.env` loaded).
2. Call `connect_diaflow { email }` with your Diaflow account email.
3. Check your email for the code, then call `submit_code { email, code }`.
4. Call `auth_status` — expect a connected response with an active workspace.
5. Call `list_teammates` — expect `{ total, results }`.
6. Optionally exercise the write path on a throwaway teammate: `create_teammate`, `set_teammate_avatar` with a public image URL, `get_teammate` to confirm `icon` is set, then `offboard_teammate` followed by `delete_teammate { force: true }` to clean up.

To sanity-check the HTTP transport without a full MCP client, start it and send a raw `initialize` request:

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=8791 DIAFLOW_API_BASE=https://api.diaflow.io npm run dev
# in another shell:
curl -i -X POST http://localhost:8791/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"0.0.1"}}}'
```

A healthy server responds `200 OK` with an `Mcp-Session-Id` header and a `result.serverInfo` body. If `MCP_INBOUND_TOKEN` is set, add `-H "Authorization: Bearer <token>"` or you'll get a `401`.

## Use as a Diaflow custom MCP

This server can be registered directly as a **Diaflow custom MCP** resource, so a Diaflow teammate can call these tools itself (e.g. an orchestrator teammate managing its own sub-agents, or messaging other teammates).

Requirements:

- **Streamable HTTP + public HTTPS.** Diaflow calls your server over the network, so it must run with `MCP_TRANSPORT=http`, be reachable at a public `https://` URL (Diaflow rejects `http://`, `localhost`, and private addresses), and that URL must be set as `MCP_PUBLIC_URL` (ending in `/mcp`).
- **`MCP_INBOUND_TOKEN` as the inbound bearer.** Set this to a secret value before deploying publicly. It's the token the HTTP transport requires on every inbound `/mcp` request (`Authorization: Bearer <token>`), and it's also the `key` passed when registering the custom-MCP resource, so Diaflow authenticates itself the same way. Without it, anyone who finds the URL can call your tools.
- **A non-interactive outbound credential (`DIAFLOW_TOKEN`).** When a Diaflow teammate calls this server at runtime, there's no human present to complete `connect_diaflow`/`submit_code`. Set `DIAFLOW_TOKEN` to a sealed Diaflow session (and `DIAFLOW_WORKSPACE_ID` to pin the workspace) so the server authenticates outbound calls to the Diaflow API on its own, via `StaticTokenProvider`. In this mode the auth/workspace tools aren't registered at all — only the read/write/lifecycle/etc. tools a teammate actually needs.

Registration flow, once deployed with the above configured:

1. Call `register_self_as_custom_mcp { name? }` (from any MCP client authenticated against this server, e.g. yourself during setup). This calls Diaflow's `/workspaces/{id}/resources/mcp/upsert` with `url: MCP_PUBLIC_URL`, `config.transport: "streamable_http"`, and `key: MCP_INBOUND_TOKEN`, returning a `resourceId`.
2. Call `attach_self_to_teammate { teammateId, resourceId, actions? }` for each teammate that should be able to call this server. `actions` restricts which tool names that teammate may invoke; omit it to allow all.

## Development

```bash
npm test              # run the unit test suite (vitest)
npm test -- --coverage  # run with coverage report
npm run build          # type-check + compile to dist/
npm run dev             # run src/index.ts directly with tsx (stdio by default)
```

Tests mock `fetch`/`DiaflowClient` throughout — there is no dependency on a live Diaflow backend for `npm test`.
