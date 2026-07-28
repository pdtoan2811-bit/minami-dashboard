#!/usr/bin/env bash
# Build + (re)serve Minami Bento in PRODUCTION mode on :3000.
#
# Why: `next dev` hot-reloads code into the *running* page (Fast Refresh). When you use the dashboard
# to edit the dashboard's own code, that hot-patch changes React's hook signatures mid-session and
# CRASHES the very tab you're working in. Production mode has no Fast Refresh — the running app is
# never touched by edits, so it can't crash from a rebuild.
#
# Workflow: drive changes from the live app → Claude edits the files → run `bash bin/serve.sh` to
# apply them. The old server keeps serving until the new build is ready, then swaps in.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
LOG="/tmp/minami-prod.log"

echo "▶ building (production, no Fast Refresh)…"
npm run build

echo "▶ swapping in the new build on :$PORT…"
# Kill ONLY the server listening on $PORT — leaves any other Next instance alone (e.g. the live-reload
# dev server on :3001), which also runs as `next-server` and must not be swept up.
lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
sleep 1
PORT="$PORT" nohup npm start >"$LOG" 2>&1 &

for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/" 2>/dev/null || true)
  [ "$code" = "200" ] && { echo "✓ live at http://localhost:$PORT  (logs: $LOG)"; exit 0; }
  sleep 1
done
echo "⚠ server didn't come up — check $LOG"; exit 1
