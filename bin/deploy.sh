#!/usr/bin/env bash
# Redeploy Minami Bento — the safe wrapper around bin/serve.sh.
#
# Why this exists on top of serve.sh: the thing that usually *asks* for a redeploy is a dashboard chat
# pane, and that pane's `claude` process is a grandchild of the very `next-server` that serve.sh has to
# kill. Running the swap inline from there kills the requesting turn mid-sentence — and serve.sh would
# rightly veto it anyway, since that turn counts as busy. So the deploy has to outlive its requester:
# detach into its own session, wait for the box to go quiet, *then* swap.
#
# Because the requester dies with the old server, it can never confirm the result itself. Everything
# after the swap is therefore written to a log and verified against things that cannot lie — a new PID
# and a new BUILD_ID — not "the script exited 0". A build can succeed while the swap silently leaves the
# old process serving; that exact bug is in KNOWLEDGE.md §8.
#
# Usage:
#   bash bin/deploy.sh                # wait for the box to go quiet, swap, verify
#   bash bin/deploy.sh --detach       # same, but return immediately (what an agent-in-a-pane must use)
#   bash bin/deploy.sh --now          # don't wait; serve.sh still vetoes if a turn is in flight
#   bash bin/deploy.sh --force        # swap even mid-turn (cuts off live conversations)
#   bash bin/deploy.sh --wait 600     # change the quiet-window ceiling (default 300s)
#   bash bin/deploy.sh --verify-only  # probe what's currently serving, change nothing
#
#   DEPLOY_PROBES="/api/fs/mkdir:400|405,/kb:200" bash bin/deploy.sh   # extra route assertions
#
# Log: ~/.minami/deploy.log (appended; every run stamps a header). Override with DEPLOY_LOG.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

PORT="${PORT:-3000}"
HEALTH="http://localhost:${PORT}/api/agent/health"
# NOT /tmp. A deploy is the one operation whose requester is dead before the outcome exists — this log
# is its only witness, and the bar for where a sole witness lives is higher than "conventional".
# macOS clears /tmp on boot: on 2026-07-29 a reboot took both this log and serve.sh's with it, while
# ~/.minami/events.jsonl (the bell's store) survived in the same instant. That's the evidence for
# putting the durable record next to the other durable record. Still overridable via DEPLOY_LOG.
LOG="${DEPLOY_LOG:-$HOME/.minami/deploy.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
WAIT_SECS=300
MODE=wait          # wait | now | verify
DETACH=0
FORCE=0
RUNNING_DETACHED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --detach|-d)   DETACH=1 ;;
    --now)         MODE=now ;;
    --force|-f)    FORCE=1; MODE=now ;;   # forcing implies you don't want to wait for quiet
    --verify-only) MODE=verify ;;
    --wait)        WAIT_SECS="${2:?--wait needs seconds}"; shift ;;
    --inline)      DETACH=0 ;;            # explicit opt-out of the auto-detach below
    --_detached)   RUNNING_DETACHED=1 ;;  # internal: set on the re-exec'd child
    -h|--help)     sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
  shift
done

TOKEN="$(cat "$ROOT/.minami-drain-token" 2>/dev/null || true)"

# The PID currently holding the port. Also the anchor for "am I running inside the thing I'm about to
# kill?" — see below.
server_pid() { lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1; }

# Walk our own ancestry looking for the server. A dashboard pane is next-server → claude → bash → us, so
# this is what distinguishes "Thomas double-clicked the .command in Terminal" from "an agent inside the
# dashboard asked for a deploy". The second case MUST detach or it kills its own requester.
inside_server() {
  local target="$1" pid=$$ i=0
  [ -z "$target" ] && return 1
  while [ "$pid" != "1" ] && [ -n "$pid" ] && [ "$i" -lt 30 ]; do
    [ "$pid" = "$target" ] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    i=$((i + 1))
  done
  return 1
}

# How many turns are in flight, per the running server. "" = no server, or a build too old to answer —
# both mean "nothing to protect".
busy_now() {
  [ -z "$TOKEN" ] && { echo ""; return; }
  curl -s --max-time 3 -H "x-minami-drain-token: ${TOKEN}" "$HEALTH" 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
print(d.get("busy","") if isinstance(d,dict) and "busy" in d else "")' 2>/dev/null || echo ""
}

