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
  # The lock must go even when the script dies badly, or the next run is locked out of the room by a
  # bot that is no longer there. The stale-lock check above is the second line of defence, not the first.
  [ -n "${LOCK:-}" ] && rm -f "$LOCK" 2>/dev/null
  dim "dashboard on 3010 untouched"
  echo
}
# P1-1: SIGINT used to run cleanup and then CONTINUE — tearing down every service and then walking
# into the meeting path against a dead app. Traps that mean "stop" must exit.
trap 'cleanup; exit 130' INT TERM HUP
trap cleanup EXIT

# ── 1. the app ──────────────────────────────────────────────────────────────────────────────────
b "  1/4  meeting app"
# ⚠️ ASK "IS THE PORT TAKEN", NOT "IS THE APP FAST".
#
# This decided whether to start an app with `curl -fsS -m 3 /`, and treated any failure as "nothing
# there, start one". A 3s timeout is not an absence test — it is a SPEED test. On 2026-08-19 a
# degraded app was already on this port answering a trivial GET in 3.8s; the probe timed out, the
# launcher concluded the port was free, and tried to start a second server on a port that was by
# definition occupied. It died with EADDRINUSE into a log nobody reads, APP_PID was left pointing at
# a corpse, and the whole meeting then ran against the foreign degraded server — 48 chunks of a real
# call lost to `ingest failed`, with the launcher reporting a clean start throughout.
#
# So the question is answered by the kernel, which cannot be slow: is anything BOUND to this port?
#   nothing bound  -> start one, and verify it actually survived
#   bound + healthy -> reuse it, and do NOT record APP_PID (cleanup must not kill what we did not start)
#   bound + sick    -> STOP. Never try to start a second server on a taken port.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  # Generous timeout: this is a health check, and a busy-but-working app must not be condemned for
  # being busy. That confusion is the entire bug above.
  if curl -fsS -o /dev/null -m 25 "http://127.0.0.1:${PORT}/"; then
    ok "already up on :${PORT} — reusing it"
  else
    no "something is listening on :${PORT} but not answering."
    dim "  Minami will NOT start a second server on a port that is already taken —"
    dim "  that is what silently lost a meeting. Find and stop it, then run this again:"
    dim "    lsof -nP -iTCP:${PORT} -sTCP:LISTEN"
    read -r -p "  enter to close "; exit 1
  fi
else
  NODE_ENV=development NEXT_DIST_DIR="$DIST" nohup npx next dev -p "$PORT" > "$STATE/oncall-app.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 60); do
    # ⚠️ CHECK THE PROCESS IS STILL ALIVE, not only that the port is quiet. A start that dies
    # immediately (EADDRINUSE, a bad env, a syntax error) would otherwise burn the full two minutes
    # of this loop and then report a generic timeout instead of the real reason.
    kill -0 "$APP_PID" 2>/dev/null || { no "the app exited during startup:"; tail -12 "$STATE/oncall-app.log"; read -r -p "  enter to close "; exit 1; }
    curl -fsS -o /dev/null -m 5 "http://127.0.0.1:${PORT}/" && break
    sleep 2
  done
  curl -fsS -o /dev/null -m 10 "http://127.0.0.1:${PORT}/" && ok "up on :${PORT}" || { no "app never came up — see $STATE/oncall-app.log"; tail -12 "$STATE/oncall-app.log"; read -r -p "  enter to close "; exit 1; }
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

