"use client";
// The meeting canvas — the page Recall.ai streams as Minami's screen share.
//
// Three modes, one route:
//   /canvas              live — renders whatever Graph the producer last POSTed (SSE)
//   /canvas?demo=1       frozen overview, for judging composition
//   /canvas?play=pilot   scripted meeting + operator panel, for judging the CHOREOGRAPHY
//
// Only the first is ever shared. The panel in play mode is explicitly not part of the stream — see
// the note in TranscriptPanel. Light surface by deliberate exception to the app's dark theme: the
// audience is customers, and a dark node graph reads as a developer tool.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_GRAPH, type GNode, type Graph } from "@/lib/canvas-graph";
import { GraphCanvas } from "@/components/canvas/GraphCanvas";
import { TranscriptPanel, type Segment } from "@/components/canvas/TranscriptPanel";

export default function CanvasPage() {
  const [graph, setGraph] = useState<Graph>(DEMO_GRAPH);
  const [mode, setMode] = useState<"live" | "demo" | "play">("live");
  const rev = useRef(DEMO_GRAPH.rev ?? 0);

  useEffect(() => {
    const q = new URL(window.location.href).searchParams;
    // ?live=1 (or ?play= for muscle memory) opens the real-audio view.
    if (q.get("live") || q.get("play")) { setMode("play"); return; }
    if (q.get("demo") === "1") { setMode("demo"); setGraph({ ...DEMO_GRAPH, focus: undefined }); return; }
    if (q.get("demo") === "focus") { setMode("demo"); return; }

    const es = new EventSource("/api/canvas?stream=1");
    es.onmessage = (e) => {
      try {
        const next = JSON.parse(e.data) as Graph;
        if (!Array.isArray(next.nodes)) return;
        // Guard out-of-order frames: a reconnect replays the seed, and without this a stale seed
        // could overwrite a newer map mid-meeting.
        if ((next.rev ?? 0) >= rev.current) { rev.current = next.rev ?? 0; setGraph(next); }
      } catch {
        /* a malformed frame must never blank a live screen share — keep the last good graph */
      }
    };
    es.onerror = () => {};
    return () => es.close();
  }, []);

  if (mode === "play") return <AudioMode />;
  return (
    <main className="canvas-surface relative h-dvh w-dvw overflow-hidden">
      <Stage graph={graph} />
    </main>
  );
}

/** Canvas + floating chrome. Shared by every mode so the shared view and the demo view can't drift. */
function Stage({ graph }: { graph: Graph }) {
  const status = graph.status ?? "live";
  return (
    <>
      <GraphCanvas graph={graph} />
      {/* Scrim under the floating chrome. The camera can only keep the FOCUSED neighbourhood clear of
          the header; a card from an unrelated branch can still sit at those coordinates, and the
          title then renders on top of it and becomes unreadable. A soft fade keeps the type legible
          whatever slides underneath, without drawing a hard bar across the canvas. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-32"
        style={{ background: "linear-gradient(to bottom, rgba(244,244,242,0.92), rgba(244,244,242,0))" }}
      />
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-6 p-7">
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-semibold tracking-[-0.01em] text-neutral-800">
            {graph.title ?? "Meeting"}
          </h1>
          {graph.subtitle ? <p className="mt-0.5 truncate text-[13px] text-neutral-500">{graph.subtitle}</p> : null}
        </div>
        <span className="flex shrink-0 items-center gap-2 rounded-full bg-white/85 px-3 py-1.5 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_4px_12px_-4px_rgba(16,24,40,0.10)] backdrop-blur">
          <span className="size-1.5 rounded-full" style={{ background: status === "live" ? "#1baf7a" : "#a3a3a3" }} />
          <span className="text-[12px] font-medium capitalize text-neutral-600">{status}</span>
          <span className="text-[12px] text-neutral-300">·</span>
          <span className="text-[12px] text-neutral-500">Minami</span>
        </span>
      </header>
      {graph.reaction ? <Reaction kind={graph.reaction.kind} label={graph.reaction.label} /> : null}
    </>
  );
}

/** Real audio ingest.
 *
 *  Replaces the scripted player entirely. Nothing here is pre-authored: the audio is transcribed by
 *  mimo, mimo decides what is worth keeping, and the server validates every action before it touches
 *  the board. What you watch is what the model actually did.
 *
 *  Everything arrives over one SSE stream, so the transcript and the canvas can never disagree about
 *  what happened — the same events drive both. */
function AudioMode() {
  const [graph, setGraph] = useState<Graph>({ nodes: [{ id: "root", kind: "topic", label: "Meeting" }] });
  const [segments, setSegments] = useState<Segment[]>([]);
  const [running, setRunning] = useState(false);
  const [minutes, setMinutes] = useState(1);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setRunning(false);
  }, []);

  const run = useCallback((mins: number) => {
    stop();
    setMinutes(mins);
    setSegments([]);
    setProgress(null);
    setError(null);
    setGraph({ nodes: [{ id: "root", kind: "topic", label: "Meeting" }], status: "live" });
    setRunning(true);

    const es = new EventSource(`/api/canvas/live?minutes=${mins}`);
    esRef.current = es;

    let total = 0;
    let done = 0;
    // Buffer the transcript for a chunk until its actions arrive, so a segment renders as one
    // complete unit — line plus what it caused — rather than text first and consequences later.
    let held: { at: string; lines: string[] } | null = null;

    es.addEventListener("meta", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      total = d.chunks;
      setProgress({ done: 0, total });
    });

    es.addEventListener("transcript", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      held = { at: d.at, lines: d.lines };
    });

    es.addEventListener("graph", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setGraph(d.graph);
      if (held) {
        const seg = held;
        setSegments((s) => [...s, { at: seg.at, lines: seg.lines, actions: d.actions, dropped: d.dropped }]);
        held = null;
      }
      done += 1;
      setProgress({ done, total });
    });

    es.addEventListener("fail", (e) => {
      setError(JSON.parse((e as MessageEvent).data).error);
      stop();
    });

    es.addEventListener("done", () => stop());

    // EventSource retries on its own; on a finished stream that would restart the whole run, which
    // would silently re-bill the transcription. Close instead and let the user press again.
    es.onerror = () => stop();
  }, [stop]);

  useEffect(() => () => { esRef.current?.close(); }, []);

  return (
    <main className="flex h-dvh w-dvw overflow-hidden">
      <div className="canvas-surface relative min-w-0 flex-1">
        <Stage graph={graph} />
      </div>
      <TranscriptPanel
        segments={segments}
        running={running}
        minutes={minutes}
        progress={progress}
        error={error}
        onRun={run}
        onStop={stop}
      />
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
