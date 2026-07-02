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

Brainstorming/spec phase. The MCP's own build/lint/test/run commands, tool inventory, and directory layout should be added to this file once the server is scaffolded. Until then, there are no commands to run at this workspace root — use each reference repo's own commands (in its `CLAUDE.md`) when exploring inside it.
