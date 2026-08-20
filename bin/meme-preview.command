#!/bin/bash
# MEME PREVIEW — watch every cut scene play, without holding a meeting.
#
# Double-click this file. It starts the meeting app if it isn't already up, then opens the canvas in
# preview mode, where all eleven moments play back to back on a loop.
#
# Why this exists: a cut scene is the one surface on this canvas whose entire job is how it FEELS,
# and the only way to see one was to hold a real call and hope the judge marked the right card. That
# is a terrible feedback loop for deciding whether a gif lands.
#
# Nothing here touches a meeting. It renders locally and stops when you close the tab.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
STATE="$HOME/.minami"; mkdir -p "$STATE"
PORT=3011              # never 3010 — see Minami Call.command
DIST=".next-meet"

b()  { printf "\033[1m%s\033[0m\n" "$1"; }
ok() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
no() { printf "  \033[31m✗\033[0m %s\n" "$1"; }
dim(){ printf "  \033[2m%s\033[0m\n" "$1"; }

clear
b "  Minami — meme preview"
echo

# ⚠️ Same rule as the launcher: ask whether the port ANSWERS, not whether a process exists. A
# degraded app on this port once cost a live meeting, and starting a second one on a taken port
# fails with EADDRINUSE into a log nobody reads.
if curl -fsS -o /dev/null -m 20 "http://127.0.0.1:${PORT}/"; then
  ok "app already up on :${PORT}"
elif lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  no "something is on :${PORT} but not answering — stop it first:"
  dim "  lsof -nP -iTCP:${PORT} -sTCP:LISTEN"
  read -r -p "  enter to close "; exit 1
else
  dim "starting the meeting app…"
  NODE_ENV=development NEXT_DIST_DIR="$DIST" nohup npx next dev -p "$PORT" > "$STATE/preview-app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 60); do
    kill -0 "$APP_PID" 2>/dev/null || { no "the app exited during startup:"; tail -12 "$STATE/preview-app.log"; read -r -p "  enter to close "; exit 1; }
    curl -fsS -o /dev/null -m 5 "http://127.0.0.1:${PORT}/" && break
    sleep 2
  done
  curl -fsS -o /dev/null -m 10 "http://127.0.0.1:${PORT}/" || { no "app never came up — see $STATE/preview-app.log"; read -r -p "  enter to close "; exit 1; }
  ok "up on :${PORT}"
fi

echo
b "  what you have collected"
TOTAL=0
for d in public/memes/*/; do
  name="$(basename "$d")"
  [ "${name#_}" != "$name" ] && continue          # _unsorted is staging, never played
  n=$(find "$d" -type f \( -iname '*.gif' -o -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' \) 2>/dev/null | wc -l | tr -d ' ')
  TOTAL=$((TOTAL + n))
  if [ "$n" -gt 0 ]; then printf "  \033[32m%2d\033[0m  %s\n" "$n" "$name"
  else                    printf "  \033[2m %d  %s — falls back to the emoji scene\033[0m\n" "$n" "$name"; fi
done
echo
dim "$TOTAL file(s). An empty folder is fine — that moment just plays the emoji."
echo
b "  playing all eleven moments, ~6s each"
dim "close the tab to stop"
open "http://127.0.0.1:${PORT}/canvas?present=1&memes=preview" 2>/dev/null
echo
