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

## Local dev

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # production build
```
