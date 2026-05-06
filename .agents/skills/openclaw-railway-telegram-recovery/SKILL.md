---
name: openclaw-railway-telegram-recovery
description: "Diagnose and recover OpenClaw Telegram channel outages on Railway, including channel schema issues, gateway reload failures, file-permission drift, and model-provider failures."
---

# OpenClaw Telegram Recovery (Railway)

Use this skill when the Telegram bot does not respond to `/start` or messages in a Railway-hosted OpenClaw deployment.

## Goals

1. Confirm whether Telegram updates are arriving.
2. Confirm whether OpenClaw is consuming those updates.
3. Restore channel runtime safely.
4. Identify whether failures are from channel runtime or model/provider execution.

## Prerequisites

1. `railway` CLI installed and authenticated.
2. Service linked to the correct project/environment/service.
3. OpenClaw state persisted under `/data`:
   - `OPENCLAW_STATE_DIR=/data/.openclaw`
   - `OPENCLAW_WORKSPACE_DIR=/data/workspace`

## Fast Triage

1. Confirm Railway service status.
```bash
railway status
```

2. Pull recent deploy logs and search for Telegram/gateway/model failures.
```bash
railway logs --latest --lines 600 > /tmp/openclaw_logs.txt
grep -nE "telegram|channels\\.telegram|invalid config|watcher error|embedded run|FailoverError|microsoft-foundry|Unknown error" /tmp/openclaw_logs.txt
```

3. Check OpenClaw runtime channel health from inside the service.
```bash
railway ssh -- 'export OPENCLAW_STATE_DIR=/data/.openclaw OPENCLAW_WORKSPACE_DIR=/data/workspace; openclaw status --deep --json'
```

Expected healthy signal:
- `health.channels.telegram.running=true`
- `health.channels.telegram.connected=true`
- `health.channels.telegram.mode="polling"`

## Telegram Transport Validation

1. Inspect Telegram queue state directly from Bot API:
```bash
railway ssh -- 'curl -s "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo"'
```

Interpretation:
- `pending_update_count > 0` and never decreases: OpenClaw is not consuming updates.
- `pending_update_count = 0`: updates are being consumed.

2. Check whether channel plugin starts after boot:
```bash
railway logs --latest --lines 300 | grep -n "\[telegram\]"
```

Expected startup line:
- `[telegram] [default] starting provider (@<bot_username>)`

## Known Failure Patterns and Fixes

### A) Invalid Telegram config schema
Symptom in logs:
- `channels.telegram: invalid config: must NOT have additional properties`

Fix:
1. Reconfigure Telegram using the current CLI command family:
```bash
railway ssh -- 'export OPENCLAW_STATE_DIR=/data/.openclaw OPENCLAW_WORKSPACE_DIR=/data/workspace; openclaw channels add --channel telegram --account default --token "$TELEGRAM_TOKEN"'
```
2. Restart service:
```bash
railway service restart --yes
```
3. Verify startup and channel health again.

Note:
- Do not use `openclaw channel ...`; current CLI uses `openclaw channels ...`.

### B) Config file permission drift (`EACCES` watcher error)
Symptom in logs:
- `config watcher error: Error: EACCES: permission denied, watch '/data/.openclaw/openclaw.json'`

Cause:
- `openclaw.json` ownership changed (often from root-owned writes during manual SSH actions).

Fix:
```bash
railway ssh -- 'chown openclaw:openclaw /data/.openclaw/openclaw.json && chmod 600 /data/.openclaw/openclaw.json'
railway service restart --yes
```

Then verify:
```bash
railway ssh -- 'ls -l /data/.openclaw/openclaw.json'
```

Expected:
- owner/group `openclaw openclaw`
- mode `-rw-------`

### C) Channel is healthy but bot still "does not answer"
Symptom in logs:
- `embedded run ... provider=microsoft-foundry ... Unknown error (no error details in response)`
- `FailoverError: Unknown error (no error details in response)`

Interpretation:
- Telegram transport is alive; failure occurs in model/provider execution before reply.

Action:
1. Validate provider credentials, endpoint, deployment/model name, and API mode.
2. Temporarily switch to a known-good model/provider to isolate transport vs inference failures.
3. Re-test `/start` and plain text message after model change.

## Post-Fix Verification Checklist

1. `railway status` shows service online.
2. Logs include Telegram provider startup line.
3. `openclaw status --deep --json` shows Telegram connected/running.
4. `getWebhookInfo` shows `pending_update_count` draining to zero.
5. Bot replies to `/start` and a regular message.

## Safety Rules

1. Do not run destructive git or filesystem reset commands.
2. Prefer `railway service restart --yes` over ad-hoc process killing.
3. Keep all persisted OpenClaw state under `/data`.
4. If manual edits are done under `railway ssh`, always re-check ownership/permissions of `/data/.openclaw/openclaw.json`.
