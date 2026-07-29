#!/usr/bin/env bash
# Where am I, who else is here, what is locked, and is anything stuck?
#
# Every collision in this repo so far was discovered by accident — a file changing under an open
# editor, a lock refusing a command, a deploy timing out after fifteen minutes. All of them were one
# command away from being known up front. That command is this one.
#
# Read-only. Safe to run at any time, from any tree, with the dashboard up or down.
set -uo pipefail
R="$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")"

echo "── position ──────────────────────────────────────────────"
echo "  tree    $R"
case "$R" in
  *.minami-worktrees/*) echo "  kind    TASK WORKTREE — isolated; edit freely, nobody else is in here" ;;
  *)                    echo "  kind    BASE CHECKOUT — shared; every session listed below edits these same files" ;;
esac
echo "  branch  $(git -C "$R" branch --show-current 2>/dev/null)   dirty: $(git -C "$R" status --porcelain 2>/dev/null | wc -l | tr -d ' ') file(s)"

echo "── locks ─────────────────────────────────────────────────"
for L in /tmp/minami-deploy.lock /tmp/minami-merge.lock; do
  if [ -d "$L" ]; then
    h="$(cat "$L/pid" 2>/dev/null || echo '?')"
    # A crashed holder leaves the directory behind. Both tools self-heal on the next run, but say so
    # here rather than letting a dead lock read as a live one.
    if kill -0 "$h" 2>/dev/null; then echo "  HELD  $(basename "$L")  pid $h (alive)"
    else echo "  stale $(basename "$L")  pid $h is gone — the next run clears it automatically"; fi
  else
    echo "  free  $(basename "$L")"
  fi
done

echo "── live sessions ─────────────────────────────────────────"
R="$R" curl -s --max-time 3 "http://localhost:3000/api/agent/live" 2>/dev/null | R="$R" python3 -c '
import json, sys, os
R = os.environ["R"]
try:
    a = json.load(sys.stdin).get("activity", {})
except Exception:
    print("  dashboard not answering — you cannot see other agents.")
    print("  Assume you are NOT alone: work in a worktree, and do not deploy blind.")
    raise SystemExit
here    = [(k, v) for k, v in a.items() if v.get("cwd") == R]
busy    = [k for k, v in a.items() if v.get("busy")]
# phase is the authoritative field. The human-readable label is a rendering of it and must never be
# substring-matched — that is how a "thinking…" pane got reported as blocked.
blocked = [(k, v) for k, v in a.items() if v.get("phase") == "awaiting"]

print(f"  {len(here)} in THIS tree · {len(busy)} busy · {len(a)} total on the box")
for k, v in here:
    ph = v.get("phase", "?")
    print(f"    {k[:8]}  {ph}")
if len(here) > 1:
    print("  → you are sharing a checkout. Isolate before editing: node bin/task.mjs new <name>")
if blocked:
    print(f"  {len(blocked)} BLOCKED on a human (phase=awaiting) — these never clear on their own:")
    for k, v in blocked:
        cw = v.get("cwd", "?")
        print(f"    {k[:8]}  {cw}")
    print("  → a deploy would wait its whole window and abort. Clear these FIRST.")
    print("     Quiet is box-wide, not repo-wide: the restart kills every pane on the machine,")
    print("     so a stuck pane in an unrelated folder starves this deploy too.")
elif not busy:
    print("  → box is quiet. This is the moment to deploy.")
'
