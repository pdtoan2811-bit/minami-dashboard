---
name: minami-flow
description: Decide when to isolate, merge, deploy, and resolve conflicts in ~/minami-dashboard — where every chat pane on the box shares one checkout and runs inside one Next server. Use BEFORE starting substantive work there ("does this need a worktree?") and BEFORE shipping ("can I deploy right now?"). Also on - deploy, ship, redeploy, merge, worktree, checkout, branch, conflict, "get this live", "can I deploy"; a refused/aborted deploy or merge; or a session-start brief showing other agents live in the same folder. Covers bin/task.mjs, bin/deploy.sh, and the locks and quiet-checks they share.
---

# minami-flow — moving a change from "started" to "live" without breaking anyone

Two facts make this repo different from a normal one, and every rule below falls out of them:

1. **Every chat pane on the box shares this working tree.** Two agents in `~/minami-dashboard` share a
   branch, an index and the files. Agent A's `grep` returns code agent B is mid-rewrite of, and the
   last writer wins silently. See `docs/KNOWLEDGE.md` §9 — don't restate it, it's already written.
2. **Every chat pane on the box runs *inside* the Next server.** Deploying restarts it and kills every
   in-flight turn on the machine, including your own.

## The rule

**Orient before you act, then act — don't ask.**

Each irreversible step below has a gate that is a *command with a pass/fail*, not a judgment call. Run
the gate. If it passes, proceed without checking in. If it fails, **the failure has an action** —
take it. Escalate to Thomas only where this file says to, which is one place: a semantic merge
conflict.

Never wait on a human where a check would do, and never ask permission for something a gate already
proved safe.

---

## 1. Orient — always first

```bash
bash .claude/skills/minami-flow/orient.sh
```

One read-only call. Answers the four things you cannot see from inside a pane: which tree you're in,
who else is live in it, which locks are held, and whether anything is **stuck**.

Run it before your first edit, and again before shipping. It is cheap; the collisions it prevents are
not. Every incident in this repo so far was found by accident — a file changing under an open editor,
a lock refusing a command, a deploy timing out after fifteen minutes. All were one command away.

---

## 2. Worktree, or work in the base?

The trigger is **not** how big the task is. It's whether anyone else is in this tree.

| `orient.sh` says | Do this |
|---|---|
| `1 in THIS tree` (just you) + short, self-contained change | Work in the base. Isolation has a cost; don't pay it for a one-file fix. |
| `2+ in THIS tree` | **Worktree, always.** No exceptions, no "I'll be quick" — quick is exactly when overwrites happen. |
| Dashboard not answering | **Worktree.** You cannot prove you're alone, so assume you aren't. |
| Long/multi-file work, or you'll want a preview | **Worktree.** It gets its own port and its own `.next-task`. |

```bash
node bin/task.mjs new <name>          # worktree + branch, ready for an agent
node bin/task.mjs list                # every task: branch, commits ahead, dirt, port, live agent
```

Creating one is cheap and reversible, so **bias toward yes** — this needs no approval. Then point the
work at the printed directory. `node_modules` is symlinked from the base; if your change touches
dependencies, delete the link and install for real.

### Check the base is COMMITTED first — the rule above has a precondition

`task.mjs new` branches from **committed HEAD**, not from the working tree. If the base checkout is
dirty, the new worktree silently lacks every uncommitted change — you get a checkout that looks right
and is hours out of date, and you find out when something you *know* you wrote isn't there.

Observed 2026-07-29: with 47 uncommitted files in the base, a fresh worktree had no `lib/events.ts`,
no `minami-flow` skill, and not even a one-line fix made an hour earlier.

```bash
git status --porcelain | wc -l      # orient.sh reports this as `dirty: N file(s)`
```

| Base state | Do |
|---|---|
| clean | `task.mjs new` — isolation works as intended |
| dirty, and the changes are **yours** | commit them first, then branch |
| dirty with **another agent's** in-flight work | **do not commit it** — that snapshots someone's half-finished edit under your name. Work in the base, keep the diff tight, and re-read any shared file immediately before editing it |

So the honest form of the rule is: *isolate when you can, and when you can't, work small and verify
with `npm run build:check` before and after.* A worktree built on a stale base is worse than no
worktree, because it looks correct.

---

## 3. Merging

```bash
node bin/task.mjs merge <name>
```

**The tool is the gate.** It already refuses on a dirty task, a dirty base, a live agent in the task,
or a build failure, and it serialises on `/tmp/minami-merge.lock`. So run it and read the refusal as
data — you don't need to pre-check what it checks.

| Refusal | What it means | Action |
|---|---|---|
| task has uncommitted changes | your own work isn't committed | commit in the worktree, retry |
| base checkout has uncommitted changes | someone (often you) left the base dirty | commit or stash **in the base**, retry |
| an agent is live in `<name>` | another pane is mid-turn in that worktree | wait for it, then retry |
| build failed | a task that can't build doesn't get in | fix it in the worktree |
| another merge is running | serialised on purpose | wait; do not `--force` anything |

