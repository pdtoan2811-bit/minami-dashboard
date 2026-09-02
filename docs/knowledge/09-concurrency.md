# Concurrency — why two chats collide

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 9. Concurrency — `bin/task.mjs`, and why two chats collide

**The condition:** every chat pane spawns a `claude` whose cwd is the *project folder*. Two panes on
one project therefore share a working tree, a branch and an index. Agent A's `grep` returns code
agent B is halfway through rewriting; whoever writes last wins, silently. Nothing in git or the SDK
prevents it.

It is not a rare edge case. Reconstructing one day (2026-07-29) from transcript timestamps:

```
054f88de  06:46:17 → 08:14:11   1040 rows
dedd6fc2  07:50:49 → 09:24:47    785 rows     ← 24 minutes of overlap
```

**5 overlapping pairs in that day alone.**

### The fix is isolation, not etiquette

`bin/task.mjs` gives each task its own **git worktree** — a second checkout of the same repository,
sharing the object store (the worktree's `.git` is a 4 KB pointer file), with its own branch, index
and files. Collisions stop being unlikely and become impossible.

```bash
node bin/task.mjs new browser-fix      # worktree + branch, prints its preview port
node bin/task.mjs list                 # branch · commits ahead · dirt · which have a live agent
node bin/task.mjs preview browser-fix  # build + serve on its OWN port; :3000 untouched
node bin/task.mjs merge browser-fix    # verify → build → merge into base (serialised)
```

Then point a chat pane at the worktree folder, and that agent physically cannot touch another's files.

**The merge is the point.** An overwrite in a shared checkout is not a conflict — it is a loss, with
nothing left to resolve. Moving integration to a merge is what converts silent losses into conflicts
git can reason about and you can fix.

### Gotchas
- **Ports are derived from the task name (FNV-1a → 3010–3099), never assigned round-robin.** A preview
  must land on the same port every time to be bookmarkable, and two tasks must not silently collide.
  The hash picks a *preferred* slot only; clashes probe forward, walking names in sorted order so a
  port depends solely on the set of live task names — not on creation order, and not on which command
  is asking (`new`, `list` and `preview` must print the same number). Of two clashing names the
  alphabetically earlier keeps the natural slot, so removing a task can move a port, but only one that
  was already displaced.
- **`node_modules` is symlinked from the base checkout**, not installed per task — a real install costs
  minutes and gigabytes, and a task is the same `package.json` by construction. The exception is a task
  that *changes dependencies*: delete the link and install for real.
- **Merge refuses when the base checkout is dirty.** That refusal fires constantly at first, because
  working dirty on the base branch is exactly the habit this replaces.
- **Merge refuses while an agent is live in the task** (via `/api/agent/live`), and is serialised on
  `/tmp/minami-merge.lock` so two merges can't interleave.
- Builds go to `.next-task`, never `.next` — so a preview build can never disturb the live server.

> 🐛 **The stable-port scheme had no collision check, and the comment promised one.** `portFor()`
> returned `PORT_BASE + fnv(name) % PORT_SPAN` and stopped there, while the line above it asserted
> "two tasks must not silently collide on one". With `PORT_SPAN = 40`, the birthday bound makes a
> clash likely at well under a dozen tasks — and it was already real: `bell-anchor` and
> `resume-audit2` both resolved to **:3024** with only three worktrees alive. Nothing detects this.
> The presenting symptom would have been a `preview` that dies on `EADDRINUSE` for no visible reason,
> or — if the first task's preview had since been stopped — the far worse quiet version: a bookmarked
> `localhost:3024` serving *a different task's build*, which reads as "my changes didn't take".
> Found while pruning merged worktrees, not by hitting it. Fix: the hash now picks a preferred slot
> and collisions probe forward deterministically (sorted-name order, so the result depends only on
> the set of names), the span widened to 90, and exhausting it throws instead of wrapping onto a
> live port. Verified by unit-testing the allocator at full span and by checking that `new` and
> `list` print the same port for two real worktrees.

> 🐛 **Deploys had no mutual exclusion at all.** Two agents in this repo request deploys
> independently, and `next build` replaces `.next` **in place under the running server** — so two
> builds interleaving corrupt the directory the live process is reading, and the second swap can leave
> a PID serving a build that no longer exists on disk. There was no lock, no PID file, no check.
> `bin/deploy.sh` now takes an atomic `mkdir` lock (macOS ships no `flock`) with stale-holder recovery,
> plus an advisory pre-check *before* the detach fork — without that, the refusal is written to a log
> the caller can no longer read, and an agent is told "deploy running" for a deploy that declined.

> 🐛 **A deploy's own requester vetoed it.** Observed in `~/.minami/deploy.log`: a detached deploy
> waited 300 s for quiet, then aborted with `still busy (1 turn(s)) — waiting on your answer`. The
> blocking turn was **the agent that had asked for the deploy**, sitting on a question. The requester
> can never be quiet while it is waiting to be told what to do, so the wait-for-quiet strategy has a
> hole exactly when a deploy is requested interactively. Until the agent host moves out of
> `next-server` (see below), the workaround is to ask first and deploy last.

### The last mile — the dashboard isolates a chat, because only it can

For most of this subsystem's life the tooling was complete and **nothing used it**. `task.mjs` could
create worktrees, `worktree-claim.ts` could tell you who was in one, and the autopilot could merge and
prune them — but the step in the middle was manual: leave the dashboard, run a CLI, come back, pick the
folder it printed. The post-mortem below is the consequence, and it is worth reading as a design
lesson rather than a bug: a guard that has never once evaluated true is not a guard.

`lib/worktree.ts` + `/api/worktree` are that middle step. **A blank second-or-later chat in a git repo
is given its own worktree when it is created** (`addPane`, `app/page.tsx`), silently. Two facts put the
decision there and nowhere else:

- **A session's cwd is fixed at spawn.** A conversation already running cannot be moved into its own
  checkout, so isolation happens before the first message or not at all. The autopilot ticks on a timer
  and cannot see that moment; the thing creating the pane can.
- **The dashboard is the only process that can see both chats.** git can't, the SDK can't, and neither
  agent can see the other.

| | |
|---|---|
| **What isolates** | A new **blank** chat, when the project already has a pane open, in a git repo, not already in a worktree |
| **What never isolates** | Reopening an existing session — it carries the cwd it was born in, because `--resume` is scoped to the directory the transcript is filed under (§1) |
| **Switch** | `MINAMI_AUTO_ISOLATE=0` globally; `git config minami.isolate off` per repo. Both read on the server only, so a client can't disagree |
| **Backends** | `bin/task.mjs new --json` where it exists (ports, the node_modules link, the merge gates, the autopilot's view — one definition each); plain `git worktree` in any other repo |
| **Way back** | `merge back` on the pane (`IsolatedBar`), and the autopilot for anyone who has it on |
| **Cleanup** | Closing an isolated pane discards the tree **if it is pristine** — no commits ahead, nothing uncommitted |

> 🐛 **A notes vault must not isolate — a compaction ran invisibly (2026-09-02).** secondBrain is
> the machine's most-opened folder precisely because it holds shared context, and every overlapping
> chat there got its own worktree: four piled up (`chat-2..chat-6`), holding uncommitted QSortby
> notes, a wiki teardown, deck-kit's whole `handoff` feature, and — sharpest — a vault compaction
> that ran to completion on `task/chat-6`, invisible to sync, Minami, every other session and every
> other device, against a vault view 50 commits stale. In a repo without merge gates nothing ever
> folds a tree back, so "isolated" quietly means "stranded". Isolation protects parallel CODE edits;
> in a vault it destroys the one thing the session came for. Hence the per-repo opt-out:
> `git config minami.isolate off` (set in secondBrain that day) — a git config, not an env list,
> because the decision belongs to the repo and travels with the checkout. The stranded content was
> rescued into `main` (rescue commit + two cherry-picks); the live `chat-6` compaction was left for
> a deliberate reconcile.
>
> **Reversed the same evening — recycling beat opting out.** Thomas wants the fresh-branch-per-chat
> flow ("new branches everytime"), so secondBrain's `minami.isolate off` was removed and the
> pile-up was fixed at its actual root: the vault's own `bin/prune-worktrees.sh` (run by every
> `sync.sh`) now treats a claim with a >30min-stale heartbeat as dead rather than live-forever,
> auto-merges clean unclaimed finished branches into main (`--no-ff`; any conflict aborts and the
> tree is kept with a "needs a human" line), and deletes tree + branch + origin branch. `sync.sh`
> rebases with `--rebase-merges` so those merge commits survive syncing. The per-repo opt-out
> stays available for repos that genuinely want it; the vault just isn't one.

**Isolation must not move a chat off its own tile.** `project` is `basename(cwd)`, so without a fold a
pane in `.minami-worktrees/chat` files itself under a new project called `chat` — the chat you just
started appears to have left the topic. `topicOf` (`lib/claude-sessions.ts`) folds a worktree path back
to the repo above `.minami-worktrees` and keeps the task name in `isolatedAs`, so the UI can still say
which checkout a chat is in. Folded, not hidden. `META_DERIVATION_VERSION` was bumped so already-cached
sessions pick it up without re-reading a byte.

Three smaller things that only matter once this is automatic:

- **`task new` links `node_modules` at creation**, not lazily at first build. A worktree without it has
  no working `npm` at all, and the agent that lands in one never asked for a worktree — it should find
  a checkout it can work in, not one it has to repair.
- **`task new --json`**, so the dashboard reads creation the same way the autopilot reads `list` and
  `merge` instead of screen-scraping.
- **The pristine discard.** An auto-created tree is a *guess* about what a chat was going to do, and a
  wrong guess has to cost nothing — otherwise opening and closing three blank chats leaves three
  checkouts and three branches to clean up by hand, and the friction this removed comes back as mess.

> 🐛 **The auto-discard passed `--force`, the one flag that turns the occupancy guard off.** Closing
> an isolated pane calls `discardIfPristine`, which ran `task.mjs rm --force`. `cmdRm` gates its
> claim/live-cwd check on `&& !force`, so the call disabled exactly the protection installed after the
> incident above, then substituted a dirty/commits check that **cannot** see occupancy — the claim
> file is gitignored, so a claimed tree reports zero dirty files. And closing a pane does not stop its
> session; that is deliberate and documented two sections up. Repro: open a blank second chat, send a
> message, close the tab while the agent is still reading, and its checkout is deleted underneath it.
>
> Verified against a real worktree: a claimed tree shows `0` dirty files, `rm` without `--force`
> refuses with *"occupied — claimed by 1 pane(s)"*, and `rm --force` deletes it. Three gates now stand
> in the way, in order of what they can see — the claim file (checked in `lib/worktree.ts`, readable
> with the dashboard down), `task.mjs rm` **without** `--force` (re-checks claim *and* live cwd), and
> clean-plus-zero-commits-ahead. A refusal is a normal outcome: the tree simply stays.
>
> The shape of the mistake is worth more than the fix. The module imports `worktreeOf` from
> `worktree-claim` — the file whose entire purpose is answering "is anyone working here?" — and then
> never asked it. A guard you route around is worse than one you never had, because the code reads as
> if it is protected.

> 🐛 **Two smaller ones in the same pass.** (1) `nameFor` listed only *directories*, but `task new`
> mounts an **existing branch** when it finds one — so a leftover `task/chat` meant the next
> auto-isolated chat silently started on someone's old commits, and would have merged them on the
> first "merge back". Name allocation now reads `refs/heads/task` too; verified by leaving a stale
> `task/chat` and watching isolate return `chat-2`. (2) Name allocation and creation are not atomic,
> so two panes opened in the same second both picked `chat`; the loser threw, the route 500'd, and the
> client — which catches and carries on — created the pane **unisolated**, silently. It retries now.
> Both failed toward "no isolation" or "wrong isolation" while looking like success, which is the
> hazard of making the feature silent.

> 🐛 **`/api/worktree` would execute any repo's `bin/task.mjs`.** The route takes a client-supplied
> `cwd`, resolved to a git root, and ran the CLI *out of that repository*. Local-only posture, but it
> is still arbitrary-script execution keyed on a path the client names — any checkout on the machine
> carrying that filename would do. The CLI backend is now confined to the dashboard's own checkout
> (`isOwnRepo`, which resolves through a worktree's `.git` pointer file so previews still count);
> every other repo gets the plain-git backend, which runs nothing but `git`.

**What this deliberately does not do:** re-isolate chats that were already running, and merge
automatically in repos with no `bin/task.mjs`. The autopilot stays out of repos it has no gates for.

### Occupancy — who is working in a worktree

`lib/worktree-claim.ts` answers the question every destructive command here depends on. **Two signals,
either sufficient:**

| Signal | Source | Covers | Blind to |
|---|---|---|---|
| live cwd | `/api/agent/live` | anything running while the dashboard is up | the pre-`sessionId` window; a restarting server |
| claim file | `.minami-claim.json` in the tree | restarts, the dashboard being down, brand-new panes | a claim older than `CLAIM_TTL_MS` (10 min, `MINAMI_CLAIM_TTL_MS`) |

The claim lives *inside* the worktree, so removing the tree removes the claim — no orphan registry to
reconcile. `owners` is a list because two panes on one tree is legal, and the second arriving must not
evict the first from the record protecting it. Written by `manager.ts` at `ensureSession` (cold) and
every `sendMessage` (warm); released on `closeSession` once the last owner leaves. The release is the
fast path; the heartbeat TTL is the guarantee, because a killed server never reaches the release.

> 🐛 **The occupancy guard had never once run.** `bin/task.mjs` computed it as
> `liveCwds().has(worktreeDir)` — the set of **session** cwds tested against a **worktree** path. Every
> dashboard session's cwd is the base checkout, because `task.mjs new` creates a worktree but nothing
> ever moves a session into one: `~/.claude/projects/` contained no worktree-rooted directory at all,
> on a box that had run this workflow for weeks. So that `.has()` could never be true, which made
> `merge`'s `agent-live` refusal *and* the autopilot's `t.live === false` gate both unreachable code.
> Autopilot merged and deleted worktrees while agents were writing in them — twice in one morning,
> once mid-audit *while this fix was being written*.
>
> The guard was not miscomputed. The two sides spoke different vocabularies, so "is anyone working
> here?" was structurally always "no" — and a gate that always passes reads, in review, exactly like a
> gate that works. `cmdRm` was worse: it had **no** occupancy check at all, only a dirty check. That is
> the most destructive command here, and "clean" is the *normal* state of an occupied worktree at the
> moment something wants to delete it, because a merge commits immediately before removing the tree.
>
> Autopilot now gates on `occupied === false`, not `!== true`: an older `task.mjs` mid-deploy omits the
> field, `undefined !== false` refuses, and version skew fails safe.

> 🐛 **Two QA findings, before this shipped.** (1) The claim file made every claimed worktree
> permanently **dirty** — untracked files count as dirt — so `rm` refused for the wrong reason and
> autopilot would never merge a tree that had ever been claimed. It's in `.gitignore` now. (2)
> `worktreeOf` realpath'd its whole input, and `realpathSync` throws on a missing final component: a
> path to a file an agent was about to *create* came back unresolved while an existing one came back
> resolved, and on macOS those differ (`/tmp` → `/private/tmp`). The same worktree yielded two strings,
> `isOccupied`'s `===` missed, and the tree read as **free** — failing toward the dangerous answer. It
> now parses first and resolves only the root, which exists whenever the question is meaningful. Same
> trap as §14.1, where a typed path and a resolved one made an agent's history come back empty.

### What this does not fix

Sessions are still children of `next-server`, so a deploy still ends every conversation on the box.
The structural fix is to move `lib/agent/manager.ts` into a standalone daemon with the Next routes as
thin proxies over a socket — then deploying the UI stops killing chats, and the veto above stops
mattering. Not built.

---
