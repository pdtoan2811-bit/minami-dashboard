#!/usr/bin/env bash
# Double-click this in Finder to push your latest edits to the live dashboard on :3000.
#
# Why a .command and not "just run serve.sh": this Terminal window is NOT a child of the Next server,
# so the swap can't kill the thing driving it. That's the opposite of asking a dashboard chat pane to
# redeploy — there, the requester dies with the server (bin/deploy.sh detects that and detaches).
#
# It builds, then replaces the running server. Every live chat session on the box is a child of that
# server, so anything mid-turn gets interrupted — which is why this asks first when the box is busy.
cd "$(dirname "$0")" || exit 1

printf '\033]0;Redeploy Minami\007'   # window title, so it's findable in a pile of Terminal tabs
echo "▸ Minami Bento — redeploy to http://localhost:3000"
echo "  $(pwd)"
echo "  HEAD $(git rev-parse --short HEAD 2>/dev/null || echo '?') $(git log -1 --format=%s 2>/dev/null | cut -c1-60)"
echo

TOKEN="$(cat .minami-drain-token 2>/dev/null || true)"

# One request, two answers: the count on stdout, the who-is-busy lines on stderr. Asking twice would be
# a race — a turn can start or end between the calls, and then the prompt below names the wrong sessions.
HEALTH_JSON=""
[ -n "$TOKEN" ] && HEALTH_JSON="$(curl -s --max-time 3 -H "x-minami-drain-token: ${TOKEN}" \
  http://localhost:3000/api/agent/health 2>/dev/null || true)"

read_busy() {
  printf '%s' "$HEALTH_JSON" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
if not isinstance(d,dict) or "busy" not in d: raise SystemExit
print(d.get("busy",""))
for s in d.get("details",[]):
    if s.get("busy"):
        print("     - %s : %s" % (s.get("cwd","?"), s.get("label","working")), file=sys.stderr)' 2>"$WHO_FILE"
}

WHO_FILE="$(mktemp -t minami-busy)"
trap 'rm -f "$WHO_FILE"' EXIT
BUSY="$(read_busy)"

ARGS=(--now)
if [ -n "$BUSY" ] && [ "$BUSY" != "0" ]; then
  echo "⚠  ${BUSY} chat turn(s) are running right now. Swapping the server cuts them off mid-sentence."
  cat "$WHO_FILE"
  echo
  echo "   [w] wait for them to finish, then deploy   (default)"
  echo "   [f] deploy now and cut them off"
  echo "   [q] quit, change nothing"
  printf '   > '
  read -r choice
  case "${choice:-w}" in
    f|F) ARGS=(--force) ;;
    q|Q) echo "cancelled — nothing was touched."; exit 0 ;;
    *)   ARGS=(--wait 900) ;;   # generous: a long turn shouldn't force a re-run
  esac
  echo
fi

bash bin/deploy.sh "${ARGS[@]}"
rc=$?

echo
if [ "$rc" = "0" ]; then
  echo "✓ done — reload http://localhost:3000"
else
  echo "✗ deploy failed (exit $rc). Full log: /tmp/minami-deploy.log · build log: /tmp/minami-prod.log"
fi
echo
printf 'Press return to close this window. '
read -r _
