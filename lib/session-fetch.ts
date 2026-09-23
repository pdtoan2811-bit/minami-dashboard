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

/** GET /api/bento/session/<sid> (the newest page), coalesced with any in-flight request that started
 *  at or after `notBefore`. Resolves to the parsed body; rejects like `fetch` would. */
export function fetchSession(sid: string, notBefore = 0): Promise<any> {
  const hit = inflight.get(sid);
  if (hit && hit.at >= notBefore) return hit.p;
  const at = Date.now();
  const p = fetch(`/api/bento/session/${sid}`)
    .then((r) => r.json())
    .finally(() => { if (inflight.get(sid)?.p === p) inflight.delete(sid); });
  inflight.set(sid, { at, p });
  return p;
}
