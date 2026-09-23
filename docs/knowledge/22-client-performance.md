# Client performance — why switching tiles is cheap, and how to keep it that way

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 22. Client performance

The server is not where this app is slow. Measured 2026-09-23 on the live box:
`/api/bento/session/<id>` returns its windowed tail in **under 50 ms even for a 169 MB transcript**
(the windowed parser and caches in §2 do their job), the board list takes 15–130 ms, and the server
idles at ~150 MB RSS. Every cost below was in the browser. Look there first.

### How it was measured — reuse this, don't eyeball it

A Playwright script clicks between two tiles the way a person does and records, per click: time
until the pane shows no "Loading transcript…", every `/api/` request with its offset from the click,
and every main-thread **long task** (a `PerformanceObserver` on `"longtask"` — blocks over 50 ms, the
jank you can feel). A second pass sits idle for 20 s counting requests, DOM mutations and long tasks.
The script lives in the 2026-09-23 audit transcript; the shape is ~40 lines and worth rebuilding
rather than trusting a feeling.

**Measure against a production build, never `next dev`.** The dev server compiled a single route for
over 100 s during this audit; numbers from it describe the compiler, not the app. And never start a
second production server on this checkout without `MINAMI_AUTOPILOT_DISABLE=1` — see §13's 🐛 below.

What it found, before the fixes:

| click | to transcript | requests | main-thread stalls |
|---|---|---|---|
| open storyboardAI (4 chats), first time | 4.7 s | ~30; each transcript fetched 3–4× in 5 s | 1,028 ms, one of 530 ms |
| switch to a 1-chat tile | 490 ms | same transcript 3× in 150 ms | 90 ms |
| **back** to storyboardAI | 600 ms | everything again: 4 transcripts ×2, 4 streams re-opened, previews re-downloaded | 159 ms |
| idle, 20 s | — | 26 API calls, `/api/agent/live` every 1.5 s | none |

### Mechanics

**Tiles you just left stay mounted (`parked`, `app/page.tsx`).** Switching tiles used to call
`setPanes(newTile)`, which unmounted every chat of the old one — transcript state, open stream,
scroll. Coming back rebuilt all of it. Now `openProject` moves the tile being left into `parked`
(max `PARK_MAX` = 2), and the chat grid renders the active tile's panes **and** every parked tile's
panes, the parked ones with `collapsed` (which is `display:none`, the same mechanism a zoomed-in tile
already used to keep its other chats alive). Returning restores the *same Pane objects*, so React sees
the same keys and reuses the live components: no fetch, no reconnect, scroll where you left it.

Three things in that are load-bearing and look optional:

- **One flat keyed array.** React matches keys within a single children array. Rendering parked
  chats in a second `.map()` — or under any other parent — remounts them on every switch, which is
  the entire cost this removes. The grid maps `[...active, ...parked]` in one pass.
- **Park and restore in the same event.** `setParked` and `setPanes` are batched in `openProject`, so
  there is no render in which a chat is in neither list. A version that parked in an effect would
  unmount first and park second.
- **Parked chats receive the same props they had on screen.** `sessions`, `cwd`, `showTools` are
  looked up live for the parked tile, not blanked. A chat whose `sessions` goes to `[]` re-derives
  its cwd, and that is a respawn, not a hide. The one callback that stays live is `onLive`: a new
  chat can learn its session id while you look elsewhere, and dropping it is the "chat was thrown
  away" bug described at `openProject`'s `allBlank` guard. It writes both `parked` and `openPanesMap`.

Bounded because a parked chat keeps its SSE stream attached, which also keeps the server from
reaping that session (`IDLE_REAP_MS` counts listeners). Worst case is 12 chats mounted (3 tiles ×
`MAX_PANES`). Verified on a side instance: mounted count went 5 → 9 → 9 → 6 as tiles aged out,
always exactly one visible. `closePanel` clears the list, since the grid unmounts with the panel.

