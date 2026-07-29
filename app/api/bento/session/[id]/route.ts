import { getSession } from "@/lib/claude-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// `?before=<byteOffset>` asks for the history page immediately preceding an offset the client already
// holds (a previous page's `start`). Without it you get the live tail. Splitting it this way is what
// keeps the 2.5s poll cheap while still making the whole transcript reachable: the tail is re-read
// incrementally on every poll, a history page is read once and cached forever — transcripts are
// append-only, so anything below the tail can never change.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const raw = new URL(req.url).searchParams.get("before");
    const n = raw === null ? NaN : Number(raw);
    // Only a finite positive offset means anything. Anything else falls through to the tail rather than
    // being treated as `before=0`, which would silently return an empty page and look like "no history".
    const before = Number.isFinite(n) && n > 0 ? n : undefined;
    return Response.json(getSession(id, before === undefined ? undefined : { before }));
  } catch {
    return Response.json({ meta: null, turns: [], start: 0, hasMore: false });
  }
}
