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
import { KIND_SIZE, branchColor, layout, type Graph, type Placed } from "@/lib/canvas-graph";
import { GraphNode } from "@/components/canvas/GraphNode";

const EDGE_LABEL: Record<string, string> = {
  blocks: "blocks", depends: "depends on", answers: "answers", contradicts: "contradicts",
};

/** Eases node positions toward their computed target, and returns the in-between frame.
 *
 *  One loop drives EVERYTHING. Transitioning the nodes in CSS was the obvious approach and it splits
 *  the map in half: SVG path `d` cannot be transitioned, so the cards would glide to their new
 *  angles while the branches connecting them snapped instantly — the map visibly coming apart at
 *  exactly the moment it should read as one object reorganising. Interpolating here means nodes and
 *  edges are drawn from the same coordinates on every frame, so they cannot disagree.
 *
 *  A node with no previous position is NEW: it appears at its final spot and lets the entrance
 *  keyframe do the work. Sliding it in from (0,0) would read as it flying across the canvas. */
function useEased(target: Placed[], ms = 900): Placed[] {
  const [frame, setFrame] = useState(target);
  const prev = useRef(new Map<string, { x: number; y: number }>());
  const raf = useRef<number | undefined>(undefined);

  useEffect(() => {
    const from = new Map(prev.current);
    const t0 = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - t, 3); // easeOutCubic — leaves immediately, settles softly
      // A merging node's destination is its TARGET's position, not its own — that flight is the
      // whole readable part of a merge. Without it the node just fades where it stands, which reads
      // as a delete rather than as "this became part of that".
      const dest = new Map(target.map((n) => [n.id, n]));
      const next = target.map((n) => {
        const to = n.mergingInto ? dest.get(n.mergingInto) : undefined;
        const gx = to ? to.x : n.x;
        const gy = to ? to.y : n.y;
        const f = from.get(n.id);
        return f ? { ...n, x: f.x + (gx - f.x) * e, y: f.y + (gy - f.y) * e } : { ...n, x: gx, y: gy };
      });
      for (const n of next) prev.current.set(n.id, { x: n.x, y: n.y });
      setFrame(next);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };

    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [target, ms]);

  return frame;
}

export function GraphCanvas({ graph }: { graph: Graph }) {
  const targets = useMemo(() => layout(graph.nodes), [graph.nodes]);
  const placed = useEased(targets);
  const byId = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);
  const [vp, setVp] = useState({ w: 1280, h: 720 });
  const wrapRef = useRef<HTMLDivElement>(null);

  // Measure the CONTAINER, not the window. In play mode the operator panel takes 380px, so a camera
  // fitted to window width centres the map behind the panel and pushes cards off the visible edge.
  // A ResizeObserver also covers the panel appearing/disappearing, which no window resize fires for.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      setVp({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Real bounding box of the map, node boxes included. Fitting to centre-points alone is what let
  // the outer cards hang off the frame: a node is up to 360 units wide, so its edge sits half a card
  // beyond the point being fitted to.
  const bounds = useMemo(() => bbox(placed), [placed]);

  const focus = graph.focus ? byId.get(graph.focus) : undefined;

  // Following a node means framing its NEIGHBOURHOOD — the node, its parent, and its siblings — not
  // the node alone. A camera tight on one card tells a customer nothing about where it sits, which
  // is the entire value of a map. Previously this was a fixed 0.62 zoom, which left most maps
  // showing two cards in an empty field.
  const near = useMemo(() => {
    if (!focus) return null;
    const kin = placed.filter(
      (p) => p.id === focus.id || p.id === focus.parent || (focus.parent && p.parent === focus.parent),
    );
    return bbox(kin.length ? kin : [focus]);
  }, [focus, placed]);

  const centre = near ? { x: near.cx, y: near.cy } : { x: bounds.cx, y: bounds.cy };

  // Overview fits BOTH axes independently — a single "spread" number over-zooms whenever the map is
  // wider than it is tall (or vice versa), which is most of the time. HEADER reserves the strip the
  // floating title occupies so the camera never parks a node underneath it.
  const HEADER = 104;
  const MARGIN = 56;
  const target = near ?? bounds;
  const fitZoom = Math.min(
    (vp.w - MARGIN * 2) / Math.max(1, target.w),
    (vp.h - HEADER - MARGIN) / Math.max(1, target.h),
  );
  // Capped at 0.85 when following: a neighbourhood of one or two cards would otherwise fit at 2×,
  // and a map that zooms to fill the frame with a single node has stopped being a map.
  const zoom = near
    ? Math.max(0.3, Math.min(0.85, fitZoom))
    : Math.max(0.22, Math.min(0.7, fitZoom));

  const tx = vp.w / 2 - centre.x * zoom;
  // Centre within the space BELOW the header rather than the whole viewport.
  const ty = HEADER + (vp.h - HEADER) / 2 - centre.y * zoom;

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

