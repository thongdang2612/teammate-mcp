# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This is the workspace for building **`diaflow-teammate-mcp`** — a custom MCP (Model Context Protocol) server that exposes Diaflow's **Teammate** module as LLM-callable tools (read teammates, update teammate info such as name / avatar / skills, and handle avatar/file uploads).

The MCP server does not exist yet — this repo currently contains only the two upstream Diaflow source repos, checked out here as **read-only reference** for understanding the API contract the MCP will wrap:

```
diaflow-teammate-mcp/
├── diaflow-backend/    # Reference: Python FastAPI backend — source of truth for the API contract
├── diaflow-expo/       # Reference: TS/Expo monorepo — shows how the real client calls those APIs
└── (the MCP server will be added at the root)
```

**Treat `diaflow-backend/` and `diaflow-expo/` as reference material, not as things to modify.** Read them to learn endpoints, payloads, responses, auth, and the upload flow; do not implement MCP features by editing them.

## The two reference repos

Each reference repo has its own `CLAUDE.md`, its own skills (surfaced scoped as `diaflow-backend:*` / `diaflow-expo:*`), and its own commands. **Do not duplicate their guidance here — read the repo's own `CLAUDE.md` when working inside it.** Note that those files' MANDATORY workflow/spec/security rules are written for contributors *to those repos*; when you are only reading them to build the MCP, they are reference, not obligations.

- **`diaflow-backend/`** — Python 3.10, FastAPI + async SQLAlchemy, Alembic (PostgreSQL), Redis, Celery. Routers live under `modules/api/`, Pydantic schemas under `modules/schema/`, CRUD under `modules/crud/`, models under `modules/models/`. Response envelope is `{ data, message, status }`; pagination via `limit`/`offset` with `total`. This is the **authoritative source** for endpoint paths, payloads, and responses.
- **`diaflow-expo/`** — Turborepo + Yarn 4 monorepo. The platform-agnostic API client and types live in `packages/fe-core` (RN-free). Feature logic is split `core/` (agnostic) vs `web/` + `native/` (screens). Data layer is TanStack React Query. Use this repo to see the **exact request sequence** a real client makes — especially multi-step flows.

## Core concepts the MCP must model

- **Teammate module** — Diaflow's "teammates" are the AI agents/assistants. The MCP wraps their lifecycle and info-editing endpoints (list, get, update name/avatar/skills/etc.). The backend may name this concept `agent` / `agent_builder` / `agentv2` rather than `teammate` — reconcile the frontend "teammate" naming with the backend routes when wiring tools.
- **S3 presigned upload (two-step, do not shortcut)** — Diaflow does **not** accept raw multipart file bodies for avatars/files. The flow is:
  1. Call the **presign** endpoint to get a presigned S3 target (URL + key/fields) for the intended file.
  2. Upload the bytes **directly to S3** using that presigned target.
  3. Persist the returned **key** back onto the resource (e.g. set it as the teammate's avatar) via the normal update endpoint.

  The MCP must implement all three steps as one cohesive operation so a caller can "set avatar from a file/URL" without knowing the S3 mechanics. Confirm the exact presign endpoint, request fields, and whether S3 upload is `PUT` (presigned URL) or `POST` (presigned POST policy) by reading both reference repos before implementing.

## Auth

The MCP is a client of the Diaflow backend and must authenticate the same way the real client does (bearer/JWT token + backend base URL, configured via environment variables — never hardcoded). Determine the exact header name, token source, and base-URL config from `diaflow-expo`'s API client and `diaflow-backend`'s auth dependencies before building.

## Status

Feature-complete and covered by tests. The MCP server lives at the repo root under `src/` (tests under `tests/`, mirroring the same layout). See `README.md` for full install/configure/run docs and the complete tool inventory — this section only covers what a contributor working inside this repo needs.

### Commands

```bash
npm test               # vitest run — unit tests, mocked fetch/DiaflowClient, no live backend needed
npm test -- --coverage # same, with a v8 coverage report (src/index.ts excluded — see below)
npm run build           # tsc type-check + compile to dist/
npm run dev              # tsx src/index.ts (stdio transport by default; MCP_TRANSPORT=http npm run dev for HTTP)
```

### Architecture / auth-flow summary

`src/index.ts` reads `.env` via `src/config.ts` (Zod-validated) and picks a transport: **stdio** connects one `McpServer` directly, **http** starts an Express app serving Streamable HTTP at `/mcp` and builds one isolated `McpServer` + `ToolContext` per `Mcp-Session-Id`. `src/tools/context.ts` (`buildContext`) wires a `TokenProvider` — either the interactive `WorkOSSessionProvider` (magic-code login via `src/auth/magic-auth.ts`, session cached via `SessionStore`) or, when `DIAFLOW_TOKEN` is set, a fixed `StaticTokenProvider` for non-interactive/service deployments — into a `DiaflowClient` (`src/diaflow/client.ts`, adds auth/workspace headers, parses Diaflow's `{code,message}` error envelope into `DiaflowHttpError`, and re-persists any rotated session seal from `X-Diaflow-Session`). `src/tools/register.ts` then registers all tool groups (auth, read, write, avatar, skills, lifecycle, workspace, conversation, sub-agents, integration) against that context — auth/workspace tools are skipped entirely under `StaticTokenProvider`, since there's no login/workspace-switch to do. Avatars and chat attachments both go through a two-step S3 presign-then-PUT upload (`src/diaflow/upload.ts`) before the resulting key is persisted onto the resource.

### Tool inventory

See the **Tool inventory** section of `README.md` for the full, grouped list (auth / read / write / avatar / skills / lifecycle / workspace / conversation / sub-agents / integration) — tool names there are verified against `src/tools/*.ts`.

### Known hardening follow-ups

Not blocking, but worth fixing before hardening this for a hostile/public deployment:

- **HTTP session map leak.** `src/index.ts`'s `startHttpServer` builds a brand-new `McpServer`/`ToolContext` for any POST to `/mcp` that lacks a known `Mcp-Session-Id` — including malformed or non-`initialize` requests — and only cleans up on `transport.onclose`. In open/no-token mode (`MCP_INBOUND_TOKEN` unset) this is an easy memory-exhaustion vector.
- **Non-constant-time inbound token check.** `src/auth/inbound-auth.ts`'s `isInboundAuthorized` compares the bearer token with `===`, not a timing-safe comparison — a theoretical timing side-channel on `MCP_INBOUND_TOKEN`.
- **No idle-session TTL sweep.** HTTP sessions in `src/index.ts`'s `sessions` map are only removed on transport close; a client that opens a session and goes silent (no clean disconnect) leaves it (and its `WorkOSSessionProvider`) resident indefinitely.
- **No SSRF guard on fetched URLs.** `uploadRemoteImage` and `uploadChatAttachment` (`src/diaflow/upload.ts`) `fetch()` whatever URL the caller supplies (avatar image URL / chat attachment URL) with no allowlist or private-IP/metadata-endpoint check before downloading and re-uploading it.
