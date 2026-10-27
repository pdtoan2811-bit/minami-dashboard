# §32 — Storage janitor

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md). Section numbers are stable ids: code comments cite them.

---

## 32. Storage: `bin/janitor.mjs`, `lib/autopilot/storage.ts`, `app/autopilot/StorageSection.tsx`

Keeps the Mac's disk above a floor without being asked, and says so loudly when it can't. Built 2026-10-22 after
Thomas: "the autopilot in Minami dashboard should be the one keep my storage and work neat and clean regularly —
somehow it failed to do so."

> 🐛 **The disk filled twice in three days and nothing on the box noticed (2026-10-20 → 22).**
> The 228 GB disk went from 30 GB free to 11 GB in 48 h, about 10 GB a day. On the worst night the video overnight
> runner's own tidy ran at **3.3 GB free, freed 0.0 GB**, and **five renders failed** "4.8 GB free after tidy, need
> 6". The dashboard's event log had **zero** disk events; Thomas found out from macOS. Why:
> 1. **Storage was nobody's job.** Autopilot's duties were merge · resolve · deploy · freshness (§13), and its
>    merge pass only ever looks at the dashboard's own repo. But the dashboard makes a worktree per chat in *every*
>    repo (ecvision, tiktok-studio, oe-central-ver2…), and those had no owner: 30+ trees, ~25 GB.
> 2. **Each cleanup knew one corner.** Video Studio's tidy knew its renders; `prune-worktrees.sh` ran inside the
>    vault sync; Next's Turbopack dev caches (no size cap in 16.3, 1–3 GB per app, ~15 GB total) and leaked
>    ffmpeg temp dirs (`mix-*`, 81 dirs, 7.8 GB, from a script that only cleaned up on success) had no cleaner.
> 3. **A cleaner that frees nothing looked the same as one that worked.** No alert for "ran below the floor and
>    freed 0", and none for "didn't run".
> Recovered by hand that day: 11 → 63 GB free.

