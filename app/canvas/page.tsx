"use client";
// The meeting canvas — the page Recall.ai streams as Minami's screen share.
//
// It renders one thing: whatever Graph the producer last POSTed. No navigation, no controls, no
// hover states. Anything clickable here is a lie, because everyone who sees this page sees it as
// pixels in someone else's video tile.
//
// Light surface by deliberate exception to the app's dark theme — see .canvas-surface in
// globals.css. The audience is customers, and a dark node graph reads as a developer tool.
import { useEffect, useRef, useState } from "react";
import { DEMO_GRAPH, type Graph } from "@/lib/canvas-graph";
import { GraphCanvas } from "@/components/canvas/GraphCanvas";

export default function CanvasPage() {
  const [graph, setGraph] = useState<Graph>(DEMO_GRAPH);
  const rev = useRef(DEMO_GRAPH.rev ?? 0);

  useEffect(() => {
    const demo = new URL(window.location.href).searchParams.get("demo");
    // ?demo=1 drops `focus` so the camera sits back and frames the WHOLE map — that's the view you
    // need to judge composition. ?demo=focus keeps it, to check the follow-the-conversation shot.
    if (demo === "1") { setGraph({ ...DEMO_GRAPH, focus: undefined }); return; }
    if (demo === "focus") return;

    const es = new EventSource("/api/canvas?stream=1");
    es.onmessage = (e) => {
      try {
        const next = JSON.parse(e.data) as Graph;
        if (!Array.isArray(next.nodes)) return; // ignore anything that isn't a graph
        // Guard against out-of-order frames: a reconnect replays the seed, and without this a stale
        // seed could overwrite a newer map mid-meeting.
        if ((next.rev ?? 0) >= rev.current) {
          rev.current = next.rev ?? 0;
          setGraph(next);
        }
      } catch {
        /* a malformed frame must never blank a live screen share — keep the last good graph */
      }
    };
    es.onerror = () => {}; // EventSource reconnects itself; not fatal
    return () => es.close();
  }, []);

  const status = graph.status ?? "live";

  return (
    <main className="canvas-surface relative h-dvh w-dvw overflow-hidden">
      <GraphCanvas graph={graph} />

      {/* Chrome floats above the canvas and never moves — the map moves underneath it. */}
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-6 p-7">
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-semibold tracking-[-0.01em] text-neutral-800">
            {graph.title ?? "Meeting"}
          </h1>
          {graph.subtitle ? <p className="mt-0.5 truncate text-[13px] text-neutral-500">{graph.subtitle}</p> : null}
        </div>
        <span className="flex shrink-0 items-center gap-2 rounded-full bg-white/85 px-3 py-1.5 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_4px_12px_-4px_rgba(16,24,40,0.10)] backdrop-blur">
          <span
            className="size-1.5 rounded-full"
            style={{ background: status === "live" ? "#1baf7a" : "#a3a3a3" }}
          />
          <span className="text-[12px] font-medium capitalize text-neutral-600">{status}</span>
          <span className="text-[12px] text-neutral-300">·</span>
          <span className="text-[12px] text-neutral-500">Minami</span>
        </span>
      </header>

      {graph.reaction ? <Reaction kind={graph.reaction.kind} label={graph.reaction.label} /> : null}
    </main>
  );
}

/** Full-canvas moment. A wash rather than a modal: the map stays visible through it, so the
 *  celebration lands without hiding the thing being celebrated. */
function Reaction({ kind, label }: { kind: "handshake" | "highfive" | "spark"; label?: string }) {
  const glyph = kind === "handshake" ? "🤝" : kind === "highfive" ? "🙌" : "✨";
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      <div className="absolute inset-0 bg-white/45 [animation:nodeIn_var(--dur-3)_var(--ease-out)_both]" />
      <div className="[animation:nodeIn_var(--dur-4)_var(--ease-spring)_both] relative flex flex-col items-center gap-2.5">
        <span className="text-[76px] leading-none drop-shadow-sm">{glyph}</span>
        {label ? (
          <span className="rounded-full bg-white px-5 py-2 text-[17px] font-semibold text-neutral-800 shadow-[0_2px_4px_rgba(16,24,40,0.08),0_12px_28px_-8px_rgba(16,24,40,0.18)]">
            {label}
          </span>
        ) : null}
      </div>
    </div>
  );
}
