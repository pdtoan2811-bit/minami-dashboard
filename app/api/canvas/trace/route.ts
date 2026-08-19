// GET /api/canvas/trace — what the pipeline has been doing, for the canvas debug panel.
//
// Read-only. The buffer itself lives in lib/canvas-trace so the ingest hot path can push to it
// without importing a route module.

import { traceBuffer } from "@/lib/canvas-trace";

const LOCAL = process.env.CANVAS_LOCAL_CONTROL === "1";
const TOKEN = process.env.CANVAS_INGEST_TOKEN || "";

function localOrigin(req: Request): boolean {
  const o = req.headers.get("origin") || req.headers.get("referer") || "";
  try {
    const h = new URL(o).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch { return false; }
}

export async function GET(req: Request) {
  // The trace quotes transcript fragments, so it is gated exactly like the meetings archive.
  const ok = (TOKEN && req.headers.get("authorization") === `Bearer ${TOKEN}`) || (LOCAL && localOrigin(req));
  if (!ok) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  return Response.json({ ok: true, events: traceBuffer() });
}
