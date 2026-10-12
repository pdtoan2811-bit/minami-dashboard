// GET /api/meet/status?id=<phone meeting> — everything the phone needs to tell "nothing worth saying"
// from "I have stopped working" (§17b). Polled, not streamed: the phone already holds the board's SSE
// stream, and on Chrome every extra stream eats one of six connections per host (chrome-six-connections).
//
// The trace buffer is process-wide, not per meeting. That is fine for its job here — on the dashboard
// process the phone is the only thing producing canvas traffic; Recall meetings run on :3011.

import { latestMic, micStats } from "@/lib/meet-mic";
import { traceBuffer } from "@/lib/canvas-trace";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  // ?latest=1 — for a room screen opened before anyone pressed Start (/meet/screen). Ids only: the
  // screen goes on to /canvas, which already knows how to show a board.
  if (q.get("latest") === "1") {
    const l = latestMic();
    return Response.json({ ok: true, id: l?.id ?? null, title: l?.title ?? null }, { headers: { "cache-control": "no-store" } });
  }
  const id = q.get("id") || "";
  const stats = id ? micStats(id) : null;
  const since = stats?.startedAt ?? Date.now();
  const trace = traceBuffer().filter((e) => e.at >= since - 2000).slice(-40);
  return Response.json(
    {
      ok: true,
      now: Date.now(),
      stats,
      trace,
      ingestReady: Boolean(process.env.CANVAS_INGEST_TOKEN) || process.env.CANVAS_INGEST_OPEN === "1",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
