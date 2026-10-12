#!/usr/bin/env bash
# Install (or remove) the three launchd agents behind the Today page (§26).
#
#   bash bin/install-today.sh            # install / refresh all three
#   bash bin/install-today.sh --remove   # unload and delete them
#
#   com.thomas.minami-heartbeat   07:30 daily   ~/secondBrain/bin/morning-heartbeat.mjs builds today's plan
#   com.thomas.minami-morning     09:00 daily   bin/minami-open.sh morning → notification + open /today
#   com.thomas.minami-today-sync  every 10 min ~/secondBrain/bin/today-sync.mjs ticks to-dos the evidence shows done
#   com.thomas.minami-login       at login      bin/minami-open.sh login   → start dashboard if down, open /today
#
# A Mac asleep at 07:30 or 09:00 runs the job on wake (launchd's StartCalendarInterval rule). A Mac
# that was OFF skips it — the login agent catches that up by running the heartbeat if today has no plan.
set -euo pipefail
DASH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LA="$HOME/Library/LaunchAgents"
LOGS="$HOME/.minami"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
AGENTS=(com.thomas.minami-heartbeat com.thomas.minami-morning com.thomas.minami-login com.thomas.minami-today-sync)
uid="$(id -u)"

unload() { launchctl bootout "gui/$uid/$1" 2>/dev/null || true; }

if [ "${1:-}" = "--remove" ]; then
  for a in "${AGENTS[@]}"; do unload "$a"; rm -f "$LA/$a.plist"; echo "  removed $a"; done
  exit 0
fi

mkdir -p "$LA" "$LOGS"
plist() { # label, program args (xml), schedule (xml), log name
  # PATH matches minami-open.sh's (his login shell's, not launchd's bare one); $HOME expands here.
  cat > "$LA/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$2</array>
  $3
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:/Library/Frameworks/Python.framework/Versions/3.11/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>$LOGS/$4.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$4.log</string>
</dict></plist>
EOF
}

# AbandonProcessGroup is a backstop on the two open jobs only: minami-open.sh setsid-detaches what it
# starts anyway. The heartbeat job keeps launchd's group reap — that is what cleans up a timed-out claude.
plist com.thomas.minami-heartbeat \
  "<string>$NODE</string><string>$HOME/secondBrain/bin/morning-heartbeat.mjs</string>" \
  "<key>WorkingDirectory</key><string>$HOME/secondBrain</string><key>StartCalendarInterval</key><dict><key>Hour</key><integer>7</integer><key>Minute</key><integer>30</integer></dict>" \
  heartbeat
# Every 10 min: tick to-dos that today's evidence shows finished (chat turns, pipeline state, renders,
# commits). Cheap when idle — it skips the model call when nothing new happened since the last check.
plist com.thomas.minami-today-sync \
  "<string>$NODE</string><string>$HOME/secondBrain/bin/today-sync.mjs</string>" \
  "<key>WorkingDirectory</key><string>$HOME/secondBrain</string><key>StartInterval</key><integer>600</integer>" \
  today-sync
plist com.thomas.minami-morning \
  "<string>/bin/bash</string><string>$DASH/bin/minami-open.sh</string><string>morning</string>" \
  "<key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict><key>AbandonProcessGroup</key><true/>" \
  today-open
plist com.thomas.minami-login \
  "<string>/bin/bash</string><string>$DASH/bin/minami-open.sh</string><string>login</string>" \
  "<key>RunAtLoad</key><true/><key>AbandonProcessGroup</key><true/>" \
  today-open

for a in com.thomas.minami-heartbeat com.thomas.minami-morning com.thomas.minami-today-sync; do
  unload "$a"; launchctl bootstrap "gui/$uid" "$LA/$a.plist" && echo "  ✓ $a"
done
# The login agent is RunAtLoad: bootstrapping it now would open the page right away. Register it for
# the next login instead — launchd loads every plist in ~/Library/LaunchAgents at login by itself.
plutil -lint "$LA/com.thomas.minami-login.plist" >/dev/null && echo "  ✓ com.thomas.minami-login (takes effect at next login)"
echo "  logs: $LOGS/heartbeat.log · $LOGS/today-open.log"
