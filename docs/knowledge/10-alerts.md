# Out-of-pane alerts

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 10. Out-of-pane alerts — `bin/minami-event.mjs`, `lib/events.ts`, `components/NotificationBell.tsx`

### The bell is anchored to the viewport, not to the bento

It used to live in the bento header with `ml-auto` — right-aligned inside a column whose width is a
*user preference*. Measured consequences: opening a project slid it **770 px** left (x=992 → x=222),
and collapsing the bento to a rail removed it **entirely**, because that header isn't rendered in rail
mode at all. A standing alert surface you reach for by muscle memory cannot live in a container that
moves, and one you cannot reach in a whole layout mode is worse than one that moves.

It is now a single `fixed right-3 top-2.5 z-[60]` mount at the page root: identical coordinates
(left 1236, top 10) in all three states, verified clickable in each with `elementFromPoint` rather than
by eye. `z-[60]` sits above the panel/bento headers (z-20/z-30) and below the lightbox and folder
picker (z-[90]/z-[100]), so a modal still covers it.

The two headers reserve its gutter rather than the bell knowing about them: the panel header uses
`pr-14` so `esc ✕` clears it, and the bento header uses `pr-16` **only when no project is open**, since
that is the sole state where the bento's right edge reaches the viewport corner.

**The condition:** the dashboard could already alert you — `lib/use-notify.ts` fires a native
notification plus a flashing tab title when a pane finishes a turn, needs approval, or asks a
question. But every one of those is produced *inside a React tree*, and the alert is deliberately
transient: suppressed while the tab is focused, and leaving nothing behind once it clears.

That covers none of the things that actually happen while you're away from the box:

| Event | Produced by | Previously visible as |
|---|---|---|
| Deploy live / verification failed | `bin/deploy.sh` (detached) | a line in `~/.minami/deploy.log` |
| Worktree build ✓ / failed | `bin/task.mjs build` | terminal scrollback of a pane you closed |
| Merge conflict on the base checkout | `bin/task.mjs merge` | ditto |

### Why it's a file, and why the server never writes it

The headline event is *"the deploy finished"* — and the deploy **restarts `next-server`**. Anything
held in the server's memory, or pushed down an open SSE stream, dies with the process that was
supposed to deliver it. The one moment you most need to be told something is the one moment the
messenger is guaranteed to be dead.

So the producer must **outlive** the server (a detached bash script appending to a file does), and the
consumer must be able to **catch up after reconnecting**. Hence:

```
deploy.sh ─┐
task.mjs ──┴─→ bin/minami-event.mjs ──→ ~/.minami/events.jsonl
                                              │  (read-only)
                          lib/events.ts ←─────┘
                                │
                     GET /api/events?after=<ms>
                                │
                     lib/use-events.ts (8s poll)
                                │
              NotificationBell + notify() toast
```

`bin/minami-event.mjs` is the **only** writer; `lib/events.ts` only reads. Nothing in the Next process
appends. As a side effect alerts are still recorded with `:3000` down entirely — the same property
`bin/task.mjs` deliberately has, for the same reason.

### Two cursors, both timestamps

`lib/use-events.ts` keeps two numbers in `localStorage`, and conflating them breaks the exact case the
feature exists for:

- **`notifiedTs`** — newest event already toasted.
- **`seenTs`** — newest event Thomas has actually *looked at* (set by opening the bell).

After a deploy the page re-mounts, refetches, and finds the "deploy live" event that landed while the
server was down. It must still be unread **and** must still toast — but not on the *next* remount. One
cursor cannot express that; two can. They're timestamps rather than an id set so the whole state is
two integers: two open tabs racing on the same key cost at most one suppressed toast, never a corrupt
list.

Timestamp cursors are also what make the log survive trimming. An offset/line-number cursor silently
rewinds by 100 events the moment `minami-event.mjs` rewrites the file, replaying alerts already read.

### Mechanics
- **Bounded log.** Trim to 500 when it crosses 600 — roughly one rewrite per hundred events. The
  rewrite is write-tmp-then-rename, so a reader never sees a half-written file; the cost is that an
  append landing inside the rename window is lost. A dropped alert is cheaper than a corrupt one.
- **Poll, don't stream** (`GET /api/events`) — an SSE stream would be severed at precisely the moment
  it had something to say. A poll just fails for a few seconds and catches up from disk.
- **REPLACE semantics**, matching activity state: the server's answer is the whole truth about the
  last 50 events, so no client-side accumulation can disagree with it.
- **Bodies are command output** — the verify table, the `tsc` error — rendered monospace with
  whitespace preserved. Reflowing them destroys the only thing they're good for.

### Gotchas
- **A brand-new browser profile has `notifiedTs = 0`, so the entire backlog looks fresh.** It's
  adopted silently instead of announced; nothing about a week-old deploy is news. The events still
  count as unread in the bell, which is `seenTs` — a different question.
- **Opening the panel *is* the acknowledgement.** There's no separate "mark read" to forget. A
  consequence: an event arriving while the panel is open is marked read immediately.
- `--verify-only` deliberately emits nothing. It's a manual probe, not an update.

> 🐛 **Every deploy on this box had been reporting "verification FAILED" while serving perfectly.**
> An ambient `DEPLOY_PROBES="/api/fs/mkdir:400,…"` was exported into the environment. `/api/fs/mkdir`
> is POST-only, so a GET answers **405**, not 400 — the probe list had gone stale against the routes it
> described. `deploy.sh` already supported `400|405` alternatives, but the *default* lived in an
> environment variable outside the repo, where nothing updates it when a route changes. Fixed by moving
> the default into `deploy.sh` itself (env still overrides for one-offs): a probe list is a fact about
> the repo's routes, so it belongs with the repo and moves when they do. Caught while wiring this
> section — a false "deploy failed" alert is worse than no alert, because it trains you to ignore the
> bell.

---
