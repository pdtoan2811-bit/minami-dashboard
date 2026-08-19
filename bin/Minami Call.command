#!/bin/bash
# MINAMI ON CALL — the dedicated meeting app. Double-click this file in Finder.
#
# This is a SEPARATE APP from the Minami Dashboard, and the separation is the whole point:
#
#   Dashboard   port 3010, `npm start`, and it HOSTS Thomas's Claude chats — a chat's process tree is
#               `claude <- next-server <- npm start`. Restarting it kills every open conversation.
#   On Call     port 3011, its own build directory (.next-meet), its own lifecycle. Start it, stop it,
#               restart it mid-meeting — the dashboard never notices.
#
# Nothing in this script may touch 3010. That is not a preference; it is the reason this file exists.
#
# What it starts, in dependency order:
#   1. the meeting app       localhost:3011 — the canvas and the ingest endpoint
#   2. the audio receiver    localhost:8787 — where Recall streams per-participant audio
#   3. a cloudflare tunnel   the only publicly reachable piece, token-gated
#   4. the bot               joins the Meet link, audio only; you present the canvas yourself
#
# Quit with Ctrl-C, or close the Terminal window — the trap below stops everything it started.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
APP_DIR="$PWD"
STATE="$HOME/.minami"
mkdir -p "$STATE"

# Defined here so the banner and helpers can use them, and RE-ASSERTED after the .env.local eval so
# a PORT= line in that file cannot redirect this script at the dashboard. Both halves are required:
# declaring only after the eval left $PORT unbound at the banner, and `set -u` made that fatal on
# line 39 — the script died before it did anything at all.
PORT=3011              # never 3010
RECV_PORT=8787
DIST=".next-meet"

b()  { printf "\033[1m%s\033[0m\n" "$1"; }
ok() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
no() { printf "  \033[31m✗\033[0m %s\n" "$1"; }
dim(){ printf "  \033[2m%s\033[0m\n" "$1"; }

clear
b "  Minami — On Call"
dim "$APP_DIR · port $PORT · the dashboard on 3010 is not touched"
echo

# ── env, read the way dotenv does (first declaration wins) ──────────────────────────────────────
[ -f .env.local ] || { no "no .env.local — run: node bin/minami-setup.mjs"; read -r -p "  enter to close "; exit 1; }
set -a
eval "$(python3 - .env.local <<'PYEOF'
import re, shlex, sys
seen = set()
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.rstrip("\n")
    if not line.strip() or line.lstrip().startswith("#") or "=" not in line: continue
    k, v = line.split("=", 1); k = k.strip()
    # shlex.quote protected the VALUE; the KEY was printed raw, so a malformed or pasted line like
    # `EVIL; rm -rf x ; A=1` became shell code inside eval. A key is [A-Za-z_][A-Za-z0-9_]* or it is
    # not a key.
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k) or k in seen: continue
    seen.add(k)
    print(f"{k}={shlex.quote(v.strip().strip(chr(34)).strip(chr(39)))}")
PYEOF
)"
set +a

# ⚠️ RE-ASSERTED AFTER THE EVAL, AND DELIBERATELY. `set -a; eval …` exports every key in .env.local,
# so a `PORT=` line there — and .env.example ships one, while minami-setup reads PORT as the APP port
# defaulting to 3010 — would otherwise redirect this whole script at the dashboard. These three are
# not negotiable by config.
PORT=3011              # never 3010
RECV_PORT=8787
DIST=".next-meet"
export CANVAS_INGEST_URL="http://127.0.0.1:${PORT}/api/canvas/ingest"

