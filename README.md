# Minami Dashboard

Companion dashboard for the Minami second-brain bot: token log, task log,
trace-back (chat → capture → where it lives), analytics, and the people around Thomas.

- **Stack:** Next.js 15 (App Router, static export) + Tailwind v4 + shadcn-style UI, mobile-first.
- **Live app:** https://pdtoan2811-bit.github.io/minami-dashboard/
- **Deploy:** pushes to `main` build the app in CI and publish `./out` to GitHub Pages
  (see `.github/workflows/deploy.yml`). No manual build needed.

## Data

The public repo ships **mock data only** (`lib/data.ts`). Real values load at runtime
from qone / the vault sync endpoint via env vars (`.env.example`) and stay out of git.

## Local dev

```bash
npm install
npm run dev     # http://localhost:3000
npm run build   # static export to ./out
```
