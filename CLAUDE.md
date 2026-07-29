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

```
bash bin/serve.sh          # build + drain + swap. The only supported deploy path.
```

The busy check runs **before** `npm run build` on purpose: `next build` replaces `.next` in place under
the running server, so that's the point of no return.

## Conventions

- **Comments explain *why*, not *what*.** This codebase's comments carry hard-won reasoning (races,
  browser quirks, SDK semantics). Preserve that standard; a subtle fix without its rationale will be
  undone by the next person who finds it odd.
- **Server is the source of truth for live activity.** Activity state uses REPLACE semantics so a
  dropped SSE event self-heals on the next one. Don't add client-side derivation that can disagree.
- **Model pins live in `lib/model-pins.ts`** — never hardcode a model id elsewhere, so the session model
  and the model the dashboard *alerts on* can't drift apart.
- **Security posture is loopback/local-only.** The metrics API binds loopback; `/api/agent/health` uses a
  shared secret (`.minami-drain-token`). Do **not** gate a local endpoint on `Host` or
  `x-forwarded-for` — Next injects the latter from the socket and preserves a client-supplied value, so
  both are forgeable and neither proves locality.

## Keeping the record

`docs/KNOWLEDGE.md` is the living reasoning record and `public/kb/` the visual explainer. The
`minami-kb` skill enforces the rule: **any turn that changes a subsystem updates the record in the same
turn.** Bug found or fixed → add a post-mortem. Module added/renamed → update the graph.
