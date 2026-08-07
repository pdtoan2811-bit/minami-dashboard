"use client";
// The infinite canvas engine.
//
// No graph library. react-flow and friends exist to make a canvas *editable* — drag, snap, connect,
// select — and every one of those affordances is dead weight here, because this surface is a video
// stream. Nobody in the meeting can touch it. What's left is layout, a camera, and edges, which is
// a few hundred lines and stays fast on a 2-vCPU box encoding it at 30fps.
//
// Camera: the producer names a `focus` node and the view GLIDES to centre it. One CSS transform on
// one wrapper, transitioned — so panning costs no layout and no React work per frame. Zoom eases in
// on focus and pulls back when focus changes, which is what makes the map feel like it's following
// the conversation rather than being dragged.
import { useEffect, useMemo, useRef, useState } from "react";
import { layout, type Graph, type Placed } from "@/lib/canvas-graph";
import { GraphNode } from "@/components/canvas/GraphNode";

const EDGE_LABEL: Record<string, string> = {
  blocks: "blocks", depends: "depends on", answers: "answers", contradicts: "contradicts",
};

export function GraphCanvas({ graph }: { graph: Graph }) {
  const placed = useMemo(() => layout(graph.nodes), [graph.nodes]);
  const byId = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const [vp, setVp] = useState({ w: 1280, h: 720 });
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fit = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // Camera target: the focused node, else the centroid so a fresh map opens on its whole self.
  const focus = graph.focus ? byId.get(graph.focus) : undefined;
  const centre = useMemo(() => {
    if (focus) return { x: focus.x, y: focus.y };
    if (!placed.length) return { x: 0, y: 0 };
    const xs = placed.map((p) => p.x), ys = placed.map((p) => p.y);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  }, [focus, placed]);

  // Zoom: closer when following a specific node, wider for the overview. Clamped so a big map never
  // shrinks past legibility — an unreadable map is worse than a cropped one.
  // Following a node still has to show its NEIGHBOURS — a camera tight enough to fill the frame with
  // one card tells a customer nothing about where it sits, which is the entire value of a map.
  const zoom = focus ? 0.62 : Math.max(0.34, Math.min(0.7, 1100 / Math.max(800, spread(placed))));

  const tx = vp.w / 2 - centre.x * zoom;
  const ty = vp.h / 2 - centre.y * zoom;

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden">
      <div
        className="absolute left-0 top-0 origin-top-left will-change-transform"
        style={{
          transform: `translate3d(${tx}px, ${ty}px, 0) scale(${zoom})`,
          // Long and eased: a camera that snaps is disorienting on a shared screen; a camera that
          // glides reads as intentional attention.
          transition: "transform 900ms cubic-bezier(0.22, 1, 0.36, 1)",
        }}
      >
        <Edges placed={placed} graph={graph} />
        {placed.map((n, i) => (
          <GraphNode key={n.id} n={n} index={i} live={graph.focus === n.id} />
        ))}
      </div>
    </div>
  );
}

function spread(placed: Placed[]): number {
  if (placed.length < 2) return 600;
  const xs = placed.map((p) => p.x), ys = placed.map((p) => p.y);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + 400;
}

/** Edges live in one SVG beneath the nodes. Branch edges are the tree; typed edges are the extra
 *  relationships and are dashed + labelled, so a claim like "blocks" is always spelled out rather
 *  than encoded in a line style nobody can decode. */
function Edges({ placed, graph }: { placed: Placed[]; graph: Graph }) {
  const byId = new Map(placed.map((p) => [p.id, p]));
  const pad = 4000; // canvas units of slack around origin so negative coords aren't clipped

  const branches = placed.filter((n) => n.parent && byId.has(n.parent));
  const typed = (graph.edges ?? []).filter((e) => byId.has(e.from) && byId.has(e.to));

  return (
    <svg
      className="pointer-events-none absolute overflow-visible"
      style={{ left: -pad, top: -pad, width: pad * 2, height: pad * 2 }}
    >
      <g transform={`translate(${pad},${pad})`}>
        {branches.map((n) => {
          const p = byId.get(n.parent!)!;
          return (
            <path
              key={`b-${n.id}`}
              d={curve(p.x, p.y, n.x, n.y)}
              fill="none"
              stroke="#d9d9d6"
              strokeWidth={2}
              strokeLinecap="round"
            />
          );
        })}

        {typed.map((e, i) => {
          const a = byId.get(e.from)!, b = byId.get(e.to)!;
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          return (
            <g key={`t-${i}`}>
              <path
                d={curve(a.x, a.y, b.x, b.y)}
                fill="none"
                stroke="#b9b9b4"
                strokeWidth={1.75}
                strokeDasharray="7 7"
                strokeLinecap="round"
                // The flow. Only typed edges animate: if every branch pulsed, the map would shimmer
                // constantly and the motion would stop meaning anything.
                style={{ animation: "flow 1.4s linear infinite" }}
              />
              <text
                x={mx}
                y={my - 7}
                textAnchor="middle"
                className="fill-neutral-400"
                style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.02em" }}
              >
                {EDGE_LABEL[e.kind ?? "branch"] ?? ""}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/** Vertical-tangent cubic: leaves the parent and meets the child softly, so the tree reads as
 *  branching rather than as a wire diagram. */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  // Rounded for the same reason the node coordinates are: full-precision floats serialize
  // differently server- and client-side and React flags the whole path as a hydration mismatch.
  const dy = Math.round((y2 - y1) * 0.5);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}
