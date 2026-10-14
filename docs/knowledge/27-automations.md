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