# ⚠️ THE EAR IS NOT INHERITABLE. Same class of hazard as PORT above, and it bit harder.
#
# `.env.local` is the only file anyone thinks to check, so an ear pinned in a PARENT SHELL'S
# ENVIRONMENT is invisible: nothing in the repo mentions it, git is clean, and the code default reads
# gemini while the running server is on something else. That happened — a stale
# CANVAS_STT_MODEL=qwen/qwen3-asr-flash was inherited from the shell this was launched from, and qwen
# is a pure ASR that cannot be told English terminology exists. Measured on one Vietnamese clip with
# ten embedded English terms: 0/10 inherited vs 10/10 on the default. Same audio, same prompt.
#
# So: .env.local may set the ear, and code may set the ear. The ambient environment may not.
if ! grep -qE '^[[:space:]]*CANVAS_STT_MODEL=[^[:space:]]' .env.local 2>/dev/null; then
  if [ -n "${CANVAS_STT_MODEL:-}" ]; then
    printf '  ⚠ ignoring inherited CANVAS_STT_MODEL=%s — using the ear the code declares\n' "$CANVAS_STT_MODEL"
  fi
  unset CANVAS_STT_MODEL
fi

# ── everything this script starts, it stops ─────────────────────────────────────────────────────
# Only processes matched by OUR port and OUR dist dir, so a dashboard rebuild running at the same
# time survives untouched.
# ⚠️ RECORDED PIDs, NEVER `pkill -f`.
#
# Two reasons the pattern approach had to go:
#   1. `pkill -f "node server/recall-receiver.mjs"` matches ANY process whose full command line
#      contains that string — including a Claude Code Bash call that greps for, edits or merely
#      discusses that filename. It could kill a tool call inside one of anh's chats.
#   2. It tore down services this run did not start. Opening a second window while a meeting was
#      running killed the first meeting's receiver and tunnel mid-call, leaving the paid bot in the
#      room streaming to nothing.
#
# Cleanup is also idempotent: the INT/TERM traps exit, so EXIT would otherwise run it a second time.
CLEANED=0
cleanup() {
  [ "$CLEANED" = "1" ] && return 0
  CLEANED=1
  echo
  b "  stopping"
  # The bot gets SIGINT, not SIGTERM: minami-meet installs a handler that leaves the call before
  # exiting. Killing it rudely is how a bot gets abandoned in a room, billing.
  if [ -n "${BOT_PID:-}" ]; then kill -INT "$BOT_PID" 2>/dev/null && wait "$BOT_PID" 2>/dev/null; ok "bot left the call"; fi
  [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null && ok "tunnel"
  [ -n "${RECV_PID:-}" ]   && kill "$RECV_PID"   2>/dev/null && ok "receiver"
  [ -n "${APP_PID:-}" ]    && kill "$APP_PID"    2>/dev/null && ok "app (:${PORT})"
  [ -z "${APP_PID:-}" ]    && dim "app was already running — left alone"
  dim "dashboard on 3010 untouched"
  echo
}
# P1-1: SIGINT used to run cleanup and then CONTINUE — tearing down every service and then walking
# into the meeting path against a dead app. Traps that mean "stop" must exit.
trap 'cleanup; exit 130' INT TERM HUP
trap cleanup EXIT

# ── 1. the app ──────────────────────────────────────────────────────────────────────────────────
b "  1/4  meeting app"
if curl -fsS -o /dev/null -m 3 "http://127.0.0.1:${PORT}/"; then
  ok "already up on :${PORT}"
else
  NODE_ENV=development NEXT_DIST_DIR="$DIST" nohup npx next dev -p "$PORT" > "$STATE/oncall-app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 60); do
    curl -s -o /dev/null -m 3 "http://127.0.0.1:${PORT}/" && break
    sleep 2
  done
  curl -s -o /dev/null -m 3 "http://127.0.0.1:${PORT}/" && ok "up on :${PORT}" || { no "app never came up — see $STATE/oncall-app.log"; read -r -p "  enter to close "; exit 1; }
fi
# 401 is the CORRECT answer: the token loaded. 503 means it did not, and audio would be refused all call.
code=$(curl -s -o /dev/null -w "%{http_code}" -m 5 -X POST "http://127.0.0.1:${PORT}/api/canvas/ingest" -H "content-type: application/json" -d '{}')
# A hard stop, not a warning: 503 means the token did not load, so audio would be refused for the
# whole call. Dispatching a paid bot into that is the worst of both outcomes.
if [ "$code" = "401" ]; then ok "ingest secured (401)"
else no "ingest returned $code — expected 401. Run: node bin/minami-setup.mjs --check"; read -r -p "  enter to close "; exit 1; fi

# ── 2. the receiver ─────────────────────────────────────────────────────────────────────────────
b "  2/4  audio receiver"
# ⚠️ REUSE, DO NOT DUPLICATE. The blanket `pkill` that used to sit here was removed because it could
# match an unrelated process (including a Bash call inside one of anh's chats) — but without a guard
# this then started a SECOND receiver that loses the race for :8787 and dies silently, leaving the
# meeting pointed at whichever one won. If something is already listening, use it and leave it alone;
# whoever started it also owns stopping it.
if lsof -nP -iTCP:"$RECV_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  ok "already listening on :${RECV_PORT} — reusing it"
else
  nohup node server/recall-receiver.mjs > "$STATE/receiver.log" 2>&1 &
  RECV_PID=$!
  sleep 2
fi
if ! lsof -nP -iTCP:"$RECV_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  no "receiver did not start — see $STATE/receiver.log"; read -r -p "  enter to close "; exit 1
fi
ok "receiver ready on :${RECV_PORT} → :${PORT}"

# ── 3. the tunnel ───────────────────────────────────────────────────────────────────────────────
# Quick-tunnel hostnames rotate on every restart and are printed only to stdout — losing one has cost
# a meeting before, so it is captured to a file the moment it appears.
b "  3/4  tunnel"
# Same rule as the receiver: a live tunnel whose hostname we still have is reused rather than
# replaced. Quick-tunnel hostnames rotate on every restart, so needlessly recreating one also
# invalidates a URL a running meeting may be streaming to.
EXISTING="$(cat "$STATE/receiver-url.txt" 2>/dev/null || true)"
if [ -n "$EXISTING" ] && pgrep -f "cloudflared tunnel --url http://localhost:${RECV_PORT}" >/dev/null 2>&1; then
  HOST="$EXISTING"
  ok "reusing ${HOST#https://}"
else
  nohup cloudflared tunnel --url "http://localhost:${RECV_PORT}" > "$STATE/tunnel.log" 2>&1 &
  TUNNEL_PID=$!
fi
if [ -z "${HOST:-}" ]; then
  for _ in $(seq 1 45); do
    HOST=$(grep -aoE "https://[a-z0-9-]+\.trycloudflare\.com" "$STATE/tunnel.log" | head -1)
    [ -n "$HOST" ] && break
    sleep 1
  done
fi
[ -n "$HOST" ] || { no "no tunnel hostname — check $STATE/tunnel.log"; read -r -p "  enter to close "; exit 1; }
echo "$HOST" > "$STATE/receiver-url.txt"
ok "${HOST#https://}"

# ── 4. start a call, or go read one ─────────────────────────────────────────────────────────────
# Two different jobs share these services. Starting a meeting needs the bot and the tunnel; browsing
# the archive needs only the app — but it needs it RUNNING, which is the whole reason this choice
# lives here rather than in a second script anh would have to remember exists.
echo
b "  4/4  what now?"
echo "     1  start a new meeting"
echo "     2  browse past meetings"
echo "     3  quit"
echo
MEET="${1:-}"
if [ -z "$MEET" ]; then
  read -r -p "  choose [1] " CHOICE
  CHOICE="${CHOICE:-1}"
  case "$CHOICE" in
    2)
      echo
      b "  library"
      printf "  \033[4mhttp://localhost:%s/meetings\033[0m\n" "$PORT"
      dim "search runs across every card AND every transcript"
      open "http://localhost:${PORT}/meetings" 2>/dev/null
      echo
      # The tunnel is the only publicly reachable piece and reading needs nothing from outside, so it
      # comes down straight away rather than idling open for the length of a browsing session.
      [ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null && dim "tunnel closed — not needed for reading"
      echo
      read -r -p "  enter to stop everything "
      exit 0
      ;;
    3) exit 0 ;;
  esac
  read -r -p "  paste the Google Meet link: " MEET
