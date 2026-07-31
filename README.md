# Minami Bento 🌸

**A local, real-time mission-control for your Claude Code sessions.**

Every Claude Code conversation running on your machine becomes a live **bento tile** — one glance
replaces hunting across a dozen terminal windows. Click a tile and a chat side-panel slides in with
that session's transcript, live-tailing. An optional metrics layer adds cross-machine token usage and
model-routing analytics.

It runs entirely on your own machine against `~/.claude/projects` — no account, no cloud, nothing
leaves your laptop unless you opt into the metrics server.

> _Minami is the author's personal second-brain bot; Bento started as its dashboard. The tool itself
> is generic — it works for anyone who uses Claude Code, with zero configuration._

---

## Why

Claude Code is fantastic, but once you run several sessions at once you **lose the thread** — which
window was doing what, which one is waiting on you, how much each is spending. Bento gives you a
single board:

- **See everything at once.** Projects are tiles; tile size reflects how busy each project is.
- **Know what needs you.** Status pills (`live` / `recent` / `review`) and dimming surface the
  sessions waiting on a decision; quiet ones fade back.
- **Read any session instantly.** Click a tile → the transcript opens in a side-panel, rendered as
  clean Markdown with syntax-highlighted code. Tool logs are hidden by default (toggle in Settings).
- **Spend less without noticing.** The optional metrics layer shows real token usage per machine and
  what your model-routing is saving versus running everything on the top tier.

## Features

| | |
|---|---|
| **Bento home** (`/`) | Live grid of every local Claude Code project. Weighted tile sizes, keyboard nav (`↑↓←→` / `Tab`, `↵` open, `esc` close), search, sort (Recent / Busy / A–Z), configurable time window. |
| **Chat side-panel** | Slide-in transcript per project, live-tailing. Rich rendering — GFM tables, task lists, blockquotes, links, and syntax-highlighted code with copy. |
| **Up to 4 chats · 2×2 grid** | Open several chats of a topic at once, like windows on a foldable. Clicking a tile restores its recent chats (within the date filter); your open/closed layout is remembered per topic; add any chat from a picker. |
| **New topic + folder picker** | A `＋ New topic` tile starts a fresh chat in any folder you browse to — no existing session required. Don't have a folder yet? Create one from the picker (`＋ folder`, or type a path and hit **Create this folder**). The topic gets its tile as soon as you send the first message; its name is the folder's own name. |
| **Repo & tech attach bar** | Each topic shows its git repo (link) and the tech it uses (Shopify, ClickHouse, BigQuery, Google Cloud, …) as brand icons, detected from `.git`, `package.json`, and config files. |
| **Live drive** (Phase 2) | Actually run Claude Code from the panel — send messages, watch tokens stream in, and approve/deny tool calls inline. `Plan`/`Code` toggle (default Code) + approval level (`ask` / `auto-edits`), with a live "what it's doing" hint that tells cold-start (`starting session…`) apart from mid-turn thinking, escalates ("still working…") past a minute, and flashes the tab title if you've wandered off. A live checklist tracks the agent's TodoWrite plan as it works, not just the current tool. Uses your existing Claude login (no API key). |
| **Browser tool** | Every live-driven chat gets a headless, isolated browser (Playwright MCP) so Claude can navigate/click/type/screenshot — built for QA-testing your own apps. Because it's headless, the docked panel *is* the browser window: URL bar, device presets, screenshot filmstrip, console/network/actions drawer, full-screen lightbox, and a pop-out window. Gated by your normal permission mode, with per-host "allow all" for QA runs. See [Browser tool](#browser-tool) below. |
| **Semantic labels** | Sessions are grouped **Project › Goal › Task** and flagged for review by a cheap local Haiku pass (uses your Claude subscription via the `claude` CLI — no API key). Cached to disk; curate by hand or via the `bento-taxonomy` skill. |
| **Metrics** (`/dashboard`) | Usage heatmap (cohort calendar), live model-routing feed, per-machine usage, routing table + savings. Optional — needs the metrics server below. |
| **Pluggable panels** | Task log / Trace-back / Analytics / People read from a JSON file you provide (`MINAMI_PANELS_FILE`). Empty and harmless by default. |
| **Settings** (`/settings`) | Default time window, show/hide tool logs. Stored in the browser. |

