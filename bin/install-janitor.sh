#!/usr/bin/env bash
# Install (or remove) the nightly storage janitor (§32).
#
#   bash bin/install-janitor.sh            # install / refresh
#   bash bin/install-janitor.sh --remove   # unload and delete it
#
#   com.thomas.minami-janitor   00:15 daily   bin/janitor.mjs --why nightly   tiers 1–2, then the day's disk sample
#
# Why 00:15: before the video overnight runner starts rendering after the 00:30 lock, so the renders find the
# space the janitor just made instead of failing "need 6 GB" (they did, 2026-10-2x). A Mac asleep at 00:15
# runs it on wake — StartCalendarInterval catches up, StartInterval would not.
#
# This job is the half of the janitor that doesn't need the dashboard: the autopilot tick only adds the
# watermark trigger and the dead-man's switch, and the server restarts on every deploy.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Always the MAIN checkout: installed from a worktree, the plist would otherwise point at a folder the janitor
# itself may later recycle.
DASH="$(dirname "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)")"
LA="$HOME/Library/LaunchAgents"
LOGS="$HOME/.minami"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
ID=com.thomas.minami-janitor
uid="$(id -u)"

launchctl bootout "gui/$uid/$ID" 2>/dev/null || true
if [ "${1:-}" = "--remove" ]; then rm -f "$LA/$ID.plist"; echo "  removed $ID"; exit 0; fi

mkdir -p "$LA" "$LOGS"
# Through minami-run, like the other jobs, so /autopilot's Runners tab gets its run history and last line.
RUN="$HOME/.minami/bin/minami-run"
if [ -x "$RUN" ]; then PROG="<string>$RUN</string><string>$ID</string><string>--</string>"; else PROG=""; fi
cat > "$LA/$ID.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$ID</string>
  <key>ProgramArguments</key><array>$PROG<string>$NODE</string><string>$DASH/bin/janitor.mjs</string><string>--why</string><string>nightly</string></array>
  <key>WorkingDirectory</key><string>$DASH</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>0</integer><key>Minute</key><integer>15</integer></dict>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StandardOutPath</key><string>$LOGS/janitor.log</string>
  <key>StandardErrorPath</key><string>$LOGS/janitor.log</string>
</dict></plist>
EOF
plutil -lint "$LA/$ID.plist" >/dev/null
launchctl bootstrap "gui/$uid" "$LA/$ID.plist" && echo "  ✓ $ID (00:15 nightly) → $DASH/bin/janitor.mjs · log $LOGS/janitor.log"
