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
