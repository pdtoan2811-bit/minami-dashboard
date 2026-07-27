# Contributing to Minami Bento

Thanks for taking a look! This is a small, focused project — a local dashboard for Claude Code
sessions. Contributions, bug reports, and ideas are welcome.

> **License note:** the project isn't formally licensed yet (see the README). If you'd like to
> build on it, open an issue first so we can sort that out.

## Getting set up

```bash
git clone https://github.com/pdtoan2811-bit/minami-dashboard.git
cd minami-dashboard
npm install
npm run dev     # http://localhost:3000
```

The Bento home reads your real `~/.claude/projects`, so you'll see your own sessions immediately —
no fixtures or seed data needed. If you don't use Claude Code yet, the grid will just be empty.

Useful scripts:

| Command | What |
|---|---|
| `npm run dev` | Dev server with hot reload. |
| `npm run build` | Production build — **run this before every PR**; it type-checks and lints. |
| `npm start` | Serve the production build (most reliable for verifying behaviour). |
| `npm run lint` | ESLint via `next lint`. |

## Project layout

```
app/
  page.tsx          Bento home — grid, chat side-panel, Markdown renderer
  dashboard/        Metrics view (usage heatmap, live routing, savings)
  settings/         Preferences (stored in the browser)
  api/bento/        Node-runtime routes over ~/.claude/projects (read-only mirror)
  api/agent/        Node-runtime routes that DRIVE live sessions (send/stream/permission/mode)
lib/
  claude-sessions.ts  Read + summarize session transcripts (server-only)
  bento-enrich.ts     Semantic Project›Goal›Task layer (local Haiku, cached)
  routing.ts          Single source of truth for model prices & routing rules
  panels.ts           Pluggable JSON data source for the personal cards
  sources.ts          Machine-label map for the metrics cards
  agent/manager.ts    Live-session engine over @anthropic-ai/claude-agent-sdk (Phase 2, server-only)
  use-agent.ts        Client hook that drives one pane (send / stream / permission)
  use-settings.ts     localStorage-backed settings hook
components/          UI pieces (Nav, RoutingFlow, UsagePanel, UsageHeatmap, …)
server/             Optional zero-dep metrics collector (Node + systemd + Stop hook)
public/icons/       3D icons from 3dicons.co
```

**Live drive & safety.** `lib/agent/manager.ts` is the only place that talks to the Agent SDK. It
keeps a `query()` alive per pane, streams events over SSE, and blocks on `canUseTool` for the approval
prompt. Never pass `bypassPermissions` to the SDK — `safeMode()` clamps anything outside
`default | acceptEdits | plan`. The SDK pulls in a transitive `@hono/node-server` advisory
(path traversal, **Windows-only**); we don't run its static server and don't downgrade the SDK for it.

## Conventions

- **TypeScript, strict.** No `any` in new code unless a file already opts out at the top.
- **Server vs client.** Anything reading the filesystem (`~/.claude/projects`, the panels file) must
  stay server-only — inside `lib/*` used by `app/api/*` or server components, never imported into a
  `"use client"` file.
- **Theming.** Don't hard-code colours. Use `--sakura` / `--bento-bg` from `app/globals.css`
  (`bg-[var(--sakura)]`, `.bg-bento`). One place to restyle the whole app.
- **Model prices live in one place** — `lib/routing.ts`. `server/metrics-server.js` keeps its own copy
  only because it's a standalone zero-dependency file; if you change prices, change both and note it.
- **Keep it dependency-light.** The metrics server has zero deps on purpose. Think twice before adding
  a package to the app.
- **Match the surrounding style** — the codebase favours compact, commented modules over sprawl.

## Pull requests

1. Branch off `main`.
2. `npm run build` must pass (types + lint) and the pages should render.
3. Describe what changed and how you verified it. Screenshots help for UI changes.
4. Keep PRs focused — one concern at a time.

## Reporting bugs

Open an issue with: what you expected, what happened, your OS, Node version, and whether it's the
Bento home or the metrics view. A snippet of the browser console / server log is gold.
