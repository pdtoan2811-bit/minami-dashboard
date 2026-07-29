#!/usr/bin/env bash
# Build + (re)serve Minami Bento in PRODUCTION mode on :3000.
#
# Why production: `next dev` hot-reloads code into the *running* page (Fast Refresh). When you use the
# dashboard to edit the dashboard's own code, that hot-patch changes React's hook signatures mid-session
# and CRASHES the very tab you're working in. Production mode has no Fast Refresh — the running app is
# never touched by edits, so it can't crash from a rebuild.
#
# Why the drain (2026-07-29): every LIVE chat session lives inside the Next.js server process, and each
# session's `claude` subprocess is a CHILD of it. So the swap below doesn't just replace the UI — it
# kills every in-flight turn on the box, along with its MCP servers. That was the real cause of "my
# request got interrupted and I never touched anything": the trigger is usually a *different* pane
# redeploying after an edit, so it lands on whoever happens to be typing. This script now refuses to do
# that silently. See the "Restart safety" block in lib/agent/manager.ts.
#
# Usage:
#   bash bin/serve.sh            # refuses to swap while a turn is in flight
#   bash bin/serve.sh --force    # swap anyway (still warns the panes first)
#
# Workflow: drive changes from the live app → Claude edits the files → run `bash bin/serve.sh` to apply.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
# Not /tmp — macOS clears it on boot, and this is the server's own stderr: the place a crash loop or a
# failed build actually explains itself. deploy.sh quotes its tail into the failure alert, so losing it
# on reboot silently degrades that alert to "it failed" with no reason. See the note in deploy.sh.
LOG="${PROD_LOG:-$HOME/.minami/prod.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
HEALTH="http://localhost:${PORT}/api/agent/health"
DRAIN_TIMEOUT_MS="${DRAIN_TIMEOUT_MS:-60000}"
TOKEN_FILE=".minami-drain-token"

# Shared secret for the restart-safety endpoint. It gates a call that can stall every chat on the box,
# and `next start` binds 0.0.0.0 so the phone view works — meaning anything on the Wi-Fi can reach it.
# Header-based "is this loopback?" checks don't work here (Next always injects x-forwarded-for, and a
# client can forge both it and Host — see the comment in app/api/agent/health/route.ts), so the gate is
# possession of this file: same privilege level as being able to run this script at all. Generated on
# first use, 0600, gitignored.
if [ ! -s "$TOKEN_FILE" ]; then
  # `umask 077` so the file is never briefly world-readable between creation and chmod.
  ( umask 077; openssl rand -hex 32 > "$TOKEN_FILE" )
  chmod 600 "$TOKEN_FILE"
  echo "▸ provisioned $TOKEN_FILE (restart-safety endpoint auth)"
fi
DRAIN_TOKEN="$(cat "$TOKEN_FILE")"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    *) echo "unknown argument: $arg (expected --force)"; exit 2 ;;
  esac
done

# Ask the running server what a restart would destroy. Empty output = no server, or a build too old to
# have this endpoint — both mean "nothing to protect", so the caller proceeds.
live_stats() { curl -s --max-time 3 -H "x-minami-drain-token: ${DRAIN_TOKEN}" "$HEALTH" 2>/dev/null || true; }

# Extract a field from the health JSON without assuming jq is installed. Prints "" for anything that
# isn't a well-formed stats object, which the callers treat as "no server to protect".
stat_field() {
  python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
if not isinstance(d,dict) or "busy" not in d: print(""); sys.exit(0)
print(d.get(sys.argv[1],""))
' "$1" 2>/dev/null || true
}

describe_busy() {
  python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for s in d.get("details",[]):
    if s.get("busy"):
        print("    - %s : %s" % (s.get("cwd","?"), s.get("label","working")))
' 2>/dev/null || true
}

