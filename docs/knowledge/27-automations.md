# §27 — Automations

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

`/automations`: one page that lists everything running on this Mac without being asked, with run · pause ·
resume · edit · create · delete · restore. Built 2026-10-14 after Thomas asked for "a place to handle, list
all autonomous things like these and CRUD, pause etc". The number of unattended jobs had grown to nine,
across three repos and launchd, with no single place to see them. The video pipeline (vault
`Video Studio`) is about to add more.

Files: `app/automations/{page,Automations}.tsx`, `app/api/automations/route.ts`, `lib/automations.ts`.
The one consumer outside the repo is `~/Minami/src/videoPlan.js`, which checks the pause flag.

## Mechanics

- **launchd is the source of truth, not a registry.** Every `~/Library/LaunchAgents/com.thomas.*.plist`
  is read on each request (`plutil -convert json`), so a job installed by hand or by another script shows
  up with nothing to register. The schedule, command, log path and state (`launchctl print`) come from
  launchd. Only the human name, the description and the project are stored separately, in
  `~/.minami/automations/meta.json`. The `KNOWN` table in the lib seeds names for the existing jobs.
- **Pause = `launchctl disable` + `bootout`.** `bootout` alone comes back at the next login. `disable`
  is what makes a pause survive a reboot. Resume = `enable` + `bootstrap`.
- **Loops inside a process (`inproc`)** can't be unloaded. The video-plan card's clock lives in the
  Minami bot. Pausing one writes `~/.minami/automations/paused/<id>`, and the loop checks that file on
  every tick. A new in-process loop needs an `INPROC` entry here and the same check in its code.
- **Edit** rewrites the plist (`plutil -convert xml1`) and reloads it. A paused job stays paused, and the
  new plist is read on resume. A command edited or created on this page always becomes
  `/bin/zsh -lc "<command>"`. Schedules more complex than daily / weekly / every N / login / always (for
  example several times a day) show as text and can't be edited from the page.
- **Delete moves the plist to `~/.minami/automations/trash/`.** "Deleted" at the bottom restores it.
  `minami-bot` and `secondbrain-sync` are `PROTECTED`: they can be paused (with a confirm) but not deleted.
- Ids must match `^com\.thomas\.[a-z0-9.-]+$`, and every call is `execFile` with no shell, so an id from
  the client can't reach another domain or inject a command.

## The page (redesign, 2026-10-14)

The first version was a list of rows with five buttons each. Thomas: "better UI UX and visual clues".
Read top to bottom, the page now answers four questions in order:
- **What fires when.** "Your 24 hours" has one lane per project, running 06:00 → 06:00 so the night's
  video chain (20:00 → 21:30 → 00:30) isn't cut at midnight.
  - Fixed times are glowing dots joined by a line.
  - `every N` jobs are a dotted band; always-on jobs are a solid one.
  - A paused job is a hollow, dashed dot; a failed one is red.
  - Two times within ~2 h step their labels onto a second line.
  - Clicking anything jumps to its card and flashes it.
- **What's next.** A live countdown, plus whatever is running right now.
- **Is anything wrong.** Filter chips with counts. "Failed" always shows, as a green "✓ Nothing failed"
  when the count is zero, so its absence is information.
- **Each job's state**, carried by colour and motion before words:
  - the left stripe and the pill;
  - a pulsing dot plus "up 3 h" while a process runs;
  - a hatched, dimmed card plus "paused 2 h ago";
  - the last line the job wrote to its log (red when it failed). It's the cheapest sign of life there
    is, and clicking it opens the full log.

**Controls:** each card has an on/off switch, a ▶ button and a ⋯ menu (Edit / Full log / Delete).
Pause, delete and restore show a toast; pause and delete offer **Undo**.

The server side added three fields per job:
- `pausedAt`: stored in `meta.json` on pause; for an in-process job, it's the content of its flag file.
- `upSec`: from `ps -o etime`.
- `lastLine`: read from the last 4 KB of the log only.

## Inside /autopilot (§30, 2026-10-16)

`/automations` now redirects to `/autopilot#runners`. The page became `RunnersSection` in
`app/autopilot/RunnersSection.tsx`, rendered under the Goals section. Why: a goal is the outcome and these
jobs are the runners that produce it. "Is the goal moving?" and "did its job run last night?" used to be a
tab apart.

- The list is split in two bands, each still grouped by project: **Serving a goal** (the goal runner
  `com.thomas.goal-runner`, plus any job whose `project` matches a visible goal's note through
  `matchesProject`) and **Housekeeping** (everything else). Every control is unchanged.
- The fetch and the POST path moved into `useAutomations()`, so `/autopilot` hands one list to both the
  goal cards ("Worked on by") and this section. There is no second poll of launchctl.
- The shell's project filter hides jobs from other projects, but a job that serves a visible goal stays.
  Without that, filtering to a goal's project would name the goal runner on the goal card and then hide
  its card.