## Quickstart

Bento reads your **local** `~/.claude/projects`, so run it on the machine where you use Claude Code.

```bash
git clone https://github.com/pdtoan2811-bit/minami-dashboard.git
cd minami-dashboard
npm install
npm run dev          # → http://localhost:3000  (your sessions appear as tiles)
```

That's the whole thing. No env vars required for the Bento home. `npm install` also downloads a
headless Chromium for the [browser tool](#browser-tool) (~one-time, a bit slow on the first install) —
skip it with `MINAMI_DISABLE_BROWSER_TOOL=1` if you don't want it. For a production build:

```bash
npm run build && npm start
```

> New here? **[SETUP.md](SETUP.md)** has a full walkthrough — including a prompt you can paste into
> Claude Code to have it set Bento up for you.

### Reading a transcript from the terminal

The UI pages history in on demand. When you want the *whole* conversation — piped, grepped, or with
the app down — use the CLI. No server, no caps, streams a 64 MB transcript in a quarter-second:

```bash
node bin/transcript.mjs list                      # every session, newest first
node bin/transcript.mjs show <id>                 # whole conversation (an id prefix is enough)
node bin/transcript.mjs show <id> --tail 20 --tools
node bin/transcript.mjs show <id> --format md --out chat.md
node bin/transcript.mjs show <id> --format json | jq -r 'select(.role=="user") | .text'
```

> **Deploying to Vercel etc. won't show your sessions** — a cloud host has no access to your home
> directory. Bento is a local tool by design. Deploy only the `/dashboard` metrics view if you want a
> remote read-out (see the metrics server).

### Shipping a change to the running instance

Live chats run *inside* the server process, so a restart ends every in-flight turn — including, if you
asked for the deploy from a chat pane, the one asking. Hence one wrapper and two entry points:

```bash
bash bin/deploy.sh --detach     # from a dashboard chat pane: waits for quiet, swaps, verifies
bash bin/deploy.sh --verify-only # what's actually serving right now
```

or double-click **`Redeploy Minami.command`** from Finder, which runs interactively and asks before
cutting off busy panes. Full protocol and failure modes: **[docs/DEPLOY.md](docs/DEPLOY.md)**.

### Working on two things at once

Two chat panes on one project share a working tree and a branch — so they overwrite each other's edits
with no conflict and no warning. Give each its own checkout instead:

```bash
node bin/task.mjs new browser-fix       # git worktree + branch, prints its own preview port
node bin/task.mjs list                  # branch · commits ahead · dirt · which have a live agent
node bin/task.mjs preview browser-fix   # build + serve it on that port — :3000 untouched
node bin/task.mjs merge browser-fix     # verify → build → merge into base (serialised)
```

Point a pane at `.minami-worktrees/<name>` and that agent physically cannot touch another's files.
Integration happens at the merge, where a collision is a *conflict git can show you* rather than a
silent loss. The dashboard also warns when more than one agent is live in the same folder.

## Configuration

All optional. Copy `.env.example` to `.env.local` and fill in what you want.

| Env var | Used by | What it does |
|---|---|---|
| `NEXT_PUBLIC_METRICS_URL` | `/dashboard` | Base URL of the metrics API (see [`server/`](server/README.md)). Unset → metrics cards show "no source". |
| `NEXT_PUBLIC_METRICS_KEY` | `/dashboard` | Read key for the metrics API (`?k=`). Obscurity only — gate the deploy for real privacy. |
| `MINAMI_PANELS_FILE` | `/dashboard` | Absolute path to a JSON file backing the Task/People/Trace-back/Analytics cards. See [`panels.example.json`](panels.example.json). Unset → those cards are empty. |
| `MINAMI_DISABLE_BROWSER_TOOL` | live-drive sessions | Set to `1` to stop giving live-driven chats the [browser tool](#browser-tool). Unset → enabled (it's deferred behind tool search, so a chat that never uses it costs ~nothing). |

### Theming

The entire look lives in two CSS variables at the top of [`app/globals.css`](app/globals.css):
`--sakura` (the accent) and `--bento-bg` (the backdrop). Change them once and the whole UI follows —
there are no hard-coded colours scattered through the components.

### Project icons

Tiles pick a 3D icon by matching keywords in the project's folder name (`web`, `app`, `data`, `ai`,
`design`, …), so it works for any project out of the box. To pin a specific project to a specific
icon, add an entry to `ICON_OVERRIDES` in [`app/page.tsx`](app/page.tsx). Assets are from
[3dicons.co](https://3dicons.co) and live in `public/icons/`.

## Optional: cross-machine metrics

The `/dashboard` view (usage heatmap, live routing, savings) is powered by a tiny self-hosted
collector that gathers Claude Code token usage from **every machine you use** — via a `Stop` hook —
and serves live aggregates over SSE. Zero dependencies (Node's `http` + a JSONL file). Full setup in
**[`server/README.md`](server/README.md)**.

## Architecture

```
~/.claude/projects/*.jsonl ──► lib/claude-sessions.ts ──► /api/bento/* ──► Bento UI (app/page.tsx)
   (Claude Code writes these)     (parse + summarize)      (Node runtime)     (live grid + chat panel)
                                          │
                                          └─► lib/bento-enrich.ts ──► local `claude -p` (Haiku)
                                                (Project›Goal›Task + needs-review, cached to disk)

[optional metrics]
  every machine ──Stop hook──► server/metrics-server.js ──SSE / REST──► /dashboard
```

- **`app/page.tsx`** — the Bento home (grid, chat side-panel, Markdown renderer).
- **`app/dashboard/`** — metrics view. **`app/settings/`** — preferences.
- **`lib/claude-sessions.ts`** — server-only reader/summarizer for `~/.claude/projects`.
- **`lib/bento-enrich.ts`** — semantic layer (Haiku, cached).
- **`lib/routing.ts`** — the single source of truth for model prices & routing rules.
- **`lib/panels.ts`** — pluggable data source for the personal cards.
- **`server/`** — the optional metrics collector (Node, systemd unit, Stop hook).

## Driving sessions (live)

The chat composer runs Claude Code directly via [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).
Type a message → it streams the reply token-by-token, shows tool activity, and — for anything that
needs approval — pauses with an inline **Approve / Deny** prompt. New chats start a fresh session in
the project's directory; opening an existing chat and sending **resumes** it. Every turn is persisted
to `~/.claude/projects/…` exactly like the CLI, so history is never lost.

**Permission modes** (pick per chat): `default` asks before risky tools · `acceptEdits` auto-approves
file edits · `plan` proposes without applying. `bypassPermissions` is intentionally **not selectable**
— the server clamps any other value to `default`. Because it loads your own settings
(`~/.claude`, project `.claude`), your existing allow-rules, `CLAUDE.md`, and MCP servers all apply,
just like the terminal. It drives the **local** machine, so it only works when you run Bento locally.

### "What's it doing" hints

The activity line under a busy pane (and the composer status line, and the bento tile's dot) tells a
few situations apart instead of one flat "thinking…":

- **Cold start vs. mid-turn.** The very first message to a session spins up a fresh SDK process
  (usually 1-2s) — that shows as `starting session…` → `loading context…`, distinct from ordinary
  between-tool-calls thinking, so a fresh chat doesn't read as "stuck" the way a slow tool call would.
- **Escalating reassurance.** Past 30s of the same phase it adds a quiet `· still working…`; past 2
  minutes, `· longer tasks can take a few minutes` — a hint, not a replacement for the specific "what
  it's doing" label next to it.
- **Live plan checklist.** Pinned above the composer whenever the agent has an active TodoWrite plan —
  what's done, what's in progress, what's left — not just the current tool name.
- **Away-tab notifications.** If a pane finishes a turn, or needs an approval/answer, while you're on
  another tab or app, the browser tab title flashes and (if you've granted permission, asked on first
  Send) a native notification fires. Silent while you're actually looking at the tab.

### Browser tool

Every live-driven chat is handed a browser (via the official [`@playwright/mcp`](https://www.npmjs.com/package/@playwright/mcp)
server, headless + isolated per session — nothing shared between chats) so Claude can navigate, click,
type, and screenshot — built for having it QA-test your own apps rather than general web automation.
It's just another tool: gated by whatever permission mode the chat is in, same Approve/Deny prompt as
anything else. Browser prompts get a plain-English one, though: *"Claude wants to fill in a form on
localhost:3000"*, with an **Allow all on localhost:3000** button that auto-approves the rest of that
host for the life of the pane — approving thirty clicks one at a time isn't a QA pass.

Once a pane's used it, a **browser panel** docks beside that chat. Because the browser is headless,
the panel *is* the browser window:

| | |
|---|---|
| **Toolbar** | Editable URL bar, back / forward / reload, a ⧉ to open the page in your own browser, device presets (Desktop / Laptop / iPad / iPhone), a ⏺ record button, and a console-error badge. None of these touch the browser directly — they ask Claude, the same way Claude Code treats navigation as a tool call. |
| **Viewport** | The latest screenshot, letterboxed. Shows how many actions old it is, and says so plainly when Claude is reading the page as an accessibility tree instead (with a one-click *Ask for a screenshot*). |
| **Filmstrip** | Every screenshot in the session. Click to pin one, *back to live* to follow the newest again. |
| **Drawer** | Console, Network, and an Actions log of every `browser_*` call with pass/fail and duration. |

Click the viewport (or any screenshot in the transcript) for a **full-screen lightbox** — zoom, pan,
`←`/`→` to step through the filmstrip, `Esc` to close. Full-resolution pixels are read back from
`<cwd>/.playwright-mcp/`, so they survive a page reload; the inline copies don't. Drag the divider to
resize, `▥` to move the panel below the chat instead of beside it, and `⧉` to pop it into its own
window (handy on a second monitor — it's read-only there). Turn the whole tool off with
`MINAMI_DISABLE_BROWSER_TOOL=1`.

## Roadmap

- **Phase 1 — Observe.** ✅ Read-only mirror: live grid, semantic titles, per-session
  tokens/cost/tier, transcript side-panel, cross-machine metrics.
- **Phase 2 — Drive.** ✅ Send messages, stream replies, approve/deny tools, permission modes,
  resume — a real alternative to CLI windows.
- **Phase 3 — Share (in progress).** ✅ Richer "what's it doing" hints (cold-start vs. thinking,
  escalating reassurance, live plan checklist, away-tab notifications). ✅ Browser tool (Playwright MCP)
  with a full browser panel — toolbar, filmstrip, console/network, lightbox, pop-out — for QA-testing
  your own apps. Next: letting the panel drive the browser directly (Playwright MCP over `--port` with a
  shared context, so the view is live rather than screenshot-by-screenshot and you can click through it
  yourself), optional attach-to-your-real-Chrome via `--extension`, per-topic thumbnails, file
  attachments in chat, open-source packaging.

## Tech

Next.js 15 (App Router, React 19) · Tailwind v4 · framer-motion · highlight.js · lucide-react ·
`@anthropic-ai/claude-agent-sdk` (live drive) · `@playwright/mcp` (browser tool).

## License

[MIT](LICENSE) — use it, fork it, ship it. No attribution required beyond keeping the copyright
notice in copies of the source.

### Third-party assets

The 3D tile icons in `public/icons/` (182 icons × 2 camera angles) are from
[3dicons](https://3dicons.co) by Vijay Verma, released under **CC0** — public domain, no attribution
required, commercial use fine. The credit here is courtesy, not obligation, and nothing about the
set constrains what you do with this repo.

Brand/tech glyphs come from [simple-icons](https://github.com/simple-icons/simple-icons) (CC0), built
into `public/tech-icons.json` by `bin/build-tech-icons.mjs`.