busy_who() {
  [ -z "$TOKEN" ] && return
  curl -s --max-time 3 -H "x-minami-drain-token: ${TOKEN}" "$HEALTH" 2>/dev/null | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
for s in d.get("details",[]):
    if s.get("busy"): print("    - %s : %s" % (s.get("cwd","?"), s.get("label","working")))' 2>/dev/null || true
}

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:${PORT}$1" 2>/dev/null || echo ERR; }

# ---- detach --------------------------------------------------------------------------------------
# Auto-detach when we're a descendant of the server: an agent that just runs `bash bin/deploy.sh` from a
# pane gets the survivable behaviour without having to remember the flag. macOS ships no `setsid`, and a
# plain `&` leaves the child in our process group — reachable by a group kill — so fork through python3
# to get a genuinely new session with its own controlling terminal (none).
SRV_PID="$(server_pid)"
# Advisory pre-check, before the fork. The real lock is taken by the detached child, but by then the
# caller is gone and only the log hears the refusal — so an agent would be told "deploy running" for a
# deploy that immediately declined. Check here too, where someone is still listening.
if [ "$MODE" != "verify" ] && [ "$RUNNING_DETACHED" = "0" ] && [ -d "${DEPLOY_LOCK:-/tmp/minami-deploy.lock}" ]; then
  _h="$(cat "${DEPLOY_LOCK:-/tmp/minami-deploy.lock}/pid" 2>/dev/null || echo '?')"
  if [ "$_h" != "?" ] && kill -0 "$_h" 2>/dev/null; then
    echo "✋ a deploy is already running (pid $_h) — not starting another."
    echo "   tail -f $LOG"
    exit 3
  fi
fi
if [ "$RUNNING_DETACHED" = "0" ] && [ "$MODE" != "verify" ]; then
  if [ "$DETACH" = "1" ] || inside_server "$SRV_PID"; then
    if [ "$DETACH" != "1" ]; then
      echo "▸ this shell is a descendant of the :${PORT} server (pid ${SRV_PID}) — detaching so the"
      echo "  swap doesn't kill the process that asked for it."
    fi
    ARGS=(--_detached)
    [ "$MODE" = "now" ] && ARGS+=(--now)
    [ "$FORCE" = "1" ] && ARGS+=(--force)
    ARGS+=(--wait "$WAIT_SECS")
    python3 -c '
import os, sys
os.setsid()
log = open(sys.argv[1], "a")
devnull = os.open(os.devnull, os.O_RDONLY)
os.dup2(devnull, 0); os.dup2(log.fileno(), 1); os.dup2(log.fileno(), 2)
os.execv("/bin/bash", ["/bin/bash", sys.argv[2]] + sys.argv[3:])
' "$LOG" "$ROOT/bin/deploy.sh" "${ARGS[@]}" &
    disown 2>/dev/null || true
    echo "✓ deploy running detached — it will wait for the box to go quiet, then swap :${PORT}."
    echo "  log:    tail -f $LOG"
    echo "  verify: bash bin/deploy.sh --verify-only"
    exit 0
  fi
fi

# Attached runs mirror to the log so every deploy leaves the same trail. The detached child's stdout is
# ALREADY the log (the python re-exec dup2'd it there), so teeing it would write every line twice.
[ "$RUNNING_DETACHED" = "0" ] && exec > >(tee -a "$LOG") 2>&1
echo
echo "=== deploy $(date '+%F %T')  mode=$MODE force=$FORCE  $( [ "$RUNNING_DETACHED" = 1 ] && echo '(detached)' ) ==="
echo "    HEAD $(git rev-parse --short HEAD 2>/dev/null || echo '?')$( [ -n "$(git status --porcelain 2>/dev/null)" ] && echo ' +uncommitted')"

