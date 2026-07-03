# Deploying diaflow-teammate-mcp (Docker, remote server)

This deploys the MCP server as a container serving **Streamable HTTP** at `/mcp`, running as one Diaflow service identity (`DIAFLOW_TOKEN`), so Diaflow teammates can call it. Diaflow requires the server to be reachable at a **public HTTPS** URL — plain `http`, `localhost`, and private IPs are rejected.

## Prerequisites

- A host that can run a container and expose it over **HTTPS** (any container host, or a VPS with a TLS-terminating reverse proxy).
- A Diaflow **service account** in the target workspace, and its **sealed session** (see step 3).
- A long random **inbound token** (e.g. `openssl rand -hex 32`).

## 1. Build the image

```bash
docker build -t diaflow-teammate-mcp .
```

## 2. Configure env

```bash
cp .env.production.example .env
# edit .env
```

Required values:

| Var | Value |
|---|---|
| `MCP_TRANSPORT` | `http` (image default) |
| `MCP_PUBLIC_URL` | the public `https://…/mcp` URL clients/Diaflow will hit |
| `MCP_INBOUND_TOKEN` | long random secret; callers must send `Authorization: Bearer <it>` |
| `DIAFLOW_API_BASE` | the backend serving your env's agents API **and** magic-auth, e.g. `https://api-dev.diaflow.io` (prod `api.diaflow.io` does not expose the magic-auth login routes) |
| `DIAFLOW_TOKEN` | the service account's sealed session (step 3) |
| `DIAFLOW_WORKSPACE_ID` | the workspace the service acts in |

> **`MCP_INBOUND_TOKEN` is mandatory for a real deploy.** Without it the `/mcp` endpoint is open to the internet and `register_self_as_custom_mcp` refuses to run; the server also logs a startup WARNING.

## 3. Obtain the service `DIAFLOW_TOKEN` (sealed session)

Log the service account in via magic-auth and copy the `session` field (a `gAAAA…` Fernet string). With `X-Client: native` and **no** `Origin` header:

```bash
BASE=https://api-dev.diaflow.io   # magic-auth lives on the dev backend, not prod api.diaflow.io
EMAIL=service-account@yourco.com
curl -sS -X POST "$BASE/api/v1/auth/magic-auth/send" \
  -H "Content-Type: application/json" -H "X-Client: native" -d "{\"email\":\"$EMAIL\"}"
# check the inbox, then:
CODE=123456
curl -sS -X POST "$BASE/api/v1/auth/magic-auth/verify" \
  -H "Content-Type: application/json" -H "X-Client: native" \
  -d "{\"email\":\"$EMAIL\",\"code\":\"$CODE\"}" | jq -r '.session'
```

Put that value in `DIAFLOW_TOKEN` and the returned `workspaceId` in `DIAFLOW_WORKSPACE_ID`.

> **Sealed sessions expire.** While the process runs and keeps making requests, it auto-rotates (the server captures `X-Diaflow-Session` on each response and updates its in-memory seal). But on **restart** it reloads the original `DIAFLOW_TOKEN`, which may by then be expired. Operational options: (a) re-seed `DIAFLOW_TOKEN` on each deploy/restart; (b) keep the process warm (avoid scale-to-zero) so rotation persists; (c) automate re-sealing (future enhancement — not built yet). Plan a periodic re-seed until (c) exists.

## 4. Run

**Docker Compose (VPS / any host):**
```bash
docker compose up -d --build
docker compose logs -f
```
This listens on `:8787`. Put a TLS-terminating reverse proxy in front (e.g. Caddy: `reverse_proxy localhost:8787`, which also gives auto-HTTPS), so `MCP_PUBLIC_URL` resolves to `https://your-host/mcp`.

**Plain docker run:**
```bash
docker run -d --name diaflow-teammate-mcp --env-file .env -p 8787:8787 diaflow-teammate-mcp
```

**Managed container hosts (Render/Railway/Fly/Cloud Run):** point them at this repo/image, set the env vars in their dashboard, and use the platform's HTTPS URL as `MCP_PUBLIC_URL` (append `/mcp`). The app reads the platform's injected `$PORT` automatically.

## 5. Smoke-test the endpoint

```bash
# Unauthenticated → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://your-host/mcp
# With the inbound token, an initialize request → 200 + Mcp-Session-Id header
curl -sS -X POST https://your-host/mcp \
  -H "Authorization: Bearer $MCP_INBOUND_TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' -i | head -20
```

## 6. Register with Diaflow + attach to a teammate

Once live, register this server as a custom MCP and attach it to a teammate. Either call the built-in tools from an MCP client connected to this server (`register_self_as_custom_mcp` → `attach_self_to_teammate`), or do it directly against Diaflow:

```bash
# Register (returns { resourceId }). key = your MCP_INBOUND_TOKEN so Diaflow authenticates to us.
curl -sS -X POST "$DIAFLOW_API_BASE/api/v1/workspaces/$DIAFLOW_WORKSPACE_ID/resources/mcp/upsert" \
  -H "Authorization: Bearer $DIAFLOW_TOKEN" -H "Content-Type: application/json" -H "X-Client: native" \
  -d "{\"url\":\"$MCP_PUBLIC_URL\",\"name\":\"Diaflow Teammate MCP\",\"resourceType\":\"mcp_custom\",\"key\":\"$MCP_INBOUND_TOKEN\",\"config\":{\"transport\":\"streamable_http\",\"authType\":\"bearer\"}}"

# Attach to a teammate (RESOURCE_ID from above, TEAMMATE_UID = the agent's uniqueId)
curl -sS -X POST "$DIAFLOW_API_BASE/api/v1/agents/TEAMMATE_UID/apps" \
  -H "Authorization: Bearer $DIAFLOW_TOKEN" -H "Content-Type: application/json" -H "X-Client: native" \
  -d "{\"nodeType\":\"mcp_custom__RESOURCE_ID\",\"resourceId\":RESOURCE_ID}"
```

## Operational notes / limitations

- **Single instance.** Per-MCP-session state (and the service session) live in memory. Run **one** instance, or use sticky sessions — horizontally scaling behind a plain load balancer will split sessions. (A shared/Redis session store is a future enhancement.)
- **Idle sessions** are reaped on transport close and by an idle-TTL sweep; explicit `DELETE /mcp` also terminates a session.
- **Known hardening follow-ups** (see `CLAUDE.md` → "Known hardening follow-ups"): residual DNS-rebinding TOCTOU on the SSRF guard; no CORS handling (fine for server-to-server); `DIAFLOW_TOKEN` refresh automation. None block a controlled deployment; address before exposing to hostile traffic at scale.
- **Verify the live API shapes** against your Diaflow instance on first deploy — the `/agent-runtime` and `/resources/mcp/upsert` request/response shapes were derived from source analysis, not a live call.
