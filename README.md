# OpenClaw Railway Template

Deploy OpenClaw on Railway with a browser-first setup flow. No SSH required for onboarding.

IF YOU ARE UPGRADING FROM A PREVIOW VERSION REMOVE THE ENV VAR 'OPENCLAW_ENTRY' AS NOW OPENCLAW IS INSTALLED VIA NPM

## Read This First

This template exposes your OpenClaw gateway to the public internet.

- Review OpenClaw security guidance: <https://docs.openclaw.ai/gateway/security>
- Use a strong `SETUP_PASSWORD`
- If you only use chat channels, consider disabling public networking after setup

## What You Get

- OpenClaw Gateway + Control UI at `/` and `/openclaw`
- Setup Wizard at `/setup` (Basic auth protected)
- Microsoft Foundry (Azure OpenAI) setup in the wizard (API key + endpoint)
- Optional browser TUI at `/tui`
- Optional single-port dev reroutes:
  - `/dev/web` -> `127.0.0.1:48888`
  - `/dev/api` -> `127.0.0.1:55555`
- Persistent state on Railway volume (`/data`)
- Health endpoint at `/healthz`
- Diagnostics and logs via setup tools + `/logs`

## Checkin Control Integration

- Ops guide: `README.CHECKIN-CONTROL-ROUTES.md`
- Agent skill: `.agents/skills/configure-checkin-control-dev-routes/SKILL.md`

## Quick Start (Railway)

1. Deploy this template to Railway.
2. Ensure a volume is mounted at `/data`.
3. Set variables:
   - `SETUP_PASSWORD` (required)
   - `OPENCLAW_STATE_DIR=/data/.openclaw` (defaulted by template)
   - `OPENCLAW_WORKSPACE_DIR=/data/workspace` (defaulted by template)
   - Optional: `ENABLE_WEB_TUI=true`
4. Open `https://<your-domain>/setup` and complete onboarding.
5. Open `https://<your-domain>/openclaw` from the setup page.

## Environment Variables

### Required

- `SETUP_PASSWORD`: password for `/setup`

### Recommended

- `OPENCLAW_STATE_DIR=/data/.openclaw` (already set in `railway.toml`)
- `OPENCLAW_WORKSPACE_DIR=/data/workspace` (already set in `railway.toml`)
- `OPENCLAW_GATEWAY_TOKEN` (stable token across redeploys)

### Optional

- `PORT=8080`
- `INTERNAL_GATEWAY_PORT=18789`
- `INTERNAL_GATEWAY_HOST=127.0.0.1`
- `ENABLE_DEV_ROUTE_PROXY=true`
- `DEV_WEB_BASE_PATH=/dev/web`
- `DEV_API_BASE_PATH=/dev/api`
- `INTERNAL_FRONTEND_PORT=48888`
- `INTERNAL_BACKEND_PORT=55555`
- `DEV_WEB_STRIP_PREFIX=true`
- `DEV_API_STRIP_PREFIX=true`
- `DEV_WEB_START_CMD` (optional: auto-start frontend process)
- `DEV_API_START_CMD` (optional: auto-start backend process)
- `DEV_WEB_START_CWD` (optional: working dir for frontend command)
- `DEV_API_START_CWD` (optional: working dir for backend command)
- `DEV_PROCESS_SHELL=/bin/bash`
- `DEV_PROCESS_AUTORESTART=true`
- `ENABLE_WEB_TUI=false`
- `TUI_IDLE_TIMEOUT_MS=300000`
- `TUI_MAX_SESSION_MS=1800000`

### Managed Defaults (Recommended on Railway)

These are automatically re-applied on startup (and after `/setup`) so redeploys keep your intended posture:

- `OPENCLAW_BOOTSTRAP_AUTOCONFIG=true`
- `OPENCLAW_BOOTSTRAP_SANDBOX_MODE=off` (Railway containers do not provide Docker)
- `OPENCLAW_BOOTSTRAP_EXEC_POLICY_PRESET=yolo`
- `OPENCLAW_BOOTSTRAP_EXEC_HOST=gateway`
- `OPENCLAW_BOOTSTRAP_EXECUTION_CONTRACT=strict-agentic` (execute-first behavior on GPT-5 family)
- `OPENCLAW_BOOTSTRAP_VERBOSE_DEFAULT=off`
- `OPENCLAW_BOOTSTRAP_TOOL_PROGRESS_DETAIL=raw`
- `OPENCLAW_BOOTSTRAP_MCP_SCRAPER_ENABLED=true`
- `OPENCLAW_BOOTSTRAP_MCP_SCRAPER_NAME=scraper`
- `OPENCLAW_BOOTSTRAP_MCP_SCRAPER_COMMAND=npx`
- `OPENCLAW_BOOTSTRAP_MCP_SCRAPER_ARGS=["-y","mcp-server-scraper"]`
- `OPENCLAW_BOOTSTRAP_TELEGRAM_DM_POLICY=pairing`
- `OPENCLAW_BOOTSTRAP_TELEGRAM_GROUP_POLICY=allowlist`
- `OPENCLAW_BOOTSTRAP_TELEGRAM_ALLOW_FROM=[]`
- Optional owner allowlist:
  - `OPENCLAW_BOOTSTRAP_OWNER_ALLOW_FROM=["telegram:123456789"]`