fi
case "$MEET" in
  *meet.google.com*) ;;
  *) no "that does not look like a Meet link"; read -r -p "  enter to close "; exit 1 ;;
esac

# ── WHAT IS THIS CALL ABOUT ─────────────────────────────────────────────────────────────────────
# Asked BEFORE the bot joins, because the judge names its first topic from the first thing it hears —
# and the first thing it hears is always hello-how-are-you. That placeholder then anchors the whole
# board, since later cards are told to reuse existing topics. Thirty seconds of small talk was
# deciding the shape of the next hour.
#
# The list comes from the vault: these are the projects anh actually writes about, so picking one is
# faster and more accurate than retyping a name his own notes already hold.
echo
b "  what is this call about?"
PROJECTS="$(node bin/vault-projects.mjs 2>/dev/null || true)"
if [ -n "$PROJECTS" ]; then
  echo "$PROJECTS" | sed 's/^/     /'
  echo
fi
read -r -p "  number, or type a short note (blank to skip): " CTX
case "$CTX" in
  "") ;;
  *[!0-9]*) ;;                                   # free text — use as typed
  *) # The list has company headings interleaved, so match the numbered line rather than counting rows.
     PICK="$(echo "$PROJECTS" | grep -E "^ *${CTX}\. " | sed 's/^ *[0-9]*\. *//')"
     if [ -n "$PICK" ]; then
       CTX="$PICK"
       # Remember the slug so the meeting can be linked back into that project note afterwards.
       PROJECT_SLUG="$(node bin/vault-projects.mjs --json 2>/dev/null \
         | python3 -c "
