#!/usr/bin/env bash
# Open the Today page (§26) — at login and again at 09:00, both via launchd (bin/install-today.sh).
#
#   bash bin/minami-open.sh login     # after a reboot: start the dashboard if it's down, make sure
#                                     # today has a plan, then open /today
#   bash bin/minami-open.sh morning   # 09:00: notify with the headline, then open /today
#
# Starting the server is only ever done when NOTHING answers on :3000. A running server is never
# restarted from here — that would cut every live chat (see serve.sh's drain notes, §8).
# And login never BUILDS when a build is on disk: the working tree is the dashboard editing itself, so
# it may hold half-done code — `next build` clears .next first, and one compile error would leave
# nothing serving all day. It starts the last good build instead; serve.sh only runs when there is none.
set -uo pipefail
# The server started here hosts every chat, and chats inherit its env: it needs the PATH his login shell
# gives (~/.zprofile: tools/models/tok in ~/.local/bin, Python 3.11), not launchd's bare one. Prepended
# here rather than `zsh -lc`, because .zprofile re-exports NODE_ENV/PORT and the unset below must win.
export PATH="$HOME/.local/bin:/Library/Frameworks/Python.framework/Versions/3.11/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
unset NODE_ENV PORT   # his shell exports both; either one breaks the server in silent ways

MODE="${1:-login}"
DASH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="http://localhost:3000/today"
DAY="$HOME/.minami/today/$(date +%F).json"
say() { echo "[$(date '+%F %T')] $MODE: $*"; }

up() { curl -s -o /dev/null --max-time 5 -w "%{http_code}" http://localhost:3000/ | grep -q "^[23]"; }

wait_up() { # seconds
  local n=$(( $1 / 3 ))
  for _ in $(seq 1 "$n"); do up && return 0; sleep 3; done
  return 1
}

# launchd kills this job's whole process group when the script exits, and a `nohup … &` from a
# non-interactive bash stays in that group. Anything started here must get its own session, or the
# dashboard (and a catch-up heartbeat) die the moment `open` returns. /usr/bin/perl ships with macOS.
detach() { perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV' "$@"; }

# The first 30 s also give the network time to come up after boot — the catch-up heartbeat below
# needs it for the model step, so it must stay after this wait.
STARTED=0
if ! wait_up 30; then
  # Ask the port, not pgrep: `pgrep -f next-server` also matches every worktree and side dev server on
  # the box (five on 2026-10-12), which made a dead :3000 look "starting" and never got restarted.
  if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
    say "a next server exists but isn't answering yet — waiting, not restarting"
  elif [ -f "$DASH/.next/BUILD_ID" ]; then
    # Next writes BUILD_ID last, so its presence means a complete build. PORT is explicit because it
    # was unset above.
    say "dashboard is down — starting the last build (npm start)"
    ( cd "$DASH" && PORT=3000 detach nohup npm start >> "$HOME/.minami/prod.log" 2>&1 & )
  else
    say "no build on disk — building (bin/serve.sh)"
    ( cd "$DASH" && detach nohup bash bin/serve.sh >> "$HOME/.minami/serve-at-login.log" 2>&1 & )
  fi
  STARTED=1
fi

# Powered off at 07:30 means launchd never ran the heartbeat. Catch up at login — but only after 07:30:
# on an earlier boot launchd's own 07:30 job builds the plan, and running both would overlap.
# Runs before the long server wait so a broken build doesn't also cost him the day's plan.
# "No plan" means no built_at, not no file: an edit on the page (or a carried to-do) creates the file
# without a plan, and checking existence alone then skipped the catch-up for the whole day.
planned() { [ -f "$DAY" ] && python3 -c "import json,sys;sys.exit(0 if json.load(open(sys.argv[1])).get('built_at') or json.load(open(sys.argv[1])).get('status')=='running' else 1)" "$DAY" 2>/dev/null; }
if [ "$MODE" = "login" ] && ! planned && [ "$(date +%H%M)" -ge 0730 ]; then
  say "no plan for today yet — running the heartbeat now"
  ( cd "$HOME/secondBrain" && detach nohup node bin/morning-heartbeat.mjs >> "$HOME/.minami/heartbeat.log" 2>&1 & )
fi

if [ "$STARTED" = 1 ]; then
  wait_up 420 || { say "dashboard did not come up in 7 min — see ~/.minami/prod.log or serve-at-login.log"; exit 1; }
fi

if [ "$MODE" = "morning" ]; then
  HEAD=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('headline') or 'Your plan is ready.')" "$DAY" 2>/dev/null || echo "Your plan for today is ready.")
  # Text goes in as argv, not spliced into AppleScript source: an escaped em dash is a syntax error there.
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Minami — Today"' -e 'end run' "${HEAD:0:220}" 2>/dev/null || true
fi

open "$URL"
say "opened $URL"
