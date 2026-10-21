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
- The `seo-pr` lever needs ecvision's path-guard workflow (`seo-auto-guard.yml`) on `develop` (merged as PR #319); the
  runner checks `origin/develop` for it on every run. The agent only edits; the runner runs every gate itself.

## List + run ledger, and "Resolve with Minami" (2026-10-16)

The card was redrawn from the `goals-console` pitch (version V1, Thomas's pick). The old card answered "where
does it stand?" but not "is it working?". It had no run history in one place, no outcome per action and no
cost. The runner's own failures also read the same as the goal being behind: on Oct 16 the path guard refused
every SEO PR because `goal.mjs` called it the old way (fixed in the vault the same day).

**What the card shows now:**
- **A list of goals** beside the selected one. Goals with a runner issue come first, then goals that are behind.
  The selection follows `#goal-<id>`, which is what the shell's drawer links to.
- **Four numbers:** best position, pages indexed, days left, and money spent (the sum of `usd` over the log).
- **The runner's health** (`health()`), on its own line and judged separately from the goal's status. From
  worst to best:
  - not loaded in launchd
  - a refused or failed action in the last run
  - a non-zero exit code
  - no run in 30 hours (a missed day)
  - healthy
- **A ledger** with one row per run: positions, indexed pages, each action with an outcome chip, and cost. The
  chip comes from `outcome()`:
  - Refused or Failed when the action has `refused_by_guard` or `error`
  - Merged, Waiting or Opened for PRs
  - Skipped when the action has `skipped`
  - Queued when it has `queued`
  - Done when it has `note` (a draft)
- **Your part** as a checklist with minute estimates. It's ticked on Today, where the heartbeat copied it.
- **"Page 1 today · runners · rules"**, folded away at the bottom.

**Resolve with Minami** sends `POST /api/goals {op:"resolve", id}`. That calls `resolveGoal()`, which starts a
chat in the vault and opens it.
- **What the chat gets** (`resolveContext()`): the spec, the last 6 runs with each action's outcome, the
  runner's state and log paths, and Thomas's part.
- **What it's told, in order:** fix broken machinery first, then unblock stuck actions, then do or prepare his
  part.
- **What it's told not to do:** kickstart the runner without asking (a run costs money and can open PRs), break
  the never-list, or post as Thomas.
- **One chat per goal per day** (key `goal:resolve:<id>:<date>`). A second click sends fresh context into the
  same conversation instead of starting a parallel one.
- **`request-indexing` actions come one per page** (`url`, `result`: requested · already indexed · quota · timeout ·
  rejected). The runner clicks Search Console's *Request indexing* in the harness browser as thomas@ecvision.ai
  (`gsc-request.mjs`, ≤10 a day, never the same page within 7 days). The ledger shows each as its own row; a
  `quota` row is amber, not red — it is Google's daily cap, not a failure.

## On a phone: the Live Activity view (2026-10-20)

Below the compact breakpoint (`useCompact`), `/autopilot` renders `app/autopilot/PhoneAutopilot.tsx` instead of
the stacked goal and runner cards, which made the page 8,918px tall on a 393px phone. Thomas picked it from the
`autopilot-phone` pitch (round 4, `~/ecvision/pitches/autopilot-phone`) after three rounds that didn't read;
the moodboard there carries the references. Desktop is unchanged.

- **Sizes change by tapping the thing, like an iPhone Live Activity.** A goal is a *line* (verdict + one
  number), a *card* (verdict, four tiles, your part, questions) or *full screen* (one metric, day by day).
  The most urgent goal starts as a card, the rest as lines. Tapping the card's header shrinks it back.
  Round 3 tried separate "–"/"⤢" buttons and a Hidden tray; Thomas found them unintuitive, because they were
  controls you had to learn.
- **Every block says its verdict in words first** (`verdict()`): *On target* · *Ranking #N* · *Not ranking yet*
  for a position goal, *On track* / *Behind* otherwise. The page opens with a sentence ("1 goal behind, 1 runner
  failed. 13 fine."). The goal runner's own trouble (a failed action, not loaded, a missed day) is a separate
  amber line, because "behind" and "broken" are different news (as on desktop).
- **Metrics, one point per day** (`days()`): a day's point is its *last* run and its spend is the sum of its
  runs. Every calendar day from the first run to today appears, so a day with no run shows "–" instead of
  vanishing. The Rank tile and chart use the latest *real* reading: a captcha day ("no reading") doesn't erase
  what was last known, and it's drawn as "?", never as a result. The rank chart follows the SEO convention: #1
  on top, a log scale, bands for top 3 / 10 / depth, a red floor band for "not in the top N", and the target as
  a dashed line. N is the run's `depth` (50 since 2026-10-19; older runs read page 1 only, so 10).
- **Runners: a failed one is a card, the rest one sentence.** "✓ 13 others running fine ›" opens to one row
  each; a row grows in place to its description, schedule, last line, Run now / Pause. Protected runners ask
  before pausing.
- **Ask → chat, as Today's hand-off.** Questions written for the card sit on it. A tap POSTs
  `/api/autopilot/ask` (`lib/autopilot-ask.ts`), which starts a chat with the goal's `resolveContext` or the
  runner's description, schedule, status and last 40 log lines. A goal's chat runs in the vault; a runner's
  runs in its `workdir`, so that project's CLAUDE.md loads. Each ask is appended to
  `~/.minami/autopilot-asks.jsonl`: that file is the only link from a card to its chats. The card lists its
  last three with Today's live state (working · needs you · ready). Not to be confused with `/api/autopilot`,
  the worktree-merge switch (§9).

## Rank, day by day — one chart for desktop and phone (2026-10-21)

Asked for because the card said "Not in top 46" in a stat tile and down the ledger, and 46 read as a rank
("goal is top 1, the actual is 46 of some sort"). It is the **depth**: how many results that morning's check read
before giving up. `app/autopilot/RankChart.tsx` draws a position goal so that confusion can't happen:

- **Rank zone:** #1 at the top, log scale, bands for Top 3, Page 1 and Pages 2–5, the goal as a green dashed line.
- **"Not found" lane:** the check worked and the site wasn't there. Hollow dot per search; the newest day says
  how deep it read ("read top 46–49"). A not-found is never plotted on the rank axis.
- **"Check failed" lane:** a captcha or timeout, one "?" per day.
- **x axis runs to the deadline.** The days still to go are shaded with "22 days left → Nov 12". Days with data
  get at least 62% of the width, so a week of history isn't squeezed into a corner beside three empty weeks.
- Hover a day (desktop) for that day's readings in words. Both searches share one chart, one colour each.

Above it, `rankSentence()` says where it stands in one line. The words changed with it: the stat tile is "Rank on
Google · Not found · goal #1 · checked top 46–49", the ledger says "Not found (top 46)" and "Check failed", and
the phone says "Not found → goal #1" instead of ">46". `days()` moved here from `PhoneAutopilot.tsx`; the phone's
Rank screen renders the same chart (`compact`).
