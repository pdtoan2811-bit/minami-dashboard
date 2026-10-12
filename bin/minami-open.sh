#!/usr/bin/env bash
# Open the Today page (§26) — at login and again at 09:00, both via launchd (bin/install-today.sh).
#
#   bash bin/minami-open.sh login     # after a reboot: start the dashboard if it's down, make sure
#                                     # today has a plan, then open /today
#   bash bin/minami-open.sh morning   # 09:00: notify with the headline, then open /today
#
# Starting the server is only ever done when NOTHING answers on :3000. A running server is never
# restarted from here — that would cut every live chat (see serve.sh's drain notes, §8).
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
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

if ! wait_up 30; then
  if pgrep -f "next-server|next start" >/dev/null; then
    say "a next server exists but isn't answering yet — waiting, not restarting"
  else
    say "dashboard is down — starting it (bin/serve.sh)"
    ( cd "$DASH" && nohup bash bin/serve.sh >> "$HOME/.minami/serve-at-login.log" 2>&1 & )
  fi
  wait_up 420 || { say "dashboard did not come up in 7 min — see ~/.minami/serve-at-login.log"; exit 1; }
fi

# Powered off at 07:30 means launchd never ran the heartbeat. Catch up at login.
if [ "$MODE" = "login" ] && [ ! -f "$DAY" ] && [ "$(date +%H%M)" -ge 0600 ]; then
  say "no plan for today yet — running the heartbeat now"
  ( cd "$HOME/secondBrain" && nohup node bin/morning-heartbeat.mjs >> "$HOME/.minami/heartbeat.log" 2>&1 & )
fi

if [ "$MODE" = "morning" ]; then
  HEAD=$(python3 -c "import json,sys;d=json.load(open(sys.argv[1]));print(d.get('headline') or 'Your plan is ready.')" "$DAY" 2>/dev/null || echo "Your plan for today is ready.")
  osascript -e "display notification $(printf '%s' "$HEAD" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()[:220]))') with title \"Minami — Today\"" 2>/dev/null || true
fi

open "$URL"
say "opened $URL"
