#!/usr/bin/env bash
# PUT MINAMI IN A MEETING, from a cold or half-configured machine, in one command.
#
#   bash bin/meet-now.sh https://meet.google.com/xxx-xxxx-xxx
#
# ⚠️ RUN THIS FROM Terminal.app, NOT from a Claude chat in the dashboard.
#
# The dashboard HOSTS those chats: a chat's process tree is `claude <- next-server <- npm start`, so
# restarting the app kills the very session that asked for the restart. bin/serve.sh knows this and
# refuses while any turn is in flight — including the turn running bin/serve.sh — which means the
# restart can never succeed from inside a chat, only from a terminal that the app does not own.
#
# What this does, in the order the failures actually happen:
#   1. rebuild + restart the app          picks up .env.local; the OLD build has no Blaze support
#   2. wait for ingest to answer 401      401 is CORRECT — it means the token loaded. 503 means it did
#                                         not, and audio would be refused all meeting
#   3. restart the receiver               it reads CANVAS_INGEST_TOKEN once, at boot. A receiver left
#                                         running from before the token was fixed posts unauthenticated
#                                         into a now-hardened endpoint and every chunk is dropped
#   4. ensure a tunnel + CAPTURE its host quick-tunnel hostnames rotate on restart and are printed only
#                                         to the stdout of whatever started them. Losing that hostname
#                                         has cost a meeting before, so it is written to a file
#   5. launch the bot, audio-only         you present the canvas yourself, at full resolution
set -euo pipefail

MEET="${1:-}"
if [ -z "$MEET" ]; then echo "usage: bash bin/meet-now.sh <google-meet-url>"; exit 2; fi

cd "$(dirname "$0")/.."
ENV_FILE=".env.local"
[ -f "$ENV_FILE" ] || { echo "✗ no .env.local — run: node bin/minami-setup.mjs"; exit 1; }

# Read it the way dotenv does: FIRST declaration wins. Reading it any other way is how a duplicate
# empty CANVAS_INGEST_TOKEN once left the ingest endpoint wide open on a public tunnel.
# python3, not awk: macOS ships BWK awk, which has no %q, so the obvious one-liner silently emitted
# `A=%` and `firstB=%` instead of quoted values. shlex.quote is the only portable way to hand arbitrary
# secrets to `eval` without a token containing a quote breaking the shell.
set -a
eval "$(python3 - "$ENV_FILE" <<'PYEOF'
import shlex, sys
seen = set()
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.rstrip("\n")
    if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    k = k.strip()
    if k in seen:          # FIRST declaration wins, exactly as dotenv does
        continue
    seen.add(k)
    print(f"{k}={shlex.quote(v.strip().strip(chr(34)).strip(chr(39)))}")
PYEOF
)"
set +a

PORT="${PORT:-3010}"
RECV_PORT="${RECALL_RECEIVER_PORT:-8787}"
URL_FILE="$HOME/.minami/receiver-url.txt"
mkdir -p "$HOME/.minami"

echo "▸ 1/5  meeting app (its own port and build dir — the dashboard is never touched)"
# ⚠️ THIS USED TO RUN `bash bin/serve.sh --force`, AND THAT KILLED EVERY OPEN CLAUDE CHAT.
#
# Two independent mechanisms, either one fatal:
#   1. --force is the flag that disables serve.sh's own "live turn(s) in flight — not restarting"
#      veto, the single thing standing between a restart and every conversation on the box.
#   2. serve.sh runs `npm run build`, which rewrites .next IN PLACE — the very directory the running
#      dashboard is reading. serve.sh's own comment calls this "the point of no return".
# It did not even hit the intended target: PORT is not exported here, so serve.sh fell back to its
# own default and killed a different port than the one this script then polls.
#
# The launcher pattern is the correct one: our own port, our own dist dir, nothing shared.
export NEXT_DIST_DIR="${NEXT_DIST_DIR:-.next-meet}"
if ! curl -fsS -o /dev/null -m 3 "http://127.0.0.1:${PORT}/"; then
  NODE_ENV=development nohup npx next dev -p "$PORT" > "$HOME/.minami/oncall-app.log" 2>&1 &
  for _ in $(seq 1 60); do curl -fsS -o /dev/null -m 3 "http://127.0.0.1:${PORT}/" && break; sleep 2; done
fi

echo "▸ 2/5  waiting for ingest to require a token"
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 -X POST \
    "http://127.0.0.1:${PORT}/api/canvas/ingest" -H "content-type: application/json" -d '{}' || true)
  case "$code" in
    401) echo "      ✓ 401 — token loaded"; break ;;
    503) echo "      ✗ 503 — CANVAS_INGEST_TOKEN did not load. Run: node bin/minami-setup.mjs --check"; exit 1 ;;
  esac
  [ "$i" = 60 ] && { echo "      ✗ app never came up"; exit 1; }
  sleep 2
done

# ⚠️ EXPORTED BEFORE THE RECEIVER STARTS, not after. The receiver reads CANVAS_INGEST_URL once, at
# boot, and with it unset it runs in DRY RUN — chunks logged, nothing forwarded. That is a whole
# meeting of clean logs, a healthy-looking bot and a permanently empty board. It is not in .env.local
# (the port belongs to whoever is launching), so it has to be set here, ahead of the process that
# needs it.
export CANVAS_INGEST_URL="http://127.0.0.1:${PORT}/api/canvas/ingest"

echo "▸ 3/5  restarting the audio receiver so it reloads the token"
pkill -f "node server/recall-receiver.mjs" 2>/dev/null || true
nohup node server/recall-receiver.mjs > "$HOME/.minami/receiver.log" 2>&1 &
sleep 2
grep -a "recall-receiver on" "$HOME/.minami/receiver.log" | tail -1 | sed 's/^/      /' || echo "      (no banner yet)"

echo "▸ 4/5  tunnel for Recall to dial into"
if ! curl -s -o /dev/null --max-time 6 "$(cat "$URL_FILE" 2>/dev/null || echo http://0)" 2>/dev/null; then
  pkill -f "cloudflared tunnel --url http://localhost:${RECV_PORT}" 2>/dev/null || true
  nohup cloudflared tunnel --url "http://localhost:${RECV_PORT}" > "$HOME/.minami/tunnel-${RECV_PORT}.log" 2>&1 &
  for i in $(seq 1 30); do
    host=$(grep -aoE "https://[a-z0-9-]+\.trycloudflare\.com" "$HOME/.minami/tunnel-${RECV_PORT}.log" | head -1 || true)
    [ -n "$host" ] && { echo "$host" > "$URL_FILE"; break; }
    sleep 1
  done
fi
HOST=$(cat "$URL_FILE")
[ -n "$HOST" ] || { echo "      ✗ no tunnel hostname"; exit 1; }
echo "      $HOST"

echo "▸ 5/5  sending the bot in (audio only — you present the canvas)"
echo ""
echo "   OPEN THIS TAB AND SHARE IT:  http://localhost:${PORT}/canvas?present=1"
echo "   Meet → Present now → A tab → pick it"
echo ""
export RECALL_RECEIVER_URL="wss://${HOST#https://}"
exec node bin/minami-meet.mjs "$MEET" --present
