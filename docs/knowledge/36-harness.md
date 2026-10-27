# §36 · Harness browser — is it up, is it logged in, what did it open

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

The **harness browser** is the one shared Google Chrome that `~/tiktok-studio`'s scripts, the goal runners
and agents drive over CDP on `127.0.0.1:9333`, on its own profile (`~/.harness/profiles/web`). Every logged-in
capture (Pinterest first) rides on that profile, so "is it still logged in" and "what has it been doing" are
questions about one browser. The page at **`/harness`** (rail: Library → Harness browser) answers both.
Asked for 2026-10-27: "open the browser harness for me to check the login, and create a place for me to see
the log of using browser harness".

## What's on it

- A 24-hour strip of pages opened per hour, with a now-line on the right (time reads as a straight line here,
  as on Today), and the count.
- Status: up or down (it starts on demand and closes itself after 45 idle minutes), the Chrome version, and
  the tabs open right now.
- **Check logins** runs `node ~/tiktok-studio/scripts/browser.mjs login`, the studio's own phone login page
  (`login-browser.mjs`, tailnet-only on `:5592`, a CDP screencast you tap and type into). While it's up the
  button becomes **Open the login page ↗** plus **Close it** (`login off`). Logging in there logs in every script.
- Visits, newest first, grouped by day: one row per tab, its site, the last page title, how long it was open,
  and the pages it walked through (tap to expand). Chips filter by site.
- Folds: browser starts/stops and login opened/closed, and the tails of `browser.log` and `login.log`.

## Where the log comes from

The studio's daemon (`scripts/browser.mjs serve`) writes **`~/.harness/usage.jsonl`**: `up`, `down`, and per tab
`open` / `nav` / `title` / `close`, plus `login` / `login-off` from the CLI. It is written in the daemon, not in
`scripts/lib/browser.mjs`'s `harness()`, because only the daemon sees every tab: scripts through `harness()`,
agents through `agent-browser connect 9333`, the login page. CDP doesn't say who opened a tab, so the log is what
and when, not who.

- **Query strings and fragments are dropped** before writing: login and OAuth redirects carry tokens there.
- Tab numbers restart at 1 on every daemon start, so `lib/harness.ts` keys a visit by (daemon run, tab).
- The log begins at the daemon's first start after 2026-10-27. The daemon that was already running then
  kept no log; the page says so until there is one.
- The dashboard only **reads**: `lib/harness.ts` never launches Chrome (two launchers on one profile corrupt
  it). The login route only shells out to the studio CLI, and accepts nothing but an http(s) URL.

Env: `MINAMI_HARNESS_DIR` (default `~/.harness`), `MINAMI_HARNESS_STUDIO` (default `~/tiktok-studio`),
`HARNESS_BROWSER_PORT` (default 9333).

Checked 2026-10-27: the watcher code against the live harness (a background tab to `example.com/?token=…` logged
open → title → close, token dropped); the API against the running daemon (up, 2 tabs, login page up); the page
renders on a side dev server. Not yet seen: a log written by the real daemon, which starts on its next start.
