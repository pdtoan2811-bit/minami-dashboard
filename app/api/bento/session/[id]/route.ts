import { getSession } from "@/lib/claude-sessions";
import { slimTurns } from "@/lib/transcript-slim";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// `?before=<byteOffset>` asks for the history page immediately preceding an offset the client already
// holds (a previous page's `start`). Without it you get the live tail. Splitting it this way is what
// keeps the 2.5s poll cheap while still making the whole transcript reachable: the tail is re-read
// incrementally on every poll, a history page is read once and cached forever — transcripts are
// append-only, so anything below the tail can never change.
//
// The poll protocol (§1, 2026-10-06 — measured before/after in docs/knowledge/bench/):
//   ?slim=1          images travel as URLs, not base64 (lib/transcript-slim.ts)
//   &size=<n>        the file size the client's copy was built from. Unchanged → { unchanged: true, size }:
//                    a few bytes instead of re-sending the whole window every 2.5s.
//   &since=<off>     the `off` of the client's LAST turn. Changed → { delta: true, turns } with only the
//                    turns from that offset on (that last turn included: it may still be growing). The
//                    client keeps its turns before `since` and appends these.
// Anything the server can't prove is a pure append — the client's turn isn't in the window any more,
// the file shrank (rewritten) — gets the full window, exactly as before. Without these params the route
// answers as it always did, so an old tab keeps working through a deploy.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const q = new URL(req.url).searchParams;
    const num = (k: string) => { const raw = q.get(k); const n = raw === null ? NaN : Number(raw); return Number.isFinite(n) && n >= 0 ? n : undefined; };
    // Only a finite positive offset means anything. Anything else falls through to the tail rather than
    // being treated as `before=0`, which would silently return an empty page and look like "no history".
    const beforeN = num("before");
    const before = beforeN !== undefined && beforeN > 0 ? beforeN : undefined;
    const slim = q.get("slim") === "1";
    const page = getSession(id, before === undefined ? undefined : { before });
    const out = (turns: typeof page.turns) => (slim ? slimTurns(turns, id, before) : turns);

    if (before === undefined && slim) {
      const size = num("size"), since = num("since");
      if (size !== undefined && page.size !== undefined && size === page.size) return Response.json({ unchanged: true, size: page.size });
      if (since !== undefined && page.size !== undefined && (size === undefined || page.size > size)) {
        const at = page.turns.findIndex((t) => t.off === since);
        if (at >= 0) return Response.json({ delta: true, meta: page.meta, turns: out(page.turns.slice(at)), start: page.start, hasMore: page.hasMore, size: page.size });
      }
    }
    return Response.json({ ...page, turns: out(page.turns) });
  } catch {
    return Response.json({ meta: null, turns: [], start: 0, hasMore: false });
  }
}
