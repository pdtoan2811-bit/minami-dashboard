#!/bin/bash
# PRE-FLIGHT — prove the whole chain works before a client is watching.
#
# Double-click this before a day of calls. It checks the credentials the way the app does, then puts a
# real clip through the real pipeline and shows what came back.
#
# Why a real clip and not just a key check: every serious outage in this project has been something
# that LOOKED fine. The keys were present and the ear was on the wrong model; the receiver was up and
# the tunnel was dead; the app answered and the board was frozen behind a stalled judge. "Configured"
# and "working" are different claims, and only one of them matters at 9am.
#
# It does NOT start a tunnel or a bot — nothing here costs Recall minutes. The tunnel is checked by
# the launcher, which is the only thing that needs it.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
PORT=3011
STATE="$HOME/.minami"; mkdir -p "$STATE"

b()  { printf "\033[1m%s\033[0m\n" "$1"; }
ok() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
no() { printf "  \033[31m✗\033[0m %s\n" "$1"; }
dim(){ printf "  \033[2m%s\033[0m\n" "$1"; }

clear
b "  Minami — pre-flight"
dim "checks the keys, the app, and one real utterance end to end"
echo

b "  1/3  credentials"
node bin/minami-setup.mjs --check 2>&1 | sed 's/^/  /'
echo

b "  2/3  the meeting app"
if curl -fsS -o /dev/null -m 20 "http://127.0.0.1:${PORT}/"; then
  ok "already up on :${PORT}"
elif lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  no "something is on :${PORT} but not answering — stop it first:"
  dim "lsof -nP -iTCP:${PORT} -sTCP:LISTEN"
  read -r -p "  enter to close "; exit 1
else
  dim "starting it…"
  NODE_ENV=development NEXT_DIST_DIR=".next-meet" nohup npx next dev -p "$PORT" > "$STATE/preflight-app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 45); do
    kill -0 "$APP_PID" 2>/dev/null || { no "the app exited during startup:"; tail -10 "$STATE/preflight-app.log"; read -r -p "  enter to close "; exit 1; }
    curl -fsS -o /dev/null -m 5 "http://127.0.0.1:${PORT}/" && break
    sleep 2
  done
  curl -fsS -o /dev/null -m 10 "http://127.0.0.1:${PORT}/" && ok "up on :${PORT}" \
    || { no "app never came up — see $STATE/preflight-app.log"; read -r -p "  enter to close "; exit 1; }
fi
echo

b "  3/3  one real utterance, all the way to a card"
node bin/preflight-chunk.mjs "$PORT"
CODE=$?

echo
if [ "$CODE" = "0" ]; then
  b "  ready"
  dim "launch a call with 'Minami Call.command'"
else
  no "NOT ready — fix the above before your call"
fi
echo
read -r -p "  enter to close "