## Day-1 Setup Checklist

- Confirm `/setup` loads and accepts password
- Run onboarding once
- Verify `/healthz` returns `{ "ok": true, ... }`
- Open `/openclaw` via setup link
- If using Telegram/Discord, approve pending devices from setup tools

## Chat Token Prep

### Microsoft Foundry (Azure OpenAI)

In `/setup`, choose:
- Provider Group: `Microsoft Foundry`
- Auth Method: `Microsoft Foundry (API key)`

Then provide:
- Azure OpenAI API key
- Endpoint URL (`https://<resource>.openai.azure.com` or `https://<project>.services.ai.azure.com`)
- Optional model value as deployment name or `microsoft-foundry/<deployment>`
- API mode (`openai-responses` recommended for GPT/o-series/Codex deployments)

### Telegram

1. Message `@BotFather`
2. Run `/newbot`
3. Copy bot token (looks like `123456789:AA...`)
4. Paste into setup wizard

### Discord

1. Create app in Discord Developer Portal
2. Add bot + copy bot token
3. Invite bot to server (`bot`, `applications.commands` scopes)
4. Enable required intents for your use case

## Web TUI (`/tui`)

Disabled by default. Set `ENABLE_WEB_TUI=true` to enable.

Built-in safeguards:

- Protected by `SETUP_PASSWORD`
- Single active session
- Idle timeout
- Max session duration

## Local Smoke Test

```bash
docker build -t openclaw-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -e ENABLE_WEB_TUI=true \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template
```

- Setup: `http://localhost:8080/setup` (password: `test`)
- UI: `http://localhost:8080/openclaw`
- TUI: `http://localhost:8080/tui`
- Dev web proxy: `http://localhost:8080/dev/web`
- Dev api proxy: `http://localhost:8080/dev/api`

## Single-Port Rerouting (Railway-Friendly)

Railway publicly exposes one `PORT` per service. This wrapper can proxy extra internal services through subpaths:

- `${DEV_WEB_BASE_PATH}` -> `${DEV_WEB_TARGET}` (or `127.0.0.1:${INTERNAL_FRONTEND_PORT}`)
- `${DEV_API_BASE_PATH}` -> `${DEV_API_TARGET}` (or `127.0.0.1:${INTERNAL_BACKEND_PORT}`)

Default layout in this template:

- `/dev/web` -> `http://127.0.0.1:48888`
- `/dev/api` -> `http://127.0.0.1:55555`

Notes:

- WebSocket upgrades are supported for both subpaths (useful for Vite HMR).
- If your frontend is configured with `base: "/dev/web/"`, set `DEV_WEB_STRIP_PREFIX=false`.
- If your backend expects `/dev/api/*` paths directly, set `DEV_API_STRIP_PREFIX=false`.
- By default, this wrapper only proxies. It does not invent frontend/backend processes.
- To auto-start processes on boot/redeploy, define:
  - `DEV_WEB_START_CMD` and `DEV_WEB_START_CWD`
  - `DEV_API_START_CMD` and `DEV_API_START_CWD`
- If enabled, the wrapper restarts those child processes automatically when they crash (`DEV_PROCESS_AUTORESTART=true`).

## Troubleshooting

### Control UI says disconnected / auth error

- Open `/setup` first, then click the OpenClaw UI link from there.
- Approve pending devices in setup if pairing is required.

### 502 / gateway unavailable

- Check `/healthz`
- Run doctor from setup (`openclaw doctor --repair`)
- Verify `/data` volume is mounted and writable

### Setup keeps resetting after redeploy

- `OPENCLAW_STATE_DIR` or `OPENCLAW_WORKSPACE_DIR` is not on `/data`
- Fix both vars and redeploy
- Confirm the Railway volume is mounted at `/data` on this service

### `Dev route target unavailable`

- This means the wrapper tried to proxy to `${DEV_WEB_TARGET}` or `${DEV_API_TARGET}`, but nothing was listening there.
- Confirm the target process is running inside the same container.
- Recommended: set `DEV_WEB_START_CMD` / `DEV_API_START_CMD` so the wrapper starts both services at boot.

### MCP scraper configured but not used in chat

- Verify config:
  - `openclaw mcp list --json`
- Confirm server tool catalog directly (inside container):
  - `python3 - <<'PY'`
  - `import subprocess, json`
  - `p=subprocess.Popen(["npx","-y","mcp-server-scraper"],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)`
  - `p.stdin.write(json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}})+"\\n"); p.stdin.flush(); print(p.stdout.readline().strip())`
  - `p.stdin.write(json.dumps({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})+"\\n"); p.stdin.flush(); print(p.stdout.readline().strip())`
  - `p.terminate()`
  - `PY`
- Start a fresh chat session (`/new`) so the agent rebuilds runtime context.

### Telegram config/schema breaks after upgrades

- The wrapper now configures Telegram via `openclaw channels add` during setup, then applies managed defaults.
- Avoid manual root-owned edits under `/data/.openclaw`; they can break config watch permissions.

### TUI not visible

- Set `ENABLE_WEB_TUI=true`
- Redeploy and reload `/setup`

## Useful Endpoints

- `/setup` - onboarding + management
- `/openclaw` - Control UI
- `/healthz` - public health
- `/logs` - live server logs UI

## Support

Need help? Open an issue or use Railway Station support for this template.