### Mechanics
- **Two halves.** `bin/janitor.mjs` is the only thing that deletes for storage: a plain Node script, no imports
  from the app, so it runs with the server down. `lib/autopilot/storage.ts` is the `storage` duty: it decides
  *when* (free-space watermark, checked every autopilot tick with one `statfs`) and watches the janitor
  (dead-man's switch). The split is the bug's lesson: the dashboard restarts on every deploy and must not be the
  only clock. `com.thomas.minami-janitor` (launchd, 00:15, `bin/install-janitor.sh`) is the other clock. It runs
  before the video renders and catches up on wake.
- **Thresholds** in `~/.minami/janitor.json` (hand-editable, all optional): `lowGB` 40 (below → tier 2 runs and
  the tick starts a pass; was 60 until Thomas: "can drop under 40gb", 2026-10-22), `targetGB` 80 (a pass stops here: Thomas's target), `criticalGB` 25 (bell + macOS
  notification with the tier-3 list), `growthAlertGB` 8/day, `worktreeCap` 12 per repo, `idleDays`
  {cache 1, worktree 3, nodeModules 7}, `protect` (node_modules other projects load without cd-ing in:
  `~/hyperframes` is the Video Studio preview's fork), `projectTidy` (each project's own cleanup).
- **Tiers.** 1, always: leaked `$TMPDIR` dirs by prefix, `.next/dev` + `.next/cache` of apps no process sits in
  and idle ≥ 1 d, `git worktree prune`; package caches only below `lowGB`. 2, below `lowGB` / nightly /
  render-floor: each project's own tidy, then **worktree recycling**, then idle `node_modules` with a lockfile.
  3, asks only: Docker (`image prune -af` + `builder prune -af` + `docker/desktop-reclaim-space`; containers,
  running or stopped, and volumes are never touched — not `system prune`, which deletes stopped containers), written to `asks.json` and
  shown on the Storage tab with a button.
- **Worktree recycling never merges** (that's §13's job, behind task.mjs's gates). A tree that is unclaimed (no
  claim heartbeat < 30 min, the rule `prune-worktrees.sh` uses), has no process cwd inside it, is not mid-merge
  or rebase, and is idle ≥ 3 d (or over the cap and idle ≥ 1 d) gets its uncommitted work committed to its own
  branch (`wip:` commit, `--no-verify`; detached HEAD → a new `wip/<name>-<date>` branch), then
  `git worktree remove` **without `--force`**, so a session that came back in between makes git refuse. The
  ledger line carries `git worktree add <dir> <branch>`. Untracked files over 50 MB are not committed: that tree
  becomes an ask.
- **The guard is code, and it's tested.** `assertDeletable()` refuses anything outside `$HOME`/`$TMPDIR`,
  anything under `~/Library` (except `$TMPDIR`), cookies, logins, Keychains, `~/.harness`, `ms-playwright`,
  `~/.ssh`, `~/.claude/projects`, and the vault except its worktrees and build dirs. `node bin/janitor.mjs
  --selftest` asserts 14 cases and exits 1 on a miss. Claude Code's own worktree sweep was reported deleting
  dirty, unpushed trees its docs said it kept, so a guard that's only assumed isn't one.
- **Files** in `~/.minami/janitor/`: `ledger.jsonl` (every removal: path, bytes, why, how to restore),
  `runs.jsonl` (every pass: free before/after, freed, errors), `disk.jsonl` (one sample a day: free GB + the 15
  biggest folders, which drives the growth alert and the trend bars), `asks.json`, `run.lock` (one pass at a
  time; a lock older than 2 h or whose pid is dead is taken over).
- **Off = watch-only.** With `autopilot.json` `enabled && storage` false, a pass measures, records and alerts but
  deletes nothing (`watchOnly` on the run). Like every write duty, `storage` defaults off (§13).
- **Alerts** (bell, through `bin/minami-event.mjs`, kind `storage`): freed ≥ 1 GB (success); below the floor and
  freed < 1 GB (warn: the exact silent failure above); below critical (error + macOS notification); a day that lost
  more than 8 GB, naming what grew; no good pass in 26 h (warn, every 6 h at most, its own timer so a chatty
  merge state can't mute it).
- **Video Studio** (`~/tiktok-studio/scripts/overnight.mjs` `room()`): under its 6 GB floor after its own tidy,
  it now runs one janitor pass (`--why render-floor`) before skipping the render.

- **Docker counts as "in use".** Containers run in Docker's VM, so `lsof` never sees their cwd. A pass asks
  Docker for every running container's bind-mount sources and compose working dir and treats them as in use,
  matched both ways (a mount of `~/ecvision` covers `~/ecvision/frontend` and vice versa). Docker running but
  not answering (it hangs on this box) → every repo holding a compose file is left alone, and the pass says so.

> 🐛 **The first janitor would have recycled worktrees under a running `docker compose` (caught 2026-10-22,
> before it ever ran).** Thomas asked "when I activate docker — will it mess up since docker is not in the
> equation". It would have: the in-use test was `lsof` cwds only, and the first dry run planned to recycle 3.5 GB of
> ecvision and oe-central-ver2 worktrees — both compose projects. Fixed with the Docker check above; the same dry
> run now leaves both alone.

### Gotchas
- **Slack.** "Critical" and "couldn't free" also DM Thomas, and so does the dead-man's switch (via `janitor.mjs
  --slack`), through Video Studio's `scripts/lib/slack.mjs` — the one helper that already holds Minami's bot token
  and his DM. "Critical" and "couldn't free" are de-duplicated across passes by `isNews()` (state in
  `~/.minami/janitor/alerted.json`): they speak on entering the state, on 5 GB worse, on stuck → critical, or once a
  day, and the file is cleared once a pass ends above `lowGB`. The bell and the macOS banner follow the same rule.

> 🐛 **35 Slack DMs overnight from a disk that wasn't moving (2026-10-26 18:46 → 10-27 08:28 UTC).** Free space slid
> under the 40 GB floor (~/ecvision's worktrees +8 GB in a day to 21 GB, a new 4 GB ~/ScreenPal, Docker steady at
> 28 GB). Everything left was either under 3 days idle or Docker, which is Thomas's call, so every watermark pass
> freed nothing. The tick starts a pass every 20 min while under the floor, each pass is a new process with no
> memory of the last, and "couldn't free" DM'd each time. Fix: `isNews()` above. Same night, every pass also spent
> 300 s waiting on uv's cache lock, held for as long as the StoreLeads Grafana MCP (`uvx mcp-grafana`) runs: `uv
> cache prune` now gets `UV_LOCK_TIMEOUT=10`.
- **Reopening a chat whose tree was recycled** (`restoreRecycledTree()` in `lib/worktree.ts`, called first by the
  send route): if the janitor's ledger names the tree's branch and that branch is not in the base yet, the tree is
  `git worktree add`-ed back at the same path and the chat resumes in it with its saved work. Otherwise the older
  rescue (`rehomeStrandedTranscript`, resume in the base) applies — right for trees whose work was merged.
- Thresholds are defined twice, in the script (authority) and in `storage.ts` (reader for the tab). Change both.
- `findDirs()` prunes `node_modules` while searching; searching *for* `node_modules` must drop it from the prune
  list, or `find` prunes every match before it can print it. That bug was in the first draft.
- GiB throughout (`2**30`), the unit `df -h` prints and the number Thomas has been reading. Finder shows GB
  (1e9), about 7% higher.
- A restored tree has no `node_modules` or build caches (not in git): the chat reinstalls when it needs them.
- Other bell events still don't reach Slack; only the janitor's three alarms do.