# ---- mutual exclusion ----------------------------------------------------------------------------
# There was none, and two agents in this repo request deploys independently. `next build` replaces
# .next IN PLACE under the running server, so two builds interleaving corrupt the very directory the
# live process is reading — and the second swap can leave a PID serving a build that no longer exists
# on disk. mkdir is the atomic primitive available everywhere (macOS ships no flock).
LOCK="${DEPLOY_LOCK:-/tmp/minami-deploy.lock}"
have_lock=0
if [ "$MODE" != "verify" ]; then
  if mkdir "$LOCK" 2>/dev/null; then
    have_lock=1
    echo $$ > "$LOCK/pid"
  else
    holder="$(cat "$LOCK/pid" 2>/dev/null || echo '?')"
    # A crashed deploy leaves the directory behind; a dead holder must not block every future one.
    if [ "$holder" = "?" ] || ! kill -0 "$holder" 2>/dev/null; then
      echo "▸ clearing stale deploy lock (holder $holder is gone)"
      rm -rf "$LOCK"
      mkdir "$LOCK" 2>/dev/null && { have_lock=1; echo $$ > "$LOCK/pid"; }
    fi
    if [ "$have_lock" = "0" ]; then
      echo "✋ another deploy is already running (pid $holder) — refusing to race it."
      echo "   Two builds interleaving corrupt .next under the live server. Wait for it, or check:"
      echo "     tail -f $LOG"
      exit 3
    fi
  fi
  # Release on ANY exit path, including the busy-veto and the kill that ends a forced swap.
  trap 'if [ "$have_lock" = "1" ]; then rm -rf "$LOCK"; fi' EXIT INT TERM
fi

# ---- alerting ------------------------------------------------------------------------------------
# The deploy is the one event that can never report itself back to whoever asked for it: the requester
# is a chat pane inside the server this script is about to kill. It used to end its life as a line in
# a log file that nobody was tailing. Now it also lands in the dashboard's bell, which the
# *new* server serves from disk — so the answer is waiting when the panes come back. See
# bin/minami-event.mjs for why this is a file and not an API call.
emit_event() { # kind level title  (body on stdin)
  node "$ROOT/bin/minami-event.mjs" "$1" "$2" "$3" 2>/dev/null || true
}

