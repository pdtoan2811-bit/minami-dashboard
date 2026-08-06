# Minami Bento — instructions for Claude

Local, real-time mission-control for Claude Code sessions. Next.js 15 (App Router) + Tailwind v4.

This file is split deliberately. **Part 1 is true in any clone.** **Part 2 is only true on the
author's machine**, where the dashboard runs as a long-lived server that hosts live chat sessions —
following it anywhere else will have you looking for files that don't exist.

**Decide which half applies before you act:**

```bash
test -d ~/.minami && echo "Part 2 applies" || echo "fresh clone — Part 1 only"
```

If `~/.minami` is absent you are in an ordinary checkout: run the app with `npm run dev`, ignore
Part 2 entirely, and none of the deploy ceremony applies to you.

---

# Part 1 — any clone

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

No environment variables are needed for the home page — it reads `~/.claude/projects` directly, so
the board fills with your own Claude Code sessions immediately. Node 18.18+ (20+ recommended), and
the Claude Code CLI logged in if you want to drive live sessions. Full walkthrough: `SETUP.md`.
User-facing feature tour: `README.md`. Contribution norms: `CONTRIBUTING.md`.

**Every knob is an env var, and `.env.example` is the complete list** — all of them optional, each
one documented with its built-in default. Nothing in this repo is pinned to the author's machine:
paths default relative to `$HOME`, model ids all resolve through `lib/model-pins.ts`, and no personal
account is compiled in (the wrong-account check stays dormant until you choose one in Settings). If
you are asked to configure something, read `.env.example` first — if a value you need isn't there,
that's a bug in the file, not a value to hardcode.

## Checking that a change compiles

```bash
npm run build:check   # builds into .next-verify
```

Prefer this over `npm run build` even in a fresh clone — it leaves `.next` intact, so a running
`npm run dev` / `npm start` isn't disturbed by a type check. On the author's box it is mandatory, for
a sharper reason; see Part 2.

## The three pipelines

Most confusion about this codebase comes from reading one and assuming it explains another.

```
LIVE      browser pane → /api/agent/send → lib/agent/manager.ts → Agent SDK → claude CLI
                       ← /api/agent/stream (SSE) ←

READ      claude CLI writes ~/.claude/projects/*.jsonl
          → lib/claude-sessions.ts (incremental parse + 3 caches) → /api/bento/* → grid tiles

METRICS   Stop hook on every machine → server/metrics-server.js → events.jsonl → /dashboard cards
```

The live and read pipelines meet only on disk. They never call each other.

**Agents** (`lib/agents/*`, `/agents`, opt-in in Settings) sit on top of both rather than beside them:
an agent is an identity plus a *home folder* it remembers in, and an assigned task is an ordinary live
session keyed `agent:<id>:<taskId>` whose transcript the read pipeline then attributes back to it. See
`docs/knowledge/14-agents.md` before changing anything there — particularly why its task runner polls
instead of subscribing.

**Teams** (`lib/teams/*`, `/teams`, same Settings toggle) sit on the agent layer rather than beside it:
a template's roles become standing agents, and a run is one stage per role — each a separate session in
that role's own folder, all appending to one dossier on disk. Every stage goes through `assign()`, so
there is no second way to start a session. `docs/knowledge/15-teams.md`.

## Conventions

- **Comments explain *why*, not *what*.** This codebase's comments carry hard-won reasoning (races,
  browser quirks, SDK semantics). Preserve that standard; a subtle fix without its rationale will be
  undone by the next person who finds it odd.
- **Server is the source of truth for live activity.** Activity state uses REPLACE semantics so a
  dropped SSE event self-heals on the next one. Don't add client-side derivation that can disagree.
- **Model pins live in `lib/model-pins.ts`** — never hardcode a model id elsewhere, so the session
  model and the model the dashboard *alerts on* can't drift apart.
- **`bypassPermissions` is the default permission mode** (`DEFAULT_PERMISSION_MODE` in
  `lib/agent/manager.ts`, override with `MINAMI_DASHBOARD_PERMISSION_MODE`). Every dashboard session
  auto-approves every tool with no prompt, enforced by the server's own `canUseTool` rather than by
  the SDK — see §3 of the knowledge record for why. This raises the stakes on the next line.
- **Security posture is loopback/local-only.** The metrics API binds loopback; `/api/agent/health`
  uses a shared secret. Do **not** gate a local endpoint on `Host` or `x-forwarded-for` — Next
  injects the latter from the socket and preserves a client-supplied value, so both are forgeable and
  neither proves locality.

## Keeping the record