# ⚠️ A QUICK TUNNEL IS THE MOST FRAGILE LINK IN THIS WHOLE CHAIN, AND IT FAILS SILENTLY.
#
# The bot streams audio to a PUBLIC url; that url is a Cloudflare quick tunnel, which is ephemeral by
# design. When it dies mid-call the symptom is indistinguishable from a quiet room: the receiver is
# healthy, the app is healthy, every log is clean, and no audio arrives. Observed 2026-08-19 — a
# tunnel flapped for twelve minutes ("control stream encountered a failure while serving", retrying
# every 64s) while a real meeting produced zero cards.
#
# The reuse check was the same mistake as the port check earlier in this file: it asked whether
# cloudflared was RUNNING, not whether the tunnel WORKED. A process that has been failing for two
# hours is still a process, so the launcher happily reused a dead url and dispatched a paid bot at it.
#
# `tunnel_up` therefore proves the url end-to-end with an actual request before trusting it, and
# replaces the tunnel if it cannot. Any HTTP response counts as alive; only a connection failure (000)
# is death.
# ⚠️ THIS MACHINE IS NOT THE CONSUMER OF THE TUNNEL URL. Recall's servers are.
#
# A first version asked "can curl reach it from here?", which conflates two different failures. On
# 2026-08-20 a launch hung for minutes on a tunnel that was working perfectly: cloudflared had
# registered, the receiver answered locally, and `dig` resolved the hostname — but the system
# resolver would not, because four utun VPN interfaces sit in the DNS path. curl said "Could not
# resolve host" and returned 000; `curl --resolve` against the same IP returned 200.
#
# So a local DNS failure was blocking a meeting the bot could have joined. The probe now falls back
# to resolving the name itself and connecting by IP: if the tunnel answers that way, it IS reachable
# from the internet, whatever this Mac's resolver believes.
tunnel_reachable() {
  [ -n "${1:-}" ] || return 1
  local host code ip
  host="${1#https://}"
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null)"
  [ "$code" != "000" ] && return 0
  # System resolver failed. Ask DNS directly and connect by address before believing it is down.
  ip="$(dig +short +time=3 +tries=1 "$host" 2>/dev/null | grep -m1 -E '^[0-9.]+$')"
  [ -n "$ip" ] || return 1
  code="$(curl -s -o /dev/null -m 5 --resolve "${host}:443:${ip}" -w '%{http_code}' "$1" 2>/dev/null)"
  [ "$code" != "000" ]
}

tunnel_up() {
  local existing host code
  existing="$(cat "$STATE/receiver-url.txt" 2>/dev/null || true)"
  if tunnel_reachable "$existing"; then printf '%s' "$existing"; return 0; fi

  # Only ever matched on OUR port, so a cloudflared serving something else is untouched. This is the
  # one place the file's "recorded pids, never pkill -f" rule is relaxed, and deliberately: the dead
  # tunnel may have been started by a previous run of this script that has since exited, so there is
  # no pid to have recorded.
  for pid in $(pgrep -f "cloudflared tunnel --url http://localhost:${RECV_PORT}" 2>/dev/null); do
    kill "$pid" 2>/dev/null
  done
  : > "$STATE/tunnel.log"
  nohup cloudflared tunnel --url "http://localhost:${RECV_PORT}" > "$STATE/tunnel.log" 2>&1 &
  TUNNEL_PID=$!
  # ⚠️ SHOW THE WAIT. This loop probed silently, and a probe that can take 5s plus a sleep meant the
  # launcher could sit on "3/4 tunnel" with a blank screen for minutes — indistinguishable from a
  # crash. cloudflared itself says "it may take some time to be reachable"; the operator deserves to
  # be told the same thing while it happens.
  local waited=0
  for _ in $(seq 1 30); do
    host=$(grep -aoE "https://[a-z0-9-]+\.trycloudflare\.com" "$STATE/tunnel.log" | head -1)
    # PRINTED IS NOT READY. cloudflared logs the hostname before the edge serves it, so a bot
    # dispatched the instant the url appears can miss the first seconds of a call — or all of it.
    if tunnel_reachable "$host"; then
      printf '\r\033[K' >&2
      printf '%s' "$host" > "$STATE/receiver-url.txt"; printf '%s' "$host"; return 0
    fi
    waited=$((waited + 2))
    printf '\r  \033[2mwaiting for the tunnel to answer — %ss%s\033[0m' "$waited" "${host:+ · ${host#https://}}" >&2
    sleep 2
  done
  printf '\r\033[K' >&2
  [ -n "${host:-}" ] && printf '  \033[2mlast url seen: %s\033[0m\n' "$host" >&2
  return 1
}

HOST="$(tunnel_up)" || { no "no working tunnel — check $STATE/tunnel.log"; read -r -p "  enter to close "; exit 1; }
ok "${HOST#https://} (reachable)"

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
# Same rule as the learning loop below: absent vault, absent feature, no noise. The `|| true` already
# swallowed the error, but testing for the file says WHY there is no list instead of showing an empty
# prompt that looks like a bug.
PROJECTS=""
[ -f bin/vault-projects.mjs ] && PROJECTS="$(node bin/vault-projects.mjs 2>/dev/null || true)"
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

# ── the shape of the meeting ────────────────────────────────────────────────────────────────────
# Anh's own reason for wanting these: in a sharing session or a sales call the agenda is known in
# advance, and without it the judge wanders — "agenda nó khá là rõ… nó cứ pick từ đấy nó đỡ bị lạc".
# Picking one seeds the topics the board hangs everything under, before a word is spoken.
TEMPLATE=""
TPLS="$(curl -s -m 6 "http://127.0.0.1:${PORT}/api/templates" 2>/dev/null \
  | python3 -c "