A successful merge changes nothing user-visible. **Merging is not shipping** — §5 is.

---

## 4. Conflicts — you now own the base

A conflicted merge leaves the **base checkout mid-merge**. Every other agent in that tree is now
working in a broken state, and nothing else on the box will tell them.

**You may not walk away, hand back, or end the turn in this state.** Exactly two endings are allowed:

- **Resolve it.** Fine to do autonomously when the conflict is mechanical — both sides appended to a
  changelog, added separate entries to a table, touched different functions in one file. Resolve,
  `git commit`, verify with `npm run build:check`.
- **Abort it.** `git merge --abort`, then report. Correct whenever resolving needs a judgment about
  *intent* — two real implementations of the same behaviour, or a change whose purpose you'd be
  guessing at. Aborting is free and loses nothing; the branch still exists.

**This is the one place to escalate to Thomas** — and only after aborting, so the base is clean while
he decides.

> **If Autopilot is on** (§12 of `docs/KNOWLEDGE.md`, `~/.minami/autopilot.json`), it may have already
> tried this and given up: a task it aborted is in its `blocked` set and it will not retry. So a
> conflict reaching you by hand has usually *already* been judged non-mechanical. Resolve it or abort
> it yourself — do not switch Autopilot off and on hoping it will take another run at it.

---

## 5. Deploying

```bash
bash bin/deploy.sh --detach
```

`--detach` is not optional from a pane. Your `claude` is a grandchild of the server the swap kills;
inline, you'd cut off the turn that asked. `deploy.sh` walks its own ancestry and auto-detaches if it
catches you, but pass the flag deliberately.

### The gate — all four, before you run it

| Check | How | If it fails |
|---|---|---|
| Code compiles | `npm run build:check` (**never** bare `npm run build`) | fix it; do not deploy |
| No deploy already running | `orient.sh` → deploy lock free | one is queued and will build the tree *at swap time*, so it ships your work too — **don't start a second, you'll just be refused** |
| Nothing is `phase=awaiting` | `orient.sh` → no BLOCKED lines | **clear them first** — see below |
| Tree is coherent | no other agent mid-edit (`orient.sh`, recent mtimes) | wait for them to finish |

### Quiet is box-wide, not repo-wide

`deploy.sh` waits for `busy == 0` across **every session on the machine**, not just this repo's —
correct, because the restart kills all of them. So a stuck pane in an unrelated folder starves this
deploy.

**A pane at `phase=awaiting` is busy forever.** `s.busy` clears only on a `result` message, and
`canUseTool`'s promise never resolves until a human clicks. The auto-deny backstop in
`lib/agent/manager.ts` returns early at `if (s.subs.size !== 0) return` — it only rescues panes with
**no** subscribers (tab closed). An open tab sitting on a prompt is never rescued.

So `--wait` deadlocks: the deploy waits for the pane, the pane waits for Thomas. It burns the whole
window and aborts. **Never lengthen `--wait` to work around this** — that makes the deadlock longer,
not shorter. Clear the blocked panes, then deploy.

### Deploying is terminal

The swap kills the session that asked, so **you cannot observe your own outcome.** Everything
checkable must be checked *before*. After launching: say it's running, name the log
(`/tmp/minami-deploy.log`), say the panes will blink — then **stop**. Do not wait, poll, or report
success. Success is judged on a changed PID and a changed `BUILD_ID`, never on exit 0.

Thomas can check with `bash bin/deploy.sh --verify-only`. The result also lands in the dashboard's
bell (KNOWLEDGE.md §10) — written to disk by a process that outlives the server, which is the only
reason it survives.

---

## 6. Anti-patterns

| Never | Why | Instead |
|---|---|---|
| bare `npm run build` | replaces `.next` under the live server; it serves HTML referencing assets that no longer exist, every request 400s, survives reload | `npm run build:check` |
| `next dev` on `:3000` | Fast Refresh hot-patches hook signatures into the running page and crashes the tab you're working in | `npm run dev:iterate` (`:3001`) |
| `bin/serve.sh` from a pane | kills the turn that ran it | `bin/deploy.sh --detach` |
| `deploy.sh --force` to get past a busy box | cuts off live conversations mid-sentence | clear the blockers |
| lengthening `--wait` past a blocked pane | the deadlock is unbounded; waiting can't win | clear the `awaiting` panes |
| hardcoding a model id | session model and alert model drift apart | `lib/model-pins.ts` |
| leaving the base mid-merge | every other agent in the tree is now broken and nothing tells them | resolve, or `git merge --abort` — Autopilot holds the same invariant |

---

## When this skill changes

`bin/task.mjs` and `bin/deploy.sh` are the source of truth. If a lock path, refusal, or flag changes
there, update this file **in the same turn** — a stale workflow doc is worse than none, because the
next session trusts it. Subsystem changes also go in the record: see the `minami-kb` skill.
