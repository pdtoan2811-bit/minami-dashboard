# Setting up Minami Bento

Bento is a **local** dashboard + control panel for your Claude Code sessions. It reads
`~/.claude/projects` on your machine and (optionally) drives live sessions via the Agent SDK. This
guide gets you from zero to running, and includes a prompt you can hand to Claude Code to do it all
for you.

---

## ⚡️ One-shot with Claude Code

If you have Claude Code installed, paste this into a Claude Code session and it will set everything up:

> Clone `https://github.com/pdtoan2811-bit/minami-dashboard`, run `npm install`, then start it with
> `npm run dev` and tell me the URL. It's a Next.js app — a local dashboard for my Claude Code
> sessions. It needs **no** environment variables to run the home page. After it's running, confirm
> that opening `http://localhost:3000` shows my sessions as tiles. If port 3000 is busy, start it on
> another port and tell me which. Don't change any of my `~/.claude` settings.

That's genuinely all it takes — the Bento home works with zero config because it reads your local
`~/.claude/projects` directly.

---

## 🧑‍💻 Manual setup

### Prerequisites
- **Node.js 18.18+** (20+ recommended) — `node -v`
- **Claude Code CLI**, installed and logged in — `claude --version`, then `claude` once to sign in.
  Bento's live-drive feature uses this login (no API key needed).

### Run it
```bash
git clone https://github.com/pdtoan2811-bit/minami-dashboard
cd minami-dashboard
npm install
npm run dev        # → http://localhost:3000
```

Open **http://localhost:3000**. Every Claude Code project on your machine appears as a tile. Click one
to open its chats; type in the composer to drive a live session.

For a production build:
```bash
npm run build && npm start
```

> **Run it locally.** Bento reads your home directory, so it only shows your sessions on the machine
> where you actually use Claude Code. A cloud deploy (Vercel, etc.) can host the `/dashboard` metrics
> view but never the local session mirror.

---

## ⚙️ Optional configuration

Everything below is optional — copy `.env.example` to `.env.local` and fill in only what you want.

| What | Env var | Notes |
|---|---|---|
| Cross-machine usage metrics | `NEXT_PUBLIC_METRICS_URL`, `NEXT_PUBLIC_METRICS_KEY` | Powers the `/dashboard` heatmap & live routing. Needs the metrics server — see [`server/README.md`](server/README.md). |
| Personal side panels | `MINAMI_PANELS_FILE` | Absolute path to a JSON file for the Task/People/Trace-back/Analytics cards. See [`panels.example.json`](panels.example.json). |

### Theme
Change `--sakura` (accent) and `--bento-bg` (backdrop) at the top of
[`app/globals.css`](app/globals.css) — the whole UI follows.

### Tech icons
Brand icons for the repo/tech bar live in `public/tech-icons.json`, generated from
[simple-icons](https://simpleicons.org). To add more, edit the `WANT` list in
[`bin/build-tech-icons.mjs`](bin/build-tech-icons.mjs) and run `node bin/build-tech-icons.mjs`.

---

## 🚀 Optional: cross-machine metrics server

To see live token usage and model-routing savings across **all** your machines on the `/dashboard`
page, run the tiny zero-dependency collector. Full walkthrough (with a Claude-Code-friendly script) in
**[`server/README.md`](server/README.md)**. In short:

1. On a always-on box (or just your Mac), run `server/metrics-server.js` behind a systemd unit.
2. Add the `Stop` hook (`server/usage-hook.py`) to each machine's `~/.claude/settings.json`.
3. Point `NEXT_PUBLIC_METRICS_URL` at the collector.

---

## 🩺 Troubleshooting

| Symptom | Fix |
|---|---|
| Home page is empty | You have no Claude Code sessions in the selected time window, or you're not running Bento on the machine where you use Claude Code. Widen the window (top-right) or start a session. |
| "No metrics source connected" on `/dashboard` | Expected until you set up the metrics server and `NEXT_PUBLIC_METRICS_URL`. The rest of the page still works. |
| Live chat says a process error | Ensure `claude` is on your `PATH` and you're logged in (`claude` once in a terminal). Bento shells out to it. |
| Port 3000 in use | `npm run dev -- -p 3001` (or any free port). |
| Icons/accent look wrong after an edit | Restart the dev server so Tailwind rebuilds. |

---

## What runs where

```
Your machine
├─ ~/.claude/projects/*.jsonl      ← Claude Code writes these; Bento reads them
├─ Bento (Next.js, localhost:3000) ← the app: grid, chat panel, live drive
│    └─ shells out to `claude`      ← for semantic labels + live sessions (your login)
└─ (optional) metrics server        ← usage collector for /dashboard
```

No data leaves your machine unless you deliberately deploy the dashboard or run the metrics server.