import json,sys
try: t=json.load(sys.stdin).get('templates',[])
except Exception: t=[]
for i,x in enumerate(t,1): print(f\"{i}. {x['name']} — {', '.join(x['topics'][:4])}\")
" 2>/dev/null || true)"
if [ -n "$TPLS" ]; then
  echo
  b "  start from a shape?"
  echo "$TPLS" | sed 's/^/     /'
  dim "enter to skip"
  read -r -p "  number: " TNUM
  # Digits only. `sed -n "abcp"` prints its own usage error into the middle of a launch, which reads
  # as a crash at exactly the moment anh is about to dial into a call.
  case "$TNUM" in (*[!0-9]*) TNUM="" ;; esac
  if [ -n "$TNUM" ]; then
    TEMPLATE="$(echo "$TPLS" | sed -n "${TNUM}p" | sed 's/^[0-9]*\. //; s/ — .*//')"
    [ -n "$TEMPLATE" ] && ok "$TEMPLATE"
  fi
fi
export CANVAS_MEETING_TEMPLATE="$TEMPLATE"

curl -s -o /dev/null -X POST "http://127.0.0.1:${PORT}/api/canvas?reset=1" -H "authorization: Bearer ${CANVAS_INGEST_TOKEN:-}"
echo
b "  share this tab in Meet"
printf "  \033[4mhttp://localhost:%s/canvas?present=1\033[0m\n" "$PORT"
dim "Present now → A tab → pick it"
open "http://localhost:${PORT}/canvas?present=1" 2>/dev/null
echo

# ⚠️ ONE BOT PER ROOM. A Recall bot is BILLED, and a second one in the same call costs twice while
# also doubling the audio the pipeline must chew — each bot streams every participant.
#
# Not hypothetical: on 2026-08-19 the canvas froze (the port bug above), the meeting looked dead, anh
# relaunched, and two bots sat in udm-aion-awd for twenty minutes — double billing and double ingest
# load on a server already failing under single load. Relaunching when something looks broken is the
# correct human instinct; the script is what has to know better.
#
# ⚠️ A RECORDED PID, NOT `pgrep -f`. Measured while writing this: `pgrep -f "minami-meet.mjs.*CODE"`
# matched the very pipeline that ran it and MISSED two live bots — a false positive and a false
# negative in the same breath. It is the same hazard this file already documents for `pkill -f`, and
# a guard that answers wrongly in both directions is worse than none. The lock is a file this script
# writes and removes, and the PID in it is verified to still be a bot before it is believed.
MEET_CODE="$(printf '%s' "$MEET" | sed -E 's#.*meet\.google\.com/##; s#[?&].*##')"
LOCK=""
if [ -n "$MEET_CODE" ]; then
  LOCK="$STATE/bot-${MEET_CODE}.pid"
  if [ -f "$LOCK" ]; then
    OTHER="$(cat "$LOCK" 2>/dev/null)"
    # Two conditions, both required. A PID alone is not proof: pids are reused, and a stale lock from
    # a crash must never lock anh out of his own meeting.
    if [ -n "$OTHER" ] && kill -0 "$OTHER" 2>/dev/null && ps -p "$OTHER" -o command= 2>/dev/null | grep -q 'minami-meet\.mjs'; then
      no "a Minami bot is ALREADY in ${MEET_CODE} (pid ${OTHER})"
      dim "  Two bots in one room bill twice and halve the pipeline's throughput."
      dim "  If that one is stuck, stop it first — it leaves the call cleanly:"
      dim "    kill -INT ${OTHER}"
      dim "  Then run this again."
      read -r -p "  enter to close "; exit 1
    fi
    dim "clearing a stale bot lock for ${MEET_CODE}"
    rm -f "$LOCK"
  fi
fi

# ⚠️ THE TUNNEL IS WATCHED FOR THE WHOLE CALL, AND A DEAD ONE IS REPAIRED RATHER THAN REPORTED.
#
# Verifying the tunnel once at startup is not enough — it dies MID-call, which is exactly when nobody
# is looking at a terminal. And it cannot simply be restarted underneath a running bot: Recall bakes
# the receiver url into the bot at creation (realtime_endpoints), and a quick-tunnel hostname rotates
# on every restart. So the only real repair is a fresh tunnel AND a fresh bot.
#
# That is what this loop does. The watchdog polls the url; two consecutive failures (~30s) mean the
# tunnel is gone rather than blipping, so it stops the bot — cleanly, with SIGINT, so the bot leaves
# the room instead of being abandoned there billing. The loop then gets a new tunnel and rejoins.
#
# Bounded at 3 rejoins. If a call needs a fourth, the problem is not the tunnel and silently
# re-dispatching paid bots at it is the wrong answer.
REJOINS=0
MAX_REJOINS=3
watch_tunnel() {
  local fails=0
  while kill -0 "$BOT_PID" 2>/dev/null; do
    sleep 15
    kill -0 "$BOT_PID" 2>/dev/null || return 0
    if tunnel_reachable "$HOST"; then
      fails=0
    else
      fails=$((fails + 1))
      # One failure is a blip — a quick tunnel drops a request now and then and recovers on its own.
      # Two in a row, thirty seconds apart, is an outage.
      if [ "$fails" -ge 2 ]; then
        printf '\n  \033[31m✗\033[0m tunnel is down — the bot cannot send audio. Rejoining with a fresh one.\n'
        touch "$STATE/tunnel-died"
        kill -INT "$BOT_PID" 2>/dev/null
        return 0
      fi
    fi
  done
}

while :; do
  export RECALL_RECEIVER_URL="wss://${HOST#https://}"
  rm -f "$STATE/tunnel-died"
  CANVAS_MEETING_CONTEXT="${CTX:-}" node bin/minami-meet.mjs "$MEET" --present &
  BOT_PID=$!
  [ -n "$LOCK" ] && printf '%s' "$BOT_PID" > "$LOCK"
  watch_tunnel &
  WATCH_PID=$!
  wait "$BOT_PID" 2>/dev/null
  kill "$WATCH_PID" 2>/dev/null

  # A normal exit — anh hung up, or the bot left on its own — ends the call. Only a tunnel death
  # rejoins, and only while there is budget for it.
  [ -f "$STATE/tunnel-died" ] || break
  rm -f "$STATE/tunnel-died"
  REJOINS=$((REJOINS + 1))
  if [ "$REJOINS" -gt "$MAX_REJOINS" ]; then
    no "the tunnel has failed ${MAX_REJOINS} times — stopping rather than dispatching more bots"
    dim "  Something upstream is wrong. See $STATE/tunnel.log"
    break
  fi
  b "  reconnecting (${REJOINS}/${MAX_REJOINS})"
  HOST="$(tunnel_up)" || { no "could not raise a new tunnel — see $STATE/tunnel.log"; break; }
  ok "${HOST#https://} (reachable)"
  dim "rejoining the call — you may need to re-admit Minami"
done

# ── THE LEARNING LOOP ───────────────────────────────────────────────────────────────────────────
# A call that never reaches the vault may as well not have happened — the vault is where anh actually
# thinks, and "losing the thread" is the bottleneck this whole product exists to fix. One way only:
# meeting → vault, never the reverse, because speech-to-text mishears and must never edit his prose.
# ⚠️ THE WHOLE BLOCK IS OPTIONAL, because this script also ships in a standalone repo that has no
# vault and no bin/meeting-to-vault.mjs. Calling a missing script printed a node stack trace at the
# end of every meeting there — the last thing a first-time user sees, and it reads as "this is
# broken" rather than "this part is not for you". A feature that depends on a personal notes system
# must be absent quietly when that system is absent.
LATEST="$(ls -t "$HOME/.minami/meetings" 2>/dev/null | grep -v '^index.md$' | head -1)"
if [ -n "$LATEST" ] && [ -f bin/meeting-to-vault.mjs ]; then
  echo
  b "  syncing to your notes"
  node bin/meeting-to-vault.mjs "$LATEST" ${PROJECT_SLUG:+--project "$PROJECT_SLUG"} 2>&1 | sed 's/^/  /'
  # Reaches every device, and is what makes the note real rather than a file on one Mac.
  if [ -x "$HOME/secondBrain/bin/sync.sh" ]; then
    bash "$HOME/secondBrain/bin/sync.sh" "minami: $LATEST" >/dev/null 2>&1 && dim "vault synced" || dim "vault sync skipped"
  fi
elif [ -n "$LATEST" ]; then
  echo
  dim "meeting saved to ~/.minami/meetings/$LATEST"
fi

echo
b "  meeting finished"
dim "Ctrl-C or close this window to stop the app, receiver and tunnel"
read -r -p "  enter to stop everything "