- `#auto-<id>` links (the goal cards' rows) are caught on `hashchange`, which clears the status chip
  and flashes the card. The toast sits at `bottom-24` on phones so the shell's bottom bar doesn't cover
  Undo.

## The Day strip and the run record (2026-10-21)

Thomas called the 24-hour ring in the pitches "confusing", then picked "T1 · Day strip" from the `autopilot-time`
pitch. Its moodboard (`autopilot-time-mood`) counted what was wrong with the ring:
- it put two clocks on one circle;
- it left off 6 of the 16 runners (every N min, always on, at login);
- it drew Sunday jobs on a Wednesday;
- its dots had no names, and it had to be read by angle.

The section is now `app/autopilot/DayStrip.tsx` plus a much shorter `RunnersSection.tsx`:
- **The sentence:** "12 ran today. 3 need a look. Next is … at 20:10."
- **Needs-a-look cards**, decided once in `lookOf()`. A runner gets one when it:
  - failed (exit ≠ 0);
  - isn't loaded;
  - repeats but has been quiet for more than 3 periods, which prints "about N runs left no trace";
  - is daily and missed its time by more than 45 min;
  - finished a partial run (a last line like `9/10 rendered`);
  - is unfiled (no project).
- **The strip:** 00 → 24 in a straight line with a red now-line. Every timed runner is a named pin: ✓ done, amber
  needs a look, blue later, grey passed with no record. Labels sit in 3 lanes, filled greedily, and a label left of
  the now-line ends at its pin instead of crossing the line.
- **Tracks:** one thin bar per repeating or always-on runner. It is green while on time, then amber dashes from
  when it went quiet.
- **One line for the rest:** at login, and not today (weekly jobs on another weekday).
- **Clicking anything opens that runner's `Card` under the strip:** a pin, a track, a name, a look card or an
  `#auto-<id>` link. The card has run, pause, edit, log and delete. The lane chart, the status chips and the two
  bands of 16 stacked cards are gone.
- **The phone (`PhoneDay`):** the same day runs top to bottom, with the now-line between past and later and the
  repeating jobs in one "All day" block. A runner that needs a look starts open where it sits.

**The run record.** launchd keeps no history, and "last run" was the log's mtime. That can't tell a run that wrote
nothing from one that never started, which is how the upload sync went quiet for 10 h and still looked fine.
- **The wrapper** is `bin/minami-run`, installed as `~/.minami/bin/minami-run` so no plist points into a worktree.
  `minami-run <label> -- <command…>` appends `{id, event:"start", start}` when the job starts, then
  `{id, event:"end", start, end, exit, secs, last_line}` to `~/.minami/runs.jsonl` (`MINAMI_RUNS_FILE` for tests).
- **It is invisible to the job:** output passes through, the exit code is kept, and SIGTERM is forwarded.
- **Migration:** all 15 `com.thomas.*` plists were migrated on 2026-10-21, with originals in
  `~/.minami/automations/plist-backup-2026-10-21/`.
  - 10 were reloaded straight away.
  - `video-pitch` was mid-run, and `minami-bot` is always on, so those two take the wrapper at their next reload.
  - `minami-login`, `minami-vocab` and `secondbrain-sync` are RunAtLoad, so they take it at the next login.
- **What `list()` does with it:** it reads the last 512 KB of the record. Every item gets `today` (its runs since
  midnight) and `recorded` (whether it is wrapped). `lastRun` prefers the record over the log's mtime. The command
  shown on screen drops the wrapper prefix.
- **create / update** wrap new commands the same way.

## One run at a time (2026-10-22)

`bin/minami-run` (installed copy `~/.minami/bin/minami-run`, which every plist runs) now holds
`~/.harness/locks/run-<id>.lock` for the whole run. It uses the same format as tiktok-studio's `scripts/lib/lock.mjs`:
`{pid, at, note}`, created O_EXCL. A second copy that finds the lock held by a live pid doesn't start. It writes
`{"id","event":"skip","at","holder"}` to `runs.jsonl` and exits 0. A lock whose pid is dead is taken over, then
re-read after 150 ms. The lock is released on exit, including after a SIGTERM.

- **Why:** on 2026-10-21 a publish command run twice, 10 s apart, posted three videos twice (vault note *Duplicate
  TikTok Posts 2026-10-21*). That pair came from a chat session running the command by hand, so the action's own
  lock is what stops it. The same overlap was open here whenever launchd's schedule met a Run now.
- **Why exit 0:** a skipped run is the job already doing its work. A non-zero exit would mark the runner failing.
- **Why no `start` field on a skip line:** `runRecords()` keys on `start`, so the skip line is ignored, and a
  dashboard built before this change reads the file unchanged.
- **Tested:** two overlapping runs, a dead-pid lock, exit-code passthrough, SIGTERM release.
- **Install:** `cp` to a temp name, then `mv` over the installed copy. bash reads a script as it runs, so overwriting
  the file in place could corrupt a job that is mid-run.

## Gotchas

- **Status `NOT LOADED` is real, not a bug.** On 2026-10-14, `minami-login` was not loaded in the GUI
  domain. It loads again at the next login. The page offers **Load**, but loading a `RunAtLoad` job runs it
  immediately; for `minami-login` that opens a browser window.
- **"Last run" is the log file's mtime**, because launchd doesn't record when a job ran. A job that runs
  without writing anything looks like it never ran.
- **Create is real code execution.** The page writes a plist that runs any shell command. That's the
  same power a chat pane already has on this box, but it's the reason the page never runs a command
  itself; launchd does.
- Test with `MINAMI_AUTOMATIONS_DIR=<tmp>`. It moves meta, pause flags and trash, but **not**
  LaunchAgents: a test creates a real job, so give it a `zz-` id and delete it afterwards.
