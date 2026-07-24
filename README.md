# Minami Dashboard

A mobile-first visual companion for **Minami** (Thomas's assistant bot). Five views:

1. **Token log** — token + cost usage
2. **Task log** — qone tasks at a glance
3. **Trace-back** — chat → capture → where it lives in the vault
4. **Analytics** — projects, tasks, notes, capture rate
5. **People around me** — network

## Stack
Next.js 15 (App Router) · Tailwind v4 · shadcn/ui-style components · mobile-first.

## Run
```bash
npm install
npm run dev
```

## Data & privacy
This public repo ships **mock data only** (`lib/data.ts`). Real token/task/people
data loads at runtime from qone + the vault sync endpoint via env vars
(see `.env.example`) and is never committed. Even with a public repo, gate the
live deploy with `DASHBOARD_ACCESS_TOKEN`.

## Deploy
Import the repo into Vercel → add env vars → deploy. The URL is your mobile view.
