# Minami Dashboard

Companion dashboard for the Minami second-brain bot: live model routing, model-routing docs,
token log, task log, trace-back (chat → capture → where it lives), analytics, and the people
around Thomas.

- **Stack:** Next.js 15 (App Router) + Tailwind v4 + shadcn-style UI, mobile-first.
- **Deploy:** [Vercel](https://vercel.com) — native Next.js runtime, auto-deploys on push to `main`.
  (GitHub Pages / static export was retired.)

## Data

The repo ships **mock data only** (`lib/data.ts`) plus the real model-routing table + prices
(`lib/routing.ts`, safe to publish). Sensitive values (real spend, task titles, people) load at
runtime from qone / the vault sync endpoint via env vars (`.env.example`) and stay out of git.

## Bento — local mission control for Claude Code  (`/bento`)

An immersive, full-screen grid where **every Claude Code session on your machine is a live tile** —
one glance replaces hunting across terminal windows. Click / press `↵` on a tile and the grid slides
left to reveal a peek panel with that session's messages + tool log, live-tailing.

- **Local-only.** Bento mirrors `~/.claude/projects/*.jsonl`, so it only works when you run it on the
  machine where you use Claude Code — not on the Vercel deploy (which has no access to your home dir).
- **Phase 1 (now):** read-only mirror — grid, semantic titles, per-session tokens/cost/tier, keyboard
  nav (`↑↓←→` / `Tab`, `↵` open, `esc` close), slide-in peek with transcript + expandable tool calls.
- **Phase 2 (next):** wire the peek panel to `@anthropic-ai/claude-agent-sdk` so you can chat, approve
  permissions, pick a permission mode, add files, and use tools — the full alternative to CLI windows.

```bash
npm install
npm run dev     # http://localhost:3000/bento   ← run locally to mirror your sessions
npm run build   # production build
```