`docs/KNOWLEDGE.md` is an **index**; the reasoning lives in `docs/knowledge/`, one file per
subsystem, plus `docs/knowledge/CHANGELOG.md`. `public/kb/` is the visual explainer (`npm run kb` →
`localhost:4400`, which works while the app is down). Read the index (~2.4k tokens) and then only the
file you need — the record used to be one 2,500-line file that cost ~46k tokens to open, which is why
nobody opened it.

Section numbers (`§5e`, `§8`, `§12`) are **stable ids** cited from code comments, and the index maps
each one to its file. Never recycle a number.

**The rule: any turn that changes a subsystem updates that subsystem's file in the same turn.** Bug
found or fixed → add a `> 🐛` post-mortem. Module added/renamed → update `lib/module-graph.ts`. New
doc → add a row to the index's directory. The `minami-kb` skill carries the full procedure and loads
itself when relevant.

## Skills in this repo

`.claude/skills/` is checked in, so these load automatically for anyone working in the clone:

| Skill | Use when |
|---|---|
| `minami-kb` | A subsystem changes, a bug is found or fixed, or you're asked why something is built this way. |
| `minami-flow` | Before substantive work ("do I need a worktree?") and before shipping. Assumes Part 2's constraints. |
| `bento-icons` | A topic shows the wrong icon, or you're adding brand/tech icons. |
| `bento-taxonomy` | Re-labelling the Project > Goal > Task grouping. |

---

# Part 2 — the author's box only

> Everything below assumes a long-lived production server on `:3000` that **hosts live chat sessions
> as child processes**, plus `~/.minami/` for its logs and state. On a fresh clone none of that
> exists, and `bin/serve.sh` / `bin/deploy.sh` are not how you run the app — `npm run dev` is.

## The one rule that matters most

**Every live chat session runs inside this Next.js server process**, and each session's `claude`
subprocess is a child of `next-server`. Restarting the server kills every in-flight turn on the
machine — including, quite possibly, the one you are running in right now.

- **Never run `bash bin/serve.sh` while a turn is in flight.** It refuses by default and names what's
  busy; `--force` overrides. Wait for idle, then the restart is clean (panes reattach from the
  on-disk JSONL and lose nothing).
- Don't use `next dev` on `:3000`. Fast Refresh hot-patches React hook signatures into the running
  page and crashes the tab you're working in. Use `npm run dev:iterate` (`:3001`, separate dist dir)
  to iterate on UI without touching the live instance.

## Applying changes

**If you are running inside a dashboard chat pane — which on this box you almost always are — the
only correct command is:**

```
bash bin/deploy.sh --detach     # returns immediately; waits for quiet, swaps, verifies, logs
```

Then finish your reply. **Do not wait for it, poll it, or report success** — the swap kills this
session, so you cannot observe the outcome. Say it's running, name the log (`~/.minami/deploy.log`),
and note that the panes will blink. Verify afterwards with `bash bin/deploy.sh --verify-only`.

Running `bin/serve.sh` (or `deploy.sh` without `--detach`) from a pane kills the turn that asked for
it. `deploy.sh` walks its ancestry and auto-detaches if it catches you, but pass the flag
deliberately.

From Finder/Terminal — not a child of the server — double-click **`Redeploy Minami.command`**, which
is interactive and prompts when other panes are busy. Full protocol: **`docs/DEPLOY.md`**.

The busy check runs **before** `npm run build` on purpose: `next build` replaces `.next` in place
under the running server, so that's the point of no return. Success is judged on a changed server PID
and a changed `BUILD_ID`, never on exit 0 — a build can succeed while the swap silently leaves the
old process serving.

`deploy.sh` builds the **working tree**, not `HEAD`. A checkout dirty with another session's
in-flight edits ships those too, so check `git status` before shipping.

### Never run bare `npm run build` on this box

Use **`npm run build:check`** (builds into `.next-verify`). A bare `npm run build` overwrites `.next`
**underneath the live server**, which keeps serving its old in-memory manifests: the HTML it hands
out then references CSS/JS hashes that no longer exist on disk, every asset 400s, and the dashboard
renders as unstyled text that never hydrates — no tiles, no panes, no browser preview. It looks
exactly like "the app is broken", it survives a reload, and only a real restart fixes it.
`bin/deploy.sh` is allowed to do this because it restarts the server in the same breath.

## Sharing the checkout

Several chat panes edit these same files at once. Orient before the first edit and again before
shipping:

```bash
bash .claude/skills/minami-flow/orient.sh
```

Two or more sessions in the tree means work in a worktree (`node bin/task.mjs new <name>`), always.
The `minami-flow` skill has the full decision table, the merge gates and the deploy gate.