import json,sys
want=sys.argv[1].strip().lower()
for g in json.load(sys.stdin):
    for p in g['projects']:
        if p['name'].strip().lower()==want: print(p['slug']); raise SystemExit
" "$PICK" 2>/dev/null || true)"
     fi ;;
esac
[ -n "$CTX" ] && dim "context: $CTX"

curl -s -o /dev/null -X POST "http://127.0.0.1:${PORT}/api/canvas?reset=1" -H "authorization: Bearer ${CANVAS_INGEST_TOKEN:-}"
export RECALL_RECEIVER_URL="wss://${HOST#https://}"

echo
b "  share this tab in Meet"
printf "  \033[4mhttp://localhost:%s/canvas?present=1\033[0m\n" "$PORT"
dim "Present now → A tab → pick it"
open "http://localhost:${PORT}/canvas?present=1" 2>/dev/null
echo

CANVAS_MEETING_CONTEXT="${CTX:-}" node bin/minami-meet.mjs "$MEET" --present &
BOT_PID=$!
wait "$BOT_PID"

# ── THE LEARNING LOOP ───────────────────────────────────────────────────────────────────────────
# A call that never reaches the vault may as well not have happened — the vault is where anh actually
# thinks, and "losing the thread" is the bottleneck this whole product exists to fix. One way only:
# meeting → vault, never the reverse, because speech-to-text mishears and must never edit his prose.
LATEST="$(ls -t "$HOME/.minami/meetings" 2>/dev/null | grep -v '^index.md$' | head -1)"
if [ -n "$LATEST" ]; then
  echo
  b "  syncing to Second Brain"
  node bin/meeting-to-vault.mjs "$LATEST" ${PROJECT_SLUG:+--project "$PROJECT_SLUG"} 2>&1 | sed 's/^/  /'
  # Reaches every device, and is what makes the note real rather than a file on one Mac.
  bash "$HOME/secondBrain/bin/sync.sh" "minami: $LATEST" >/dev/null 2>&1 && dim "vault synced" || dim "vault sync skipped"
fi

echo
b "  meeting finished"
dim "Ctrl-C or close this window to stop the app, receiver and tunnel"
read -r -p "  enter to stop everything "