**One transcript request at a time (`lib/session-fetch.ts`).** Four callers fetched the same URL,
unaware of each other: the tile-hover prefetch, the pane's mount load (and its re-run when
`agent.live` flips), the stream-snapshot resync, and the post-turn reconcile. `fetchSession(sid,
notBefore)` joins an in-flight request **only if it started at or after `notBefore`**. That
parameter is not tuning — two callers need it for correctness. The snapshot resync must see disk at
least as new as the snapshot, or a message flushed between an older request and the snapshot goes
missing until the next turn ends; the reconcile exists to read what the turn just wrote. Everyone
else passes nothing and joins whatever is running. Nothing is cached after settling; that is
`transcriptCache`'s job.

**Polls stop when nobody is looking (`lib/page-visible.ts`).** Sessions (5 s), live activity
(1.5 s), Autopilot (10 s), events and account status now skip their tick while the tab is hidden and
re-run the moment it is visible. The first load always runs — a tab opened in the background still
needs a board. A pane's own transcript poll (2.5 s) also skips while the pane is `collapsed`, which
covers parked tiles. SSE streams are deliberately not paused: pushed, free while quiet, and pausing
one drops the events that make a pane correct when you return.

The pane's refresh-on-show is a **separate effect reading `loadRef`**, not `collapsed` added to the
load effect's deps. That effect repaints from `transcriptCache` on every run; if the transcript had
been evicted from that LRU, re-running it on un-hide would blank the pane parking exists to keep warm.

### After

Same script, production build on a side port:

| click | streams re-opened | transcript fetches | stalls |
|---|---|---|---|
| open storyboardAI, cold | 4 | 4 (one per chat; was 13–16) | 174 ms (was 1,028) |
| **back** to storyboardAI | **0** (was 4) | **1** — the visible tab's refresh (was 8) | **0** (was 159) |
| **back** to a 1-chat tile | **0** (was 1) | 1 | 0 |

Time-to-transcript on a return was at the script's ~120 ms measurement floor. The side instance had
no live sessions, so the cold-open *time* is not comparable with the live box's 4.7 s (no snapshot
resyncs, no screenshot previews); the request and stream counts are, and they are the evidence.

### Gotchas

> 🐛 **The blur fix that never reached the Autopilot tile (found 2026-09-23).** §5e measured a
> `backdrop-filter` box with a pulsing descendant at 30.6% GPU against 4.6% without — the filter
> re-blurs its whole box every frame the dot animates — and the project tiles and side panel lost
> their blur for it. `components/AutopilotTile.tsx` kept `backdrop-blur` on its wrapper *and* pulses
> its status dot whenever Autopilot is on, which is its normal state: a permanent per-frame re-blur,
> on the one tile that is always on the board. On the day of the audit Chrome's GPU process had sat
> above 100% CPU for over two hours on a machine at load average 65. Nothing ties that to this one
> tile yet — the GPU process is shared by every tab — so re-check it after the fix is live.
> The rule, stated for the next tile: **nothing that animates may sit inside a `backdrop-filter`**,
> and a new surface does not get blur unless there is something non-flat behind it to blur.

- The dev instance and a measurement instance must set `MINAMI_AUTOPILOT_DISABLE=1` (dev:iterate now
  does). §13.
- `transcriptCache` is an LRU (`TS_MAX`). Anything that "re-runs the paint" can blank a pane whose
  entry was evicted — prefer refs over deps when a hidden/shown transition just needs a refresh.

### Not done — next, in order

- **Mount a multi-chat tile's focused chat first**, the rest after paint. The cold open of a four-chat
  tile still mounts four transcripts in one commit.
- **`React.memo` on `ChatColumn`; move `liveAct`/`paneAct` out of `BentoHome` state.** Any real change
  in either re-renders every tile (each with a Framer Motion `layout`) and every open chat.
- `useMemo` the per-render session sort in `ChatColumn`; throttle the streaming reply's Markdown,
  which re-parses the whole accumulated text on every token.
