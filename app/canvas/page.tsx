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
import { DEMO_BY_ID, DEMOS, type Action } from "@/lib/canvas-demos";
import { GraphCanvas } from "@/components/canvas/GraphCanvas";
import { TranscriptPanel, type Spoken } from "@/components/canvas/TranscriptPanel";

export default function CanvasPage() {
  const [graph, setGraph] = useState<Graph>(DEMO_GRAPH);
  const [mode, setMode] = useState<"live" | "demo" | "play">("live");
  const [scriptId, setScriptId] = useState("pilot");
  const rev = useRef(DEMO_GRAPH.rev ?? 0);

  useEffect(() => {
    const q = new URL(window.location.href).searchParams;
    const play = q.get("play");
    if (play) { setMode("play"); setScriptId(DEMO_BY_ID.has(play) ? play : "pilot"); return; }
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

  if (mode === "play") {
    return <PlayMode scriptId={scriptId} onPick={setScriptId} />;
  }
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

/** Scripted playback. The script is the single source for both the map and the panel, so what the
 *  panel claims Minami did is necessarily what actually happened to the graph. */
function PlayMode({ scriptId, onPick }: { scriptId: string; onPick: (id: string) => void }) {
  const script = DEMO_BY_ID.get(scriptId) ?? DEMOS[0];
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [spoken, setSpoken] = useState<Spoken[]>([]);
  const [graph, setGraph] = useState<Graph>(() => base(script));

  const reset = useCallback(() => {
    setI(0); setSpoken([]); setGraph(base(script)); setPlaying(true);
  }, [script]);

  useEffect(() => { reset(); }, [scriptId, reset]);

  useEffect(() => {
    if (!playing || i >= script.steps.length) return;
    const step = script.steps[i];
    const timer = setTimeout(() => {
      setSpoken((s) => [...s, { who: step.who, say: step.say, does: step.does }]);
      if (step.does?.length) setGraph((g) => step.does!.reduce(apply, g));
      setI((n) => n + 1);
    }, i === 0 ? 400 : step.gap);
    return () => clearTimeout(timer);
  }, [i, playing, script]);

  // A celebration is a moment, not a state. The producer would clear it; in playback we expire it
  // ourselves so the overlay can't sit on the map for the rest of the meeting.
  useEffect(() => {
    if (!graph.reaction) return;
    const t = setTimeout(() => setGraph((g) => ({ ...g, reaction: null })), 2600);
    return () => clearTimeout(t);
  }, [graph.reaction]);

  return (
    <main className="flex h-dvh w-dvw overflow-hidden">
      <div className="canvas-surface relative min-w-0 flex-1">
        <Stage graph={graph} />
      </div>
      <TranscriptPanel
        script={script}
        spoken={spoken}
        playing={playing && i < script.steps.length}
        onToggle={() => setPlaying((p) => !p)}
        onRestart={reset}
        onPick={onPick}
      />
    </main>
  );
}

function base(script: { title: string; subtitle: string; seed: GNode[] }): Graph {
  return { rev: 0, title: script.title, subtitle: script.subtitle, status: "live", nodes: [...script.seed] };
}

/** Pure reducer — one action, one new graph. Pure so playback is deterministic and replayable, and
 *  so the same actions could later be applied by the real transcript pipeline unchanged. */
function apply(g: Graph, a: Action): Graph {
  switch (a.kind) {
    case "add": {
      // Re-adding an existing id REPLACES it, which is how a poll accrues votes without a bespoke
      // action type: the producer just sends the node again with new numbers.
      const exists = g.nodes.some((n) => n.id === a.node.id);
      return {
        ...g,
        nodes: exists ? g.nodes.map((n) => (n.id === a.node.id ? { ...n, ...a.node } : n)) : [...g.nodes, a.node],
      };
    }
    case "focus":
      return { ...g, focus: a.id };
    case "state":
      return { ...g, nodes: g.nodes.map((n) => (n.id === a.id ? { ...n, state: a.state } : n)) };
    case "react":
      return {
        ...g,
        nodes: g.nodes.map((n) => {
          if (n.id !== a.id) return n;
          const rs = [...(n.reactions ?? [])];
          const hit = rs.find((r) => r.emoji === a.emoji);
          if (hit) hit.count += 1; else rs.push({ emoji: a.emoji, count: 1 });
          return { ...n, reactions: rs };
        }),
      };
    case "collapse":
      return { ...g, nodes: g.nodes.map((n) => (n.id === a.id ? { ...n, collapsed: a.count } : n)) };
    case "celebrate":
      return { ...g, reaction: { kind: a.glyph ?? "spark", label: a.label } };
  }
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
