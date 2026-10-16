# §29 Goals — `/goals`

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

The page for **autonomous goals**: a target an agent works on by itself every morning, with its permissions
written down (vault note *Autonomous Goal Spec*). The first one, 2026-10-15: *ecvision.ai ranks #1 on Google
for "ecvision" and "ecvision ai" by 2026-11-12* (note *Ecvision Brand Number One*).

## Mechanics

- **The dashboard does not run goals.** The runner is a vault tool, `~/secondBrain/70-79 Toolshed/tools/goals/goal.mjs`,
  fired by launchd `com.thomas.goal-runner` at 06:45. Each run: measure (Google SERP through the harness browser on
  CDP :9333, Search Console through ecvision's `scripts/seo/seo.py`) → decide (Claude sonnet, quarantined) → act
  within the goal's levers → write Thomas's part to `~/.minami/goals/<id>/today.json` → append one line to
  `~/.minami/goals/<id>/log.jsonl`.
- **Today gets the to-dos through the heartbeat, not through this page.** `morning-heartbeat.mjs` (07:30) adds every
  goal's `today.json` to the day's plan after its model step (`withGoals()`), verbatim, with a `goal` field on each
  item. That is why the runner runs at 06:45, and why a manual run after 07:30 only reaches Today on a Rebuild.
- `lib/goals.ts` **only reads**: the ```json goal block of each `10-19 Projects/*.md` note, the log, `today.json`,
  today's day file (for the ticks, matched on the to-do's text), and `launchctl print` for the runner's state.
  The one write is `POST /api/goals {op:"run"}` → `launchctl kickstart` — the job runs `--all`, there is no
  per-goal job.
- Paths follow the house rule: `SECOND_BRAIN_DIR` (default `~/secondBrain`), `MINAMI_GOALS_DIR` (default
  `~/.minami/goals`).

## Inside /autopilot (§30, 2026-10-16)

`/goals` now redirects to `/autopilot`. The page became `GoalsSection` in `app/autopilot/GoalsSection.tsx`
and sits first on that page, above the Runners (§27). Why: a goal is the outcome and the automations are
the runners. Each card shows the same content as before, plus a **Worked on by** list: the goal runner
(it serves every goal) plus any automation whose `project` matches the goal's `note`. The comparison
uses `projectKey`/`matchesProject`, a one-way prefix match: an `ecvision` goal claims `ecvisionContent`
jobs, but not the other way round. Each row links to `#auto-<id>` in Runners.

- Each card has `id="goal-<spec.id>"`, which the shell's "Needs you" drawer targets. The page renders
  only after both fetches arrive, so `Autopilot.tsx` re-runs the hash jump once both feeds are in. The
  browser's own jump fires on an empty page.
- The shell's project filter hides goals whose note doesn't match and prints "Filtered to <pf> · N
  hidden", so an empty page reads as filtered and not as broken.

## Gotchas

- **A failed check is not a result.** A position is a number, `null` (Google showed results and we weren't among
  them — "not on page 1") or `"no reading"` (captcha, browser down, layout changed). The page hatches "no reading"
  and never colours it; the runner never guesses. Keep the three apart in any new view — a guessed position in
  the log poisons every later decision the runner makes from it.
- **The note is the source of truth for the spec.** An invalid JSON block is skipped (the other goals still show),
  so a goal that disappears from the page after an edit means the block doesn't parse — `node goal.mjs list` says
  which file.
- The tick on "Your part today" is matched on the exact to-do text. If the heartbeat ever starts rewording goal
  to-dos, the ticks stop showing here while Today still has them.
- The `seo-pr` lever stays off until ecvision's path-guard workflow (`seo-auto-guard.yml`, PR #319) is on
  `develop`; the runner checks `origin/develop` for the file on every run.
