# Checkin Control Dev Routes (Railway + OpenClaw)

This guide documents the environment variables required in `openclaw-railway-template` so Checkin Control is available through one Railway public URL:

- Web: `https://<openclaw-domain>/dev/web/`
- API: `https://<openclaw-domain>/dev/api/`

Internal target ports:

- frontend: `48888`
- backend: `55555`

## Required variables

```env
ENABLE_DEV_ROUTE_PROXY=true
DEV_WEB_BASE_PATH=/dev/web
DEV_API_BASE_PATH=/dev/api
DEV_WEB_STRIP_PREFIX=true
DEV_API_STRIP_PREFIX=true
INTERNAL_FRONTEND_PORT=48888
INTERNAL_BACKEND_PORT=55555

DEV_WEB_START_CWD=/data/workspace/checkin-control
DEV_API_START_CWD=/data/workspace/checkin-control
DEV_WEB_START_CMD=npm run dev -w @checkin-control/web -- --host 127.0.0.1 --port 48888
DEV_API_START_CMD=npm run dev -w @checkin-control/api
DEV_PROCESS_SHELL=/bin/bash
DEV_PROCESS_AUTORESTART=true
```

## One-shot Railway CLI command

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

## Quick verification

```bash
railway variable list -s openclaw-railway-template -k | rg "DEV_WEB_START|DEV_API_START|INTERNAL_FRONTEND_PORT|INTERNAL_BACKEND_PORT"
```

After redeploy:

- open `https://<domain>/dev/web/`
- open `https://<domain>/dev/api/health`

## If you get `Dev route target unavailable`

- Check whether web/api processes booted in logs.
- Confirm `/data/workspace/checkin-control` exists in the container.
- Confirm dependencies are installed in that workspace.