/** Bounding box of the whole map in canvas units, node boxes included. */
function bbox(placed: Placed[]) {
  if (!placed.length) return { w: 900, h: 600, cx: 0, cy: 0 };
  const l = Math.min(...placed.map((p) => p.x - KIND_SIZE[p.kind].w / 2));
  const r = Math.max(...placed.map((p) => p.x + KIND_SIZE[p.kind].w / 2));
  const t = Math.min(...placed.map((p) => p.y - KIND_SIZE[p.kind].h / 2));
  const b = Math.max(...placed.map((p) => p.y + KIND_SIZE[p.kind].h / 2));
  return { w: r - l, h: b - t, cx: (l + r) / 2, cy: (t + b) / 2 };
}

/** Edges live in one SVG beneath the nodes. Branch edges are the tree; typed edges are the extra
 *  relationships and are dashed + labelled, so a claim like "blocks" is always spelled out rather
 *  than encoded in a line style nobody can decode. */
function Edges({ placed, graph }: { placed: Placed[]; graph: Graph }) {
  const byId = new Map(placed.map((p) => [p.id, p]));
  // Branch order = order of appearance, so a given meeting always colours the same way.
  const branchIds = placed.filter((p) => p.depth === 1).map((p) => p.id);
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
          // Hierarchy is carried by the LINES, not by the cards. Weight tapers with depth (a trunk
          // is thicker than a twig) and each subtree keeps one hue, so you can see at a glance both
          // how deep something sits and which branch it belongs to. Before this every relationship
          // was the same 2px grey, which is why the structure was unreadable.
          const w = Math.max(1.25, 4.5 - n.depth * 1.15);
          const hue = branchColor(branchIds, n.branch);
          return (
            <path
              key={`b-${n.id}`}
              d={curve(...anchor(p, n))}
              fill="none"
              stroke={hue}
              strokeOpacity={Math.max(0.22, 0.62 - n.depth * 0.13)}
              strokeWidth={w}
              strokeLinecap="round"
            />
          );
        })}

        {/* Merge beam. The absorbed node flying across was legible only once it had already moved —
            by which point the relationship it was expressing was over. A bright link drawn between
            the two the instant the merge starts says "these are the same thing" BEFORE anything
            moves, so the flight reads as a consequence rather than as a surprise. */}
        {placed.filter((n) => n.mergingInto && byId.has(n.mergingInto)).map((n) => {
          const to = byId.get(n.mergingInto!)!;
          return (
            <g key={`m-${n.id}`}>
              <path
                d={curve(n.x, n.y, to.x, to.y)}
                fill="none"
                stroke="#1baf7a"
                strokeWidth={3}
                strokeLinecap="round"
                strokeDasharray="10 8"
                style={{ animation: "flow 0.7s linear infinite" }}
              />
              <circle cx={to.x} cy={to.y} r={16} fill="#1baf7a" opacity={0.18}
                      style={{ animation: "mergePulse 800ms var(--ease-out) infinite" }} />
            </g>
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

/** HORIZONTAL-tangent cubic. The old version used vertical tangents regardless of direction, so any
 *  sideways branch left its parent going *down*, looped, and came back up — which is most of why the
 *  edges looked wrong. In a left-to-right tree the flow is horizontal, so the tangents must be too:
 *  the line leaves the parent's edge sideways and arrives at the child's edge sideways, and never
 *  crosses itself.
 *
 *  Rounded for the same reason node coordinates are: full-precision floats serialize differently
 *  server- and client-side and React flags the path as a hydration mismatch. */
function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.round(Math.abs(x2 - x1) * 0.42);
  const s = x2 >= x1 ? 1 : -1;
  return `M ${x1} ${y1} C ${x1 + dx * s} ${y1}, ${x2 - dx * s} ${y2}, ${x2} ${y2}`;
}

/** Anchor an edge to the card's left/right EDGE rather than its centre, so lines emerge from the
 *  side of a node instead of appearing to run underneath it. */
function anchor(from: Placed, to: Placed): [number, number, number, number] {
  const fw = KIND_SIZE[from.kind].w / 2;
  const tw = KIND_SIZE[to.kind].w / 2;
  const rightward = to.x >= from.x;
  return [
    from.x + (rightward ? fw : -fw), from.y,
    to.x + (rightward ? -tw : tw), to.y,
  ];
}
