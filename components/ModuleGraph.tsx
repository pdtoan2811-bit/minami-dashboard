"use client";

// Interactive module map of this app, rendered with React Flow.
//
// The graph data (lib/module-graph.ts) is extracted from the source, so this is a picture of what
// the code actually does rather than what someone remembers it doing. Two edge kinds are drawn
// differently on purpose: a solid line is a compile-time `import`, a dashed line is a runtime
// fetch/SSE call. Conflating them hides the client/server boundary, which is the single most
// useful thing this diagram has to say.

import { useCallback, useMemo, useState } from "react";
import {
  Background, BackgroundVariant, Controls, MiniMap, Position, ReactFlow,
  type Edge, type Node, type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { EDGES, LAYERS, NODES, type LayerId, type ModuleNode } from "@/lib/module-graph";

const COL_W = 300;   // horizontal distance between layer columns
const ROW_H = 78;    // vertical distance between nodes within a column
const TOP = 70;      // headroom for the column headers

// Same semantic key as docs/architecture.html, so the two documents read as one system.
const LAYER_COLOR: Record<LayerId, string> = {
  surface: "#c4486a",   // ui / rose — what you look at
  component: "#c4486a",
  route: "#0f7f9c",     // agent / cyan — the server side
  core: "#6d5ae0",      // cache / violet — the logic
  runtime: "#c47f18",   // disk / amber — outside the process
};
const PIPELINE_COLOR: Record<string, string> = {
  live: "#0f7f9c", read: "#c47f18", metrics: "#1f8a5c",
};

type Filter = "all" | "live" | "read" | "metrics";

const FILTERS: { id: Filter; label: string; hint: string }[] = [
  { id: "all", label: "everything", hint: "all modules and edges" },
  { id: "live", label: "live sessions", hint: "browser → SDK → running claude" },
  { id: "read", label: "transcripts", hint: "disk → parser → grid tile" },
  { id: "metrics", label: "metrics", hint: "cross-machine usage" },
];

function colIndex(layer: LayerId) {
  return LAYERS.findIndex((l) => l.id === layer);
}

export function ModuleGraph() {
  const [filter, setFilter] = useState<Filter>("all");
  // Click a node to isolate it and its immediate neighbours — the fastest way to answer
  // "what touches this file?", which is the question people actually open a module map to ask.
  const [focus, setFocus] = useState<string | null>(null);

  const neighbours = useMemo(() => {
    if (!focus) return null;
    const set = new Set<string>([focus]);
    for (const e of EDGES) {
      if (e.from === focus) set.add(e.to);
      if (e.to === focus) set.add(e.from);
    }
    return set;
  }, [focus]);

  const visible = useCallback(
    (n: ModuleNode) => {
      if (filter !== "all" && n.pipeline !== filter) return false;
      return true;
    },
    [filter],
  );

  const nodes: Node[] = useMemo(() => {
    const shown = NODES.filter(visible);
    // Column headers live INSIDE the canvas as inert nodes rather than as a fixed overlay, so they
    // pan and zoom with the columns they label instead of drifting off the ones they describe.
    const headers: Node[] = LAYERS.map((l, i) => ({
      id: `hdr-${l.id}`,
      position: { x: i * COL_W, y: 0 },
      data: {
        label: (
          <div className="text-left">
            <div className="font-mono text-[10.5px] uppercase tracking-[.14em] text-neutral-400">{l.label}</div>
            <div className="text-[9.5px] text-neutral-600">{l.hint}</div>
          </div>
        ),
      },
      style: { width: 232, padding: "2px 4px", border: "none", background: "transparent", boxShadow: "none" },
      draggable: false,
      selectable: false,
      connectable: false,
    })) as Node[];
    // Re-pack rows so a filtered view doesn't leave tall gaps where hidden nodes used to be.
    const rowByLayer = new Map<LayerId, number>();
    const body = shown.map((n) => {
      const r = rowByLayer.get(n.layer) ?? 0;
      rowByLayer.set(n.layer, r + 1);
      const dim = neighbours ? !neighbours.has(n.id) : false;
      const accent = n.pipeline ? PIPELINE_COLOR[n.pipeline] : LAYER_COLOR[n.layer];
      return {
        id: n.id,
        position: { x: colIndex(n.layer) * COL_W, y: TOP + r * ROW_H },
        data: {
          label: (
            <div className="text-left leading-tight">
              <div className="text-[11.5px] font-semibold text-neutral-100">{n.label}</div>
              {n.sub && (
                <div className="mt-0.5 whitespace-pre-line text-[9.5px] text-neutral-400">{n.sub}</div>
              )}
            </div>
          ),
        },
        style: {
          width: 232,
          padding: "8px 10px",
          borderRadius: 10,
          border: `1px solid ${accent}`,
          borderLeft: `3px solid ${accent}`,
          background: focus === n.id ? "#1d222d" : "#161a22",
          boxShadow: focus === n.id ? `0 0 0 2px ${accent}55` : "none",
          opacity: dim ? 0.22 : 1,
          transition: "opacity .18s",
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
    });
    return [...headers, ...body];
  }, [visible, neighbours, focus]);

  const edges: Edge[] = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    return EDGES.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e, i) => {
      const dim = neighbours ? !(neighbours.has(e.from) && neighbours.has(e.to)) : false;
      const http = e.kind === "http";
      return {
        id: `e${i}`,
        source: e.from,
        target: e.to,
        label: e.label,
        animated: http && !dim,
        style: {
          stroke: http ? "#6d5ae0" : "#4e5665",
          strokeWidth: 1.4,
          strokeDasharray: http ? "5 4" : undefined,
          opacity: dim ? 0.07 : 1,
        },
        labelStyle: { fill: "#a3abbb", fontSize: 9.5, fontFamily: "ui-monospace, monospace" },
        labelBgStyle: { fill: "#0e1016" },
        labelBgPadding: [4, 2] as [number, number],
      };
    });
  }, [nodes, neighbours]);

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    setFocus((cur) => (cur === node.id ? null : node.id));
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => { setFilter(f.id); setFocus(null); }}
            title={f.hint}
            className={`rounded-lg border px-2.5 py-1 font-mono text-[11px] transition-colors ${
              filter === f.id
                ? "border-white/25 bg-white/10 text-neutral-100"
                : "border-white/10 text-neutral-500 hover:text-neutral-200"
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-3 font-mono text-[10px] text-neutral-500">
          <span className="flex items-center gap-1.5">
            <svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke="#4e5665" strokeWidth="1.6" /></svg>
            import
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="22" height="6" aria-hidden><line x1="0" y1="3" x2="22" y2="3" stroke="#6d5ae0" strokeWidth="1.6" strokeDasharray="5 4" /></svg>
            fetch / SSE
          </span>
          {focus && (
            <button onClick={() => setFocus(null)} className="text-neutral-300 underline underline-offset-2">
              clear focus
            </button>
          )}
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={onNodeClick}
          onPaneClick={() => setFocus(null)}
          fitView
          fitViewOptions={{ padding: 0.12 }}
          minZoom={0.2}
          maxZoom={1.6}
          proOptions={{ hideAttribution: false }}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesFocusable={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#262c39" />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            nodeColor={(n) => {
              const m = NODES.find((x) => x.id === n.id);
              return m ? (m.pipeline ? PIPELINE_COLOR[m.pipeline] : LAYER_COLOR[m.layer]) : "#4e5665";
            }}
            maskColor="rgba(14,16,22,.55)"
            style={{ background: "#11141b", border: "1px solid #262c39", borderRadius: 8 }}
          />
        </ReactFlow>
      </div>
    </div>
  );
}
