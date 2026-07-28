import { subscribe, type AgentEvent } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/agent/stream?key=... → Server-Sent Events for one live session. Replays the recent buffer
// (so a late/reconnecting client catches init + in-flight deltas), then streams events as they land.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  // `attach=1` = "I'm reattaching to a session I believe is already running" (a page refresh). Only
  // then does a missing session mean anything: on the send path the client opens this stream and
  // POSTs its first message back-to-back, so "no session yet" just means the POST hasn't landed.
  const attaching = url.searchParams.get("attach") === "1";
  if (!key) return new Response("key required", { status: 400 });

  const encoder = new TextEncoder();
  let ping: ReturnType<typeof setInterval> | null = null;
  let unsubscribe = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (ev: AgentEvent | { t: "hello" }) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`)); } catch { /* closed */ }
      };
      send({ t: "hello" });
      const { replay, unsubscribe: off, exists } = subscribe(key, send);
      unsubscribe = off;
      if (!exists && attaching) send({ t: "detached" }); // the session ended — client falls back to the on-disk view
      for (const ev of replay) send(ev);
      ping = setInterval(() => { try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* closed */ } }, 20000);
    },
    cancel() {
      if (ping) clearInterval(ping);
      unsubscribe();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
