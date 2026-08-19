// Canvas state + live push.
//
// GET  /api/canvas            → current Graph (empty board before a meeting starts)
// POST /api/canvas            → replace the graph; body is a Graph
// POST /api/canvas?reset=1    → wipe back to an empty board
// GET  /api/canvas?stream=1   → SSE, one `data:` frame per revision
//
// Deliberately in-memory. A meeting canvas is live-only: it exists for the length of a call and the
// durable record is the vault note the pipeline writes afterwards. Persisting it would create a
// second store of client conversation data on a box that doesn't need one — the exact multi-copy
// drift problem we're avoiding elsewhere. Restart clears it; that is correct behaviour, not a gap.
import { type Graph } from "@/lib/canvas-graph";

export const dynamic = "force-dynamic";

/** A board with nothing on it yet.
 *
 *  ⚠️ The fallback used to be DEMO_GRAPH, and on the first real meeting that meant the bot
 *  screen-shared a fictional "QSortby · pilot scoping" board into the room for the half-minute before
 *  the first real card landed. The room's first impression of Minami was somebody else's invented
 *  data, presented as if it were theirs.
 *
 *  A demo board exists to judge composition. It must never be what a LIVE surface falls back to —
 *  the failure mode of a placeholder is that it is indistinguishable from real output. */
const EMPTY = (): Graph => ({
  // WALL CLOCK, NOT A COUNTER — see the note on doc.rev below.
  rev: Date.now(),
  title: "Meeting",
  status: "live",
  nodes: [{ id: "root", kind: "topic", label: "Meeting" }],
  edges: [],
});

/** On globalThis for the same reason the meeting sessions are: a Next dev hot-reload re-evaluates
 *  this module, and a plain module-level `doc` was therefore RESET to empty every time a file was
 *  touched. Observed repeatedly while building — a board with cards on it went blank because a
 *  comment was edited in an unrelated file. */
let doc: Graph =
  (globalThis as { __canvasDoc?: Graph }).__canvasDoc ??
  ((globalThis as { __canvasDoc?: Graph }).__canvasDoc = EMPTY());
const clients = new Set<(d: Graph) => void>();

export async function GET(req: Request) {
  const url = new URL(req.url);

  if (url.searchParams.get("stream") !== "1") {
    return Response.json(doc, { headers: { "cache-control": "no-store" } });
  }

  const encoder = new TextEncoder();
  let onCancel: (() => void) | undefined;
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

      // Captured for cancel(), below.
      onCancel = () => {
        clearInterval(beat);
        clients.delete(send);
      };
    },
    /** ⚠️ THIS IS WHERE A DISCONNECTED VIEWER IS ACTUALLY FORGOTTEN.
     *
     *  It used to `void reason` and nothing else, while the real cleanup was stashed on the
     *  CONTROLLER as `_cleanup` — a property nothing ever read (grep found one occurrence: the
     *  assignment). So `clients` only ever grew: every publish then paid a full JSON.stringify and a
     *  thrown enqueue per dead client, and the canvas reconnects on every SSE drop, so a long-running
     *  server accumulated them for its whole life. */
    cancel() {
      onCancel?.();
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

/** ⚠️ THIS IS THE SCREEN-SHARE SURFACE, AND IT HAD NO AUTH AT ALL.
 *
 *  /api/canvas/ingest fails closed and documents why: "publish arbitrary cards onto the canvas Minami
 *  screen-shares INTO a live meeting". But an attacker never needed ingest — they could POST the
 *  finished graph HERE, unauthenticated, and it fanned straight out to every SSE client including the
 *  tab being presented to a customer. The bearer token on ingest was only ever protecting the
 *  OpenRouter spend.
 *
 *  It matters because bin/serve.sh binds 0.0.0.0 "so the phone view works" — meaning anything on the
 *  Wi-Fi could reach it. A single POST with rev: MAX_SAFE_INTEGER also bricked every viewer, since
 *  clients drop lower revs.
 *
 *  Every legitimate caller is server-side and already holds the token: ingest publishes, control
 *  repaints, and the launcher resets. The browser only ever GETs. */
const TOKEN = process.env.CANVAS_INGEST_TOKEN || "";
const OPEN = process.env.CANVAS_INGEST_OPEN === "1";

export async function POST(req: Request) {
  if (!OPEN) {
    if (!TOKEN) return Response.json({ ok: false, error: "ingest token not configured" }, { status: 503 });
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
  }
  // A meeting must not open on the last meeting's board. The launcher calls this before the bot
  // joins, so whatever the room sees first is empty rather than a stranger's conversation.
  if (new URL(req.url).searchParams.get("reset") === "1") {
    doc = { ...EMPTY(), rev: Date.now() };
    (globalThis as { __canvasDoc?: Graph }).__canvasDoc = doc;
    for (const send of clients) send(doc);
    return Response.json({ ok: true, reset: true, rev: doc.rev });
  }

  let next: Graph;
  try {
    next = (await req.json()) as Graph;
  } catch {
    return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  if (!next || !Array.isArray(next.nodes)) {
    return Response.json({ ok: false, error: "expected { nodes: [...] }" }, { status: 400 });
  }

  /** ⚠️ rev MUST BE MONOTONIC ACROSS PROCESS RESTARTS, which a counter is not.
   *
   *  The client drops any frame whose rev is lower than the last one it accepted — correct, because a
   *  reconnect replays the seed and a stale seed must not overwrite a newer board. But rev was a
   *  COUNTER starting from 0 in a fresh process, while ingest publishes a timestamp. So when the
   *  server restarted, its rev fell from ~1.79e12 back to 1, and the client rejected EVERY frame from
   *  then on — permanently. Observed live on 2026-08-17: the shared tab sat on "Minami is listening"
   *  for a whole meeting while the server held 8 cards, and a freshly opened tab rendered them fine.
   *
   *  A wall-clock rev keeps rising across restarts, so the guard still rejects stale replays without
   *  ever locking the client out. */
  // Reject a frame older than the one we hold. Control's repaint and ingest's publish both stamp
  // rev at graph-build time, so a repaint built at t=99 can arrive after a judge's t=100 publish —
  // leaving the SERVER on the older board while clients correctly kept the newer one. A reconnect or
  // the polling fallback would then render a board missing the judge's cards.
  const nextRev = typeof next.rev === "number" ? next.rev : Date.now();
  if (nextRev < (doc.rev ?? 0)) {
    return Response.json({ ok: false, error: "stale revision", have: doc.rev, got: nextRev }, { status: 409 });
  }
  /** ⚠️ EQUAL REVS ARE A DROPPED FRAME, AND JUDGES NOW FINISH TOGETHER.
   *
   *  rev is a wall-clock millisecond and the client accepts only a STRICTLY GREATER one — so two
   *  publishes stamped in the same millisecond leave the second invisible until something else moves.
   *  That was rare while judges ran one at a time. They now run concurrently and routinely land in the
   *  same breath, which turns a theoretical tie into a recurring one.
   *
   *  Nudging forward keeps the wall-clock meaning (the debug panel reads rev as an age) while
   *  guaranteeing the strict monotonicity the client's guard requires. */
  const stamped = nextRev <= (doc.rev ?? 0) ? (doc.rev ?? 0) + 1 : nextRev;
  doc = { ...next, rev: stamped };
  (globalThis as { __canvasDoc?: Graph }).__canvasDoc = doc;
  for (const send of clients) send(doc);
  return Response.json({ ok: true, rev: doc.rev, clients: clients.size });
}
