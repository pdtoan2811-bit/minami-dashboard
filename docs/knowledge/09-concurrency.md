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

### What this does not fix

Sessions are still children of `next-server`, so a deploy still ends every conversation on the box.
The structural fix is to move `lib/agent/manager.ts` into a standalone daemon with the Next routes as
thin proxies over a socket — then deploying the UI stops killing chats, and the veto above stops
mattering. Not built.

---
