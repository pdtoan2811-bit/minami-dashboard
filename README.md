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
| **Chat side-panel** | Slide-in transcript per project, live-tailing. Up to two parallel chats per project. Markdown + `highlight.js` code blocks. Draggable, persisted width. |
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

That's the whole thing. No env vars required for the Bento home. For a production build:

```bash
npm run build && npm start
```

> **Deploying to Vercel etc. won't show your sessions** — a cloud host has no access to your home
> directory. Bento is a local tool by design. Deploy only the `/dashboard` metrics view if you want a
> remote read-out (see the metrics server).

## Configuration

All optional. Copy `.env.example` to `.env.local` and fill in what you want.

| Env var | Used by | What it does |
|---|---|---|
| `NEXT_PUBLIC_METRICS_URL` | `/dashboard` | Base URL of the metrics API (see [`server/`](server/README.md)). Unset → metrics cards show "no source". |
| `NEXT_PUBLIC_METRICS_KEY` | `/dashboard` | Read key for the metrics API (`?k=`). Obscurity only — gate the deploy for real privacy. |
| `MINAMI_PANELS_FILE` | `/dashboard` | Absolute path to a JSON file backing the Task/People/Trace-back/Analytics cards. See [`panels.example.json`](panels.example.json). Unset → those cards are empty. |

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

## Roadmap

- **Phase 1 — Observe (now).** Read-only mirror: live grid, semantic titles, per-session
  tokens/cost/tier, transcript side-panel, cross-machine metrics.
- **Phase 2 — Drive (next).** Wire the chat composer to `@anthropic-ai/claude-agent-sdk` so you can
  send messages, approve permissions (default / acceptEdits / plan — never bypass), add files, and use
  tools — a full alternative to CLI windows.
- **Phase 3 — Share.** Per-topic thumbnails and open-source packaging.

## Tech

Next.js 15 (App Router, React 19) · Tailwind v4 · framer-motion · highlight.js · lucide-react.

## License

Not yet licensed — all rights reserved for now. A proper open-source license will be added; until
then, treat the code as source-available (read and learn, but no redistribution). If you want to use
it, open an issue.
