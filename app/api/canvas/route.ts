// Canvas state + live push.
//
// GET  /api/canvas            → current Graph (falls back to the demo graph)
// POST /api/canvas            → replace the graph; body is a Graph
// GET  /api/canvas?stream=1   → SSE, one `data:` frame per revision
//
// Deliberately in-memory. A meeting canvas is live-only: it exists for the length of a call and the
// durable record is the vault note the pipeline writes afterwards. Persisting it would create a
// second store of client conversation data on a box that doesn't need one — the exact multi-copy
// drift problem we're avoiding elsewhere. Restart clears it; that is correct behaviour, not a gap.
import { DEMO_GRAPH, type Graph } from "@/lib/canvas-graph";

export const dynamic = "force-dynamic";

let doc: Graph = DEMO_GRAPH;
const clients = new Set<(d: Graph) => void>();

export async function GET(req: Request) {
  const url = new URL(req.url);

  if (url.searchParams.get("stream") !== "1") {
    return Response.json(doc, { headers: { "cache-control": "no-store" } });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (d: Graph) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(d)}\n\n`));
        } catch {
          /* client vanished mid-write; the cancel() below does the cleanup */
        }
      };
      send(doc); // seed immediately so a late joiner isn't staring at a blank screen share
      clients.add(send);

      // Proxies and load balancers close an idle event-stream well inside a meeting's length, and a
      // dead canvas on a client's screen is worse than a stale one. A comment frame is ignored by
      // EventSource but keeps the connection classified as active.
      const beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          clearInterval(beat);
        }
      }, 15000);

      (controller as unknown as { _cleanup?: () => void })._cleanup = () => {
        clearInterval(beat);
        clients.delete(send);
      };
    },
    cancel(reason) {
      void reason;
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx buffers proxied responses by default, which holds SSE frames back until the buffer
      // fills — i.e. the canvas would update in bursts, minutes late.
      "x-accel-buffering": "no",
    },
  });
}

export async function POST(req: Request) {
  let next: Graph;
  try {
    next = (await req.json()) as Graph;
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  if (!next || !Array.isArray(next.nodes)) {
    return Response.json({ ok: false, error: "expected { nodes: [...] }" }, { status: 400 });
  }

  doc = { ...next, rev: typeof next.rev === "number" ? next.rev : (doc.rev ?? 0) + 1 };
  for (const send of clients) send(doc);
  return Response.json({ ok: true, rev: doc.rev, clients: clients.size });
}