# ---- preflight: check BEFORE the build ------------------------------------------------------------
# The build is the point of no return: `next build` replaces .next in place, underneath the server
# that's currently reading it. Bailing out after that would leave the old process serving a build it no
# longer has on disk. So the "is anyone busy?" veto has to happen here, while backing out is still free.
STATS="$(live_stats)"
BUSY="$(printf '%s' "$STATS" | stat_field busy)"
if [ -n "$BUSY" ] && [ "$BUSY" != "0" ] && [ "$FORCE" = "0" ]; then
  echo "✋ $BUSY live turn(s) in flight — not restarting, that would kill them mid-sentence:"
  printf '%s' "$STATS" | describe_busy
  echo
  echo "   Wait for them to finish and re-run, or force the swap with:"
  echo "     bash bin/serve.sh --force"
  exit 1
fi

echo "▶ building (production, no Fast Refresh)…"
npm run build

# ---- drain: warn the panes, let in-flight turns land ----------------------------------------------
# Past this point we're committed. Give any turn that started during the build a bounded chance to
# finish and write its result to the JSONL — that file is what a pane reconciles against when it
# reconnects to the new build, so a turn that lands here survives the restart in the transcript.
if [ -n "$BUSY" ]; then
  echo "▶ draining live sessions (warning panes, up to $((DRAIN_TIMEOUT_MS / 1000))s)…"
  DRAIN="$(curl -s --max-time $(( DRAIN_TIMEOUT_MS / 1000 + 10 )) -X POST "$HEALTH" \
    -H 'Content-Type: application/json' \
    -H "x-minami-drain-token: ${DRAIN_TOKEN}" \
    -d "{\"action\":\"drain\",\"timeoutMs\":${DRAIN_TIMEOUT_MS}}" 2>/dev/null || true)"
  LEFT="$(printf '%s' "$DRAIN" | python3 -c '
import json,sys
try: print(json.load(sys.stdin).get("stillBusy",""))
except Exception: print("")
' 2>/dev/null || true)"
  if [ -n "$LEFT" ] && [ "$LEFT" != "0" ]; then
    echo "  ! $LEFT turn(s) still running after the drain window — they will be cut off."
  else
    echo "  ✓ all sessions quiet"
  fi
fi

# ---- swap ------------------------------------------------------------------------------------------
# Brace the expansion: a multibyte char immediately after $PORT gets swallowed into the variable name
# when the shell isn't in a valid UTF-8 locale (e.g. LC_CTYPE=UTF-8, which macOS doesn't recognise), so
# `set -u` aborts the whole script with "PORT<junk>: unbound variable" — right before the swap, meaning
# the build succeeds and the old server keeps serving. Silently.
echo "▶ swapping in the new build on :${PORT}…"
# Kill ONLY the server listening on $PORT — leaves any other Next instance alone (e.g. the live-reload
# dev server on :3001), which also runs as `next-server` and must not be swept up.
OLD_PIDS="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$OLD_PIDS" ]; then
  # SIGTERM first and actually WAIT for the process to go, rather than the old `kill; sleep 1`. That
  # fixed sleep raced the shutdown: a server still holding the port meant the new `npm start` lost the
  # bind and died on EADDRINUSE, leaving nothing serving at all.
  # shellcheck disable=SC2086
  kill $OLD_PIDS 2>/dev/null || true
  for _ in $(seq 1 20); do
    [ -z "$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)" ] && break
    sleep 0.5
  done
  LEFTOVER="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$LEFTOVER" ]; then
    echo "  … graceful stop timed out, forcing"
    # shellcheck disable=SC2086
    kill -9 $LEFTOVER 2>/dev/null || true
    sleep 1
  fi
fi

PORT="$PORT" nohup npm start >"$LOG" 2>&1 &

for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/" 2>/dev/null || true)
  [ "$code" = "200" ] && { echo "✓ live at http://localhost:$PORT  (logs: $LOG)"; exit 0; }
  sleep 1
done
echo "⚠ server didn't come up — check $LOG"; exit 1
