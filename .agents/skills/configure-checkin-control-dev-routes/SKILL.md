---
name: configure-checkin-control-dev-routes
description: Configure and verify Railway variables so openclaw-railway-template can start Checkin Control and expose it via /dev/web and /dev/api on ports 48888 and 55555. Use when users report Dev route target unavailable, blank /dev/web, or need the setup to persist across redeploys.
---

# Configure Checkin Control Dev Routes

Use this workflow to make `openclaw-railway-template` expose Checkin Control through one public Railway service.

## Expected setup

- Service: `openclaw-railway-template`
- Checkin workspace path in container: `/data/workspace/checkin-control`
- Internal ports:
  - web: `48888`
  - api: `55555`

## Step 1: Set variables

```bash
railway variable set -s openclaw-railway-template \
  ENABLE_DEV_ROUTE_PROXY=true \
  DEV_WEB_BASE_PATH=/dev/web \
  DEV_API_BASE_PATH=/dev/api \
  DEV_WEB_STRIP_PREFIX=true \
  DEV_API_STRIP_PREFIX=true \
  INTERNAL_FRONTEND_PORT=48888 \
  INTERNAL_BACKEND_PORT=55555 \
  DEV_WEB_START_CWD=/data/workspace/checkin-control \
  DEV_API_START_CWD=/data/workspace/checkin-control \
  "DEV_WEB_START_CMD=npm run dev -w @checkin-control/web -- --host 127.0.0.1 --port 48888" \
  "DEV_API_START_CMD=npm run dev -w @checkin-control/api" \
  DEV_PROCESS_SHELL=/bin/bash \
  DEV_PROCESS_AUTORESTART=true
```

## Step 2: Confirm persisted values

```bash
railway variable list -s openclaw-railway-template -k | rg "DEV_WEB_START|DEV_API_START|INTERNAL_FRONTEND_PORT|INTERNAL_BACKEND_PORT|DEV_WEB_BASE_PATH|DEV_API_BASE_PATH"
```

## Step 3: Validate runtime

```bash
railway logs --service openclaw-railway-template --lines 200 | rg "dev route proxy|dev-web|dev-api|ECONNREFUSED|Dev route target unavailable"
```

Check endpoints:

- `https://<domain>/dev/web/`
- `https://<domain>/dev/api/health`

## Troubleshooting

- If `/dev/web` fails:
  1. Verify `DEV_WEB_START_CWD` exists.
  2. Verify dependencies are installed in `/data/workspace/checkin-control`.
  3. Verify Vite is bound to `127.0.0.1:48888`.

- If `/dev/api` fails:
  1. Check API boot logs.
  2. Verify API listens on `55555`.

- If paths are wrong:
  - keep `DEV_*_STRIP_PREFIX=true` when upstream expects root paths.
  - use `false` only when upstream expects `/dev/web` or `/dev/api` in path.
