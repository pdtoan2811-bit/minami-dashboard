# Autopilot

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 13. Autopilot — `lib/autopilot/*`, `app/api/autopilot`, `components/AutopilotPanel.tsx`

An always-on agent that merges finished task worktrees, resolves the conflicts it safely can, and
deploys. It exists so that using this dashboard doesn't require knowing what a merge is: the person it
was built for wants to iterate on several projects at once and never type `task merge`.

**Off by default, and that is not a formality** — it rewrites the user's git history unattended. The
switch is `enabled` in `~/.minami/autopilot.json`; nothing happens until it is explicitly `true`.

### Why the switch lives on disk
Every other preference in Bento is a `useSetting` (localStorage, per browser). This one can't be: the
thing that reads it is a `setInterval` inside next-server, which has no browser to ask. It also has to
survive the restart the autopilot *itself* causes — it merges, it deploys, the deploy kills the server,
and the next process must come back knowing whether it was switched on. A file does both. It's re-read
every tick, so switching it off takes effect on the next tick rather than the next restart.

### The one invariant
**Never leave the base checkout mid-merge.** A conflicted merge leaves every other agent in that tree
working on a broken state, and nothing else on the box will tell them (§9). Every failure path ends in
a completed commit or `git merge --abort`. A missed merge costs a click; an abandoned conflict costs a
morning. Three mechanisms hold it:

- **A claim file** (`~/.minami/autopilot-merge.json`) written before the merge starts, removed after.
- **`recoverFromCrash()`** runs from `instrumentation.ts` *before the first tick*, not lazily from a
  route: if the previous server died holding a conflicted merge, the checkout is broken right now, and
  nobody should have to visit a page to get it undone. It only aborts a merge the claim file says was
  **ours** — a human's half-finished resolution is theirs, and discarding it because a server restarted
  would be its own incident.
- **Verify, never trust.** After the resolver agent stops, the runner checks the state on disk: no
  unmerged paths, no leftover conflict markers in any changed file, and a clean `next build` — *then*
  it commits. The same rule the deploy follows when it judges success on a changed PID rather than on
  exit 0. An agent reporting "done" is not evidence.

### Gates before it touches anything
It reuses `bin/task.mjs merge` rather than reimplementing the gates, so there is exactly one definition
of "ready" (§9). On top of those it adds:

- **`--json` on `list`/`merge`**, so the runner reads the same gates the CLI enforces. A second reader
  of git plumbing would be a second set of rules to keep in sync, and the one that drifts is always the
  automated one nobody watches.
- **A settle delay** (`settleMs`, default 2 min after the last commit). "Committed" is not "finished" —
  a run of commits 20 seconds apart is one thought, not three.
- **Main checkout only.** `mainRoot()` compares `process.cwd()` against the parent of `git-common-dir`
  and returns null in a worktree, so a preview server on :30xx never merges into its own tree.
- **Both locks respected** — a held `minami-merge.lock` or `minami-deploy.lock` means someone else is
  mid-operation, and the tick simply returns.
- **Alert-storm guard.** A persistent state (dirty base, human mid-merge) complains at most every 30
  minutes. An always-on thing that reports the same non-actionable fact every 45 seconds trains you to
  ignore it.

### What it refuses to decide
Intent. A conflict where both sides implemented the same behaviour differently is aborted and handed
back, because choosing between them is a product decision wearing a diff's clothing. It resolves the
mechanical kind — both sides appended to a changelog, added rows to a table, edited different functions
in one file — which is what §4 of the `minami-flow` skill already told a human agent to do. A task that
gets aborted is added to a `blocked` set and never retried automatically; retrying a semantic conflict
on a timer is just a slower way to fail.

### Gotchas
- **It deploys detached, always** (`deploy.sh --detach`) — it's launching the thing that kills it.
- `git merge --abort` is safe here precisely because `task.mjs` refuses to merge a dirty base, so the
  only uncommitted work in the tree at that moment is the merge's own.
- `.git` is a **directory** in a main checkout and a **file** in a worktree, so mid-merge state is asked
  of `git rev-parse --git-dir` rather than assumed from a path. Guessing wrong fails in the worst
  direction: a conflicted merge would look finished.
- Junk config is clamped **on write as well as on read**. The file is meant to be hand-editable, so
  what it says has to be what is in force — a file containing `everyMs: 1` that the reader silently
  rescues is a trap for the next reader.

---