# verify() prints a table a human reads in the log; the same lines make the alert body, so they're
# captured as they're emitted rather than re-derived (two formatters would drift).
VERIFY_SUMMARY=""
vline() { printf '%s\n' "$1"; VERIFY_SUMMARY="${VERIFY_SUMMARY}${1#  }
"; }

# ---- verify-only ---------------------------------------------------------------------------------
verify() {
  local old_pid="$1" old_build="$2" rc=0
  local new_pid new_build
  new_pid="$(server_pid)"
  new_build="$(cat "$ROOT/.next/BUILD_ID" 2>/dev/null || echo '?')"
  VERIFY_SUMMARY=""

  echo "--- verifying what is actually serving ---"
  vline "$(printf '  %-22s %s' "server pid"  "${new_pid:-none}$( [ -n "$old_pid" ] && [ "$new_pid" = "$old_pid" ] && echo '   ← UNCHANGED' )")"
  vline "$(printf '  %-22s %s' "BUILD_ID"    "$new_build$( [ -n "$old_build" ] && [ "$new_build" = "$old_build" ] && echo '   (same as before — no code change compiled)' )")"

  # These two are the honest signals. A route probe only proves *a* server answers; a changed PID proves
  # the old process is gone, and a changed BUILD_ID proves the bytes on disk are new.
  if [ -z "$new_pid" ]; then
    vline "  ✗ nothing is listening on :${PORT}"; rc=1
  elif [ -n "$old_pid" ] && [ "$new_pid" = "$old_pid" ]; then
    vline "  ✗ same process as before the swap — the old build is still serving"; rc=1
  fi

  for spec in / /kb; do
    local code; code="$(http_code "$spec")"
    vline "$(printf '  %-22s -> %s' "GET $spec" "$code")"
    [ "$code" = "200" ] || rc=1
  done

  # Assertions for routes that only exist in the new build. Anything that is NOT a 404 proves the
  # route exists, which is the whole question here — a POST-only handler answers 400 or 405 to a GET
  # depending on whether it validates the body or rejects the method, and pinning one of the two made
  # a perfectly good deploy report failure. Accept a list: `want` may be `400|405`.
  #
  # The default lives HERE rather than in an exported env var, because a stale ambient
  # DEPLOY_PROBES="…mkdir:400" was doing exactly that on this box: every deploy since the route landed
  # reported "verification FAILED" while serving perfectly. A probe list is a fact about the repo's
  # routes, so it belongs with the repo and moves when they do. The env var still overrides for one-offs.
  local probes="${DEPLOY_PROBES:-/api/fs/mkdir:400|405,/api/agent/browser/file:400|405,/api/events:200}"
  if [ -n "$probes" ]; then
    IFS=',' read -ra specs <<< "$probes"
    for spec in "${specs[@]}"; do
      local path="${spec%%:*}" want="${spec##*:}" code ok=0
      code="$(http_code "$path")"
      IFS='|' read -ra alts <<< "$want"
      for a in "${alts[@]}"; do [ "$code" = "$a" ] && ok=1; done
      vline "$(printf '  %-22s -> %s (want %s)%s' "GET $path" "$code" "$want" "$( [ "$ok" = "1" ] || echo '  ✗' )")"
      [ "$ok" = "1" ] || rc=1
    done
  fi

  if [ "$rc" != "0" ]; then echo "  ✗ verification FAILED"
  elif [ -n "$old_pid" ]; then echo "  ✓ new build is live on http://localhost:${PORT}"
  else echo "  ✓ server on :${PORT} is answering"; fi
  return $rc
}

if [ "$MODE" = "verify" ]; then verify "" ""; exit $?; fi

# ---- wait for quiet ------------------------------------------------------------------------------
# Not --force: waiting is how a deploy stays polite to *other* panes. serve.sh's own veto still runs
# after this, so a turn that starts during the build is still respected.
if [ "$MODE" = "wait" ]; then
  waited=0
  while :; do
    b="$(busy_now)"
    if [ -z "$b" ]; then echo "▸ no server / no health endpoint — proceeding"; break; fi
    if [ "$b" = "0" ]; then echo "▸ box quiet after ${waited}s — swapping"; break; fi
    if [ "$waited" -ge "$WAIT_SECS" ]; then
      echo "✋ still busy (${b} turn(s)) after ${WAIT_SECS}s — aborting. Nothing was touched:"
      busy_who
      echo "   Re-run when quiet, or force the swap: bash bin/deploy.sh --force"
      # Worth alerting on: an abort leaves the box serving the OLD build, and the pane that asked is
      # long gone. Silence here reads exactly like success.
      printf '%s turn(s) still in flight after %ss — nothing was swapped, the old build is still live.\n\n%s\n' \
        "$b" "$WAIT_SECS" "$(busy_who 2>/dev/null)" \
        | emit_event deploy warn "Deploy aborted — box still busy"
      exit 1
    fi
    [ "$waited" = "0" ] && { echo "▸ ${b} turn(s) in flight — waiting up to ${WAIT_SECS}s for quiet:"; busy_who; }
    sleep 2; waited=$((waited + 2))
  done
  # Small grace so the finished turn's result reaches its JSONL — that file is what each pane reconciles
  # against when it reconnects to the new build, so a turn that lands here survives the restart visibly.
  sleep 3
fi

# ---- swap ----------------------------------------------------------------------------------------
OLD_PID="$(server_pid)"
OLD_BUILD="$(cat "$ROOT/.next/BUILD_ID" 2>/dev/null || echo '')"
echo "▸ old server pid=${OLD_PID:-none} build=${OLD_BUILD:-none}"

if [ "$FORCE" = "1" ]; then bash bin/serve.sh --force; else bash bin/serve.sh; fi
rc=$?
echo "=== serve.sh exit ${rc} at $(date '+%F %T') ==="
if [ "$rc" != "0" ]; then
  echo "✗ build/swap failed — see above and ${PROD_LOG:-$HOME/.minami/prod.log}"
  # The build tail is the only part anyone actually wants; the alert carries it so a compile error
  # doesn't require going and finding two log files.
  printf 'serve.sh exited %s. Last lines:\n\n%s\n' "$rc" "$(tail -n 12 "${PROD_LOG:-$HOME/.minami/prod.log}" 2>/dev/null)" \
    | emit_event deploy error "Deploy failed — build or swap"
  exit $rc
fi

sleep 2
verify "$OLD_PID" "$OLD_BUILD"
vrc=$?
# Success and failure both alert. A deploy that quietly leaves the old process serving is the exact
# failure this script exists to catch (KNOWLEDGE.md §8) — it must not also be the quiet one.
if [ "$vrc" = "0" ]; then
  printf '%s' "$VERIFY_SUMMARY" | emit_event deploy success "Deploy live on :${PORT}"
else
  printf '%s' "$VERIFY_SUMMARY" | emit_event deploy error "Deploy verification FAILED"
fi
echo "=== deploy done $(date '+%F %T') rc=${vrc} ==="
exit $vrc
