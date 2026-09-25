# Overnight runs — keeping a dashboard session working while you sleep

Written 2026-09-25 from the two ecvision sessions that died on the night of 2026-09-24. Both deaths
were the dashboard's idle reaper, fixed the same day (post-mortem: `docs/knowledge/03-live-sessions.md`
§3, "Memory"). This file covers everything the fix does not: the machine, the brief, and recovery.

## What actually kills an unattended session

| Cause | Seen | Status |
|---|---|---|
| Idle reaper closed a session mid self-started turn, or with background agents out | 2026-09-25 02:27 and 01:18 | **fixed** (reaper + `busy` + deploy veto) |
| Machine sleeping → DNS fails → API retries for ~70 min, then the turn ends on `API Error` | 2026-09-24 afternoon, 17:47–18:56 | machine setup, below |
| Memory pressure: 16 GB, swap at 12 GB by 22:28, load 14 | 2026-09-24 evening | machine setup + brief rules, below |
| A dashboard redeploy (autopilot, or another pane) restarts `next-server` | not last night | agent fleets now hold the deploy veto; switch autopilot deploy off anyway |
| The `claude` process itself OOM-killed or crashing | not last night | not prevented — the brief makes it resumable |

A session that dies does **not** recover on its own. The CLI's resume sentinel (`Continue from where
you left off.` → `No response requested.`) does nothing. The work only continues when someone sends it a
real message, so the brief below is written to make that one message enough.

## Before bed — the machine (2 min)

1. **Plug in.** The box was on battery this morning (2h36 left). Amphetamine keeps it awake only as
   long as there is power.
2. **Amphetamine on, lid open.** `pmset -g` should say `sleep prevented by Amphetamine`.
3. **Free memory.** Stop dev servers, Docker stacks and old worktrees you won't need tonight. Last
   night's cleanup took swap from 12.1 GB to 8.4 GB. Check with `sysctl vm.swapusage`. Aim for under
   6 GB used before starting.
4. **No dashboard deploys overnight.** Set `"deploy": false` in `~/.minami/autopilot.json` and don't
   ship dashboard changes from other panes. Merges can stay on.
5. **One overnight session per repo.** Two orchestrators each running their own gates on one Postgres
   made every suite 3× slower and made tests flaky (the task-04 lock test).

## The brief — paste this, filled in

```
NIGHT SHIFT — run unattended until done. I'm asleep; nobody will answer questions.

Goal: <one sentence of what "done" looks like>
Plan file: <repo>/docs/night/<date>.md  — create it first, before any other work:
  - a numbered checklist of steps, each small enough to commit on its own
  - "## Progress" — append one line per step: time, what landed, commit sha
  - "## Decisions" — every judgement call you'd normally ask me, with what you chose and why
  - "## Blocked" — anything you genuinely cannot do; skip it and move on

Rules:
1. Never stop to ask. Decide, log it under Decisions, keep going.
2. Commit after every step and tick it in the plan file. The plan file is the only memory that
   survives a crash — write it as if the next reader has never seen this conversation.
3. One heavy job at a time on this machine: one test suite, one build, one browser capture. Check
   `uptime` and `sysctl vm.swapusage` before starting one; if load > 10 or swap > 10 GB, wait.
4. Waiting on work: run it as a background agent or background shell and end your turn — you will be
   woken when it finishes. Don't sleep-loop in the foreground, and don't rely on ScheduleWakeup /
   Monitor alone for waits over 25 minutes.
5. Subagents get a self-contained brief and a file list that doesn't overlap with any other agent's.
6. When everything is done or blocked: write "## Morning summary" at the top of the plan file
   (what's done, what's blocked, what I need to decide, how to see it), then reply NIGHT-SHIFT-DONE.
```

## If it died anyway — the one message that resumes it

Don't send "continue". That's what gets the empty `No response requested.` reply. Send:

```
You were killed mid-run. Resume the night shift from <plan file>: read Progress and Decisions,
check git log and git status to verify the last step really landed, then carry on with the
next unticked step under the same rules.
```

## Checking on it from bed (optional)

The pane's status line counts background agents as work in progress, so "tool" with a fleet means
alive. If the last transcript line is a `tool_result` with nothing after it for more than a few minutes,
it has died: send the resume message above.
