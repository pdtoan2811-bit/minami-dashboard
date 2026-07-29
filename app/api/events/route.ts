import { readEvents } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/events?after=<ms>&limit=<n> → { events: [...] } oldest-first.
//
// Polled rather than streamed, deliberately: the headline event is "the deploy finished", and the
// deploy restarts this server — an SSE stream would be severed at exactly the moment it had something
// to say. A poll just fails for a few seconds and then catches up from disk. See bin/minami-event.mjs.
export async function GET(req: Request) {
  try {
    const u = new URL(req.url);
    const after = Number(u.searchParams.get("after") || 0);
    const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit") || 50)));
    return Response.json({ events: readEvents({ limit, afterTs: Number.isFinite(after) ? after : 0 }) });
  } catch (e) {
    // Same reasoning as /api/agent/live: a continuously-polled route that returns Next's HTML error
    // page makes the client's .json() throw on a loop.
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
