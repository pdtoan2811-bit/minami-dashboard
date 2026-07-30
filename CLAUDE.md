# Minami Bento — project instructions

Local, real-time mission-control for Claude Code sessions. Next.js 15 (App Router) + Tailwind v4,
production-mode only, served on `:3000`.

## The one rule that matters most

**Every live chat session runs inside this Next.js server process**, and each session's `claude`
subprocess is a child of `next-server`. Restarting the server kills every in-flight turn on the machine
— including, quite possibly, the one you are running in right now.

- **Never run `bash bin/serve.sh` while a turn is in flight.** It refuses by default and names what's
  busy; `--force` overrides. Wait for idle, then the restart is clean (panes reattach from the on-disk
  JSONL and lose nothing).
- Don't use `next dev` on `:3000`. Fast Refresh hot-patches React hook signatures into the running page
  and crashes the tab you're working in. Use `npm run dev:iterate` (`:3001`, separate dist dir) to
  iterate on UI without touching the live instance.

## Applying changes

**If you are running inside a dashboard chat pane — which you almost always are — the only correct
command is:**

```
bash bin/deploy.sh --detach     # returns immediately; waits for quiet, swaps, verifies, logs
```

Then finish your reply. **Do not wait for it, poll it, or report success** — the swap kills this session,
so you cannot observe the outcome. Tell Thomas it's running and where the log is
(`~/.minami/deploy.log`), and that his panes will blink. He can check with
`bash bin/deploy.sh --verify-only`.

Running `bin/serve.sh` (or `deploy.sh` without `--detach`) from a pane kills the turn that asked for it.
`deploy.sh` walks its ancestry and auto-detaches if it catches you, but pass the flag deliberately.

From Finder/Terminal — not a child of the server — double-click **`Redeploy Minami.command`**, which is
interactive and prompts when other panes are busy. Full protocol: **`docs/DEPLOY.md`**.

The busy check runs **before** `npm run build` on purpose: `next build` replaces `.next` in place under
the running server, so that's the point of no return. Success is judged on a changed server PID and a
changed `BUILD_ID`, never on exit 0 — a build can succeed while the swap silently leaves the old process
serving.

### Never run bare `npm run build` on this box

To check that your change compiles, use **`npm run build:check`** (builds into `.next-verify`). A bare
`npm run build` overwrites `.next` **underneath the live server**, which keeps serving its old in-memory
manifests: the HTML it hands out then references CSS/JS hashes that no longer exist on disk, every asset
400s, and the dashboard renders as unstyled text that never hydrates — no tiles, no panes, no browser
preview. It looks exactly like "the app is broken", it survives a reload, and only a real restart fixes
it. `bin/deploy.sh` is allowed to do this because it restarts the server in the same breath.

## Conventions

- **Comments explain *why*, not *what*.** This codebase's comments carry hard-won reasoning (races,
  browser quirks, SDK semantics). Preserve that standard; a subtle fix without its rationale will be
  undone by the next person who finds it odd.
- **Server is the source of truth for live activity.** Activity state uses REPLACE semantics so a
  dropped SSE event self-heals on the next one. Don't add client-side derivation that can disagree.
- **Model pins live in `lib/model-pins.ts`** — never hardcode a model id elsewhere, so the session model
  and the model the dashboard *alerts on* can't drift apart.
- **`bypassPermissions` is the default permission mode** (`DEFAULT_PERMISSION_MODE` in
  `lib/agent/manager.ts`, override with `MINAMI_DASHBOARD_PERMISSION_MODE`). Every dashboard session
  auto-approves every tool with no prompt. The mode is enforced by the server's own `canUseTool`, not
  by the SDK — see §3 of `docs/KNOWLEDGE.md` for why. This raises the stakes on the next line.
- **Security posture is loopback/local-only.** The metrics API binds loopback; `/api/agent/health` uses a
  shared secret (`.minami-drain-token`). Do **not** gate a local endpoint on `Host` or
  `x-forwarded-for` — Next injects the latter from the socket and preserves a client-supplied value, so
  both are forgeable and neither proves locality.

## Keeping the record

`docs/KNOWLEDGE.md` is an **index**; the reasoning lives in `docs/knowledge/`, one file per subsystem,
plus `docs/knowledge/CHANGELOG.md`. `public/kb/` is the visual explainer. Read the index (~2.4k tokens)
and then only the file you need — the record used to be one 2,500-line file that cost ~46k tokens to
open, which is why nobody opened it.

Section numbers (`§5e`, `§8`, `§12`) are **stable ids** cited from code comments, and the index maps each
one to its file. Never recycle a number.

The `minami-kb` skill enforces the rule: **any turn that changes a subsystem updates that subsystem's
file in the same turn.** Bug found or fixed → add a `> 🐛` post-mortem. Module added/renamed → update
`lib/module-graph.ts`. New doc → add a row to the index's directory.
