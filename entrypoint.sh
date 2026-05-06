#!/bin/bash
set -e

: "${OPENCLAW_STATE_DIR:=/data/.openclaw}"
: "${OPENCLAW_WORKSPACE_DIR:=/data/workspace}"
export OPENCLAW_STATE_DIR
export OPENCLAW_WORKSPACE_DIR

mkdir -p /data "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR"

chown -R openclaw:openclaw /data
chmod 700 /data

if [ ! -d /data/.linuxbrew ]; then
  cp -a /home/linuxbrew/.linuxbrew /data/.linuxbrew
fi

rm -rf /home/linuxbrew/.linuxbrew
ln -sfn /data/.linuxbrew /home/linuxbrew/.linuxbrew

exec gosu openclaw node src/server.js
