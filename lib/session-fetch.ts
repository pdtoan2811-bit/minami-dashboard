// One request per transcript at a time, however many parts of the page want it.
//
// Measured 2026-09-23: switching to a one-chat tile fetched the same `/api/bento/session/<id>` three
// times in 150ms, and opening a four-chat tile fetched each transcript three or four times in five
// seconds. Four independent callers, none aware of the others: the tile-hover prefetch, the pane's own
// load on mount (and again when the effect re-runs as `agent.live` flips), the stream's `snapshot`
// resync, and the post-turn disk reconcile. Each was correct alone; together they multiplied the work
// of every switch.
//
// So callers share an IN-FLIGHT request — but only one fresh enough for them. Two callers carry a real
// freshness requirement, and ignoring it would be a correctness bug, not a missed optimisation:
//   - the snapshot resync must see disk at least as new as the snapshot, or a message flushed between
//     an older request and the snapshot silently goes missing until the next turn ends;
//   - the post-turn reconcile exists to read what the turn just wrote, so an older request is useless.
// Those pass `notBefore` (the moment their need arose) and only join a request started at or after it.
// Everyone else is a background refresh that the next poll corrects, and joins whatever is running.
//
// Nothing is cached after the request settles — that is transcriptCache's job in app/page.tsx. This
// module only removes duplicates that are in the air at the same moment.

const inflight = new Map<string, { at: number; p: Promise<any> }>();

// The DELTA half (§1, 2026-10-06). The last full-shape copy of each transcript this tab holds, so a poll
// can ask "anything since <size>, after my last turn?" and get { unchanged } or just the new turns,
// instead of the whole window every 2.5s (measured: 8.85 MB per round across ten chats, every round —
// docs/knowledge/bench/). Callers still receive the complete transcript: an unchanged answer resolves to
// the SAME object (so a pane's "did anything change" check stays cheap), a delta is merged here.
// Bounded like transcriptCache — older entries just mean that chat's next poll is a full one.
const last = new Map<string, any>();
const LAST_MAX = 24;
const KEEP_TURNS = 400; // the server's live-window cap (LIVE_WINDOW_TURNS) — don't grow past it

function remember(sid: string, d: any) {
  last.delete(sid); last.set(sid, d);
  if (last.size > LAST_MAX) last.delete(last.keys().next().value!);
  return d;
}

/** GET /api/bento/session/<sid> (the newest page, slim), coalesced with any in-flight request that
 *  started at or after `notBefore`. Resolves to the full parsed body; rejects like `fetch` would. */
export function fetchSession(sid: string, notBefore = 0): Promise<any> {
  const hit = inflight.get(sid);
  if (hit && hit.at >= notBefore) return hit.p;
  const at = Date.now();
  const prev = last.get(sid);
  const since = prev?.turns?.at(-1)?.off;
  const q = `slim=1${prev?.size != null ? `&size=${prev.size}` : ""}${prev && since != null ? `&since=${since}` : ""}`;
  const p = fetch(`/api/bento/session/${sid}?${q}`)
    .then((r) => r.json())
    .then((d) => {
      if (d?.unchanged && prev) return prev;
      if (d?.delta && prev && since != null) {
        // Keep everything before our last turn, then the server's copy of that turn onward (it may
        // have grown since we saw it).
        const turns = [...prev.turns.filter((t: { off?: number }) => (t.off ?? -1) < since), ...d.turns].slice(-KEEP_TURNS);
        const start = turns.length < prev.turns.length + d.turns.length - 1 ? (turns[0]?.off ?? d.start) : prev.start;
        return remember(sid, { ...prev, meta: d.meta ?? prev.meta, turns, start, hasMore: start > 0, size: d.size });
      }
      return d?.turns ? remember(sid, d) : d;
    })
    .finally(() => { if (inflight.get(sid)?.p === p) inflight.delete(sid); });
  inflight.set(sid, { at, p });
  return p;
}
