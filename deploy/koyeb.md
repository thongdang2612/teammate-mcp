# Deploy to Koyeb (free tier, always-on)

Koyeb builds the repo's `Dockerfile` directly from GitHub and serves it over HTTPS on `*.koyeb.app`. The free instance stays running (no forced idle-sleep like Render), which suits this server's in-memory sessions + `DIAFLOW_TOKEN` rotation. (Free-tier terms change — confirm the current $0 instance type in Koyeb's plan list.)

Prereqs: the repo is pushed to `github.com/thongdang2612/teammate-mcp` (done); a Koyeb account; the service `DIAFLOW_TOKEN` sealed session (see `../DEPLOY.md` step 3); a random `MCP_INBOUND_TOKEN` (`openssl rand -hex 32`).

The server listens on the port from `$PORT`/`MCP_HTTP_PORT`; we use **8000** here (Koyeb's convention).

---

## Option A — Dashboard (no CLI)

1. **app.koyeb.com → Create Web Service → GitHub** → pick `thongdang2612/teammate-mcp`, branch `main`.
2. **Builder:** Dockerfile (auto-detected).
3. **Instance:** the **Free** instance. **Regions:** one (e.g. Washington `was` or Frankfurt `fra`).
4. **Exposing / Port:** port **8000**, protocol HTTP, route `/`. **Health check:** set type **TCP** on port 8000 (the app only serves `/mcp`, so a TCP check avoids needing a health route).
5. **Environment variables** (mark the two token vars as **Secret**):
   - `MCP_TRANSPORT=http`
   - `MCP_HTTP_PORT=8000`
   - `DIAFLOW_API_BASE=https://api-dev.diaflow.io`
   - `DIAFLOW_WORKSPACE_ID=<your workspace id>`
   - `MCP_INBOUND_TOKEN=<random secret>`  ← Secret
   - `DIAFLOW_TOKEN=<sealed session>`  ← Secret
6. **Deploy.** When it's live, copy the public URL (`https://<name>-<org>.koyeb.app`).
7. **Set `MCP_PUBLIC_URL`** to that URL **+ `/mcp`** and redeploy:
   `MCP_PUBLIC_URL=https://<name>-<org>.koyeb.app/mcp`
   (The server runs fine without it; it's only needed so `register_self_as_custom_mcp` knows our public URL. That's why we set it after the first deploy reveals the hostname.)

---

## Option B — Koyeb CLI

```bash
# install: brew install koyeb/tap/koyeb   (or see koyeb.com/docs/cli)
koyeb login

# Secrets (never inline secrets as plain env):
koyeb secret create mcp-inbound-token --value "$(openssl rand -hex 32)"
koyeb secret create diaflow-token     --value "<sealed session from magic-auth verify>"

# Create the service (builds the Dockerfile from GitHub):
koyeb service create teammate-mcp \
  --app teammate-mcp \
  --git github.com/thongdang2612/teammate-mcp \
  --git-branch main \
  --git-builder docker \
  --instance-type free \
  --regions was \
  --ports 8000:http \
  --routes /:8000 \
  --checks 8000:tcp \
  --env MCP_TRANSPORT=http \
  --env MCP_HTTP_PORT=8000 \
  --env DIAFLOW_API_BASE=https://api-dev.diaflow.io \
  --env DIAFLOW_WORKSPACE_ID=<your workspace id> \
  --env MCP_INBOUND_TOKEN=@mcp-inbound-token \
  --env DIAFLOW_TOKEN=@diaflow-token

# After it's healthy, read the public URL:
koyeb service get teammate-mcp/teammate-mcp -o json | grep -i public_domain

# Then set the public URL and redeploy:
koyeb service update teammate-mcp/teammate-mcp \
  --env MCP_PUBLIC_URL=https://<name>-<org>.koyeb.app/mcp
```

`@name` references a Koyeb secret. `--instance-type free` selects the free instance (name may differ — pick the $0 one). Auto-deploy on push to `main` is on by default for git services.

---

## Verify + wire into Diaflow

Then follow `../DEPLOY.md`:
- **Step 5** — smoke-test: unauthenticated `POST /mcp` → 401; with `Authorization: Bearer <MCP_INBOUND_TOKEN>` + an `initialize` body → 200 + `Mcp-Session-Id`.
- **Step 6** — register as a Diaflow custom MCP and attach to a teammate (`register_self_as_custom_mcp` + `attach_self_to_teammate`, or the curls).

## Free-tier caveats (same as DEPLOY.md, sharpened for Koyeb)

- **One instance** — keep it at a single instance; don't scale out (in-memory sessions).
- **`DIAFLOW_TOKEN` on redeploy** — each redeploy/restart reloads the original token env. While running it auto-rotates via `X-Diaflow-Session`, but after a redeploy you may need to re-seed `DIAFLOW_TOKEN` with a fresh sealed session. Plan a periodic re-seed until token-refresh automation is built.
- **256MB RAM** free instance is ample for this server.
