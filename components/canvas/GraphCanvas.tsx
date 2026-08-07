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
import { KIND_SIZE, branchColor, columnBounds, layout, nodeHeight, type Graph, type Placed } from "@/lib/canvas-graph";
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

/** Relationships too far apart to draw as a line, keyed by the node that should wear the badge. */
export function farRelations(graph: Graph, placed: Placed[]) {
  const byId = new Map(placed.map((p) => [p.id, p]));
  const out = new Map<string, { kind: string; other: string }[]>();
  for (const e of graph.edges ?? []) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    if (Math.hypot(a.x - b.x, a.y - b.y) <= 620) continue;
    const list = out.get(e.from) ?? [];
    list.push({ kind: e.kind ?? "branch", other: b.label });
    out.set(e.from, list);
  }
  return out;
}

export function GraphCanvas({ graph }: { graph: Graph }) {
  // Two passes: lay out once to learn which relationships are too far to draw, annotate the nodes
  // with how many badges they'll wear, then lay out again so their heights include those badges.
  // One pass would size every card as if it had none, and they'd collide exactly as before.
  const targets = useMemo(() => {
    const first = layout(graph.nodes);
    const rels = farRelations(graph, first);
    if (!rels.size) return first;
    return layout(graph.nodes.map((n) => (rels.has(n.id) ? { ...n, rels: Math.min(2, rels.get(n.id)!.length) } : n)));
  }, [graph]);
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

  const bounds = useMemo(() => bbox(placed), [placed]);
  const rels = useMemo(() => farRelations(graph, placed), [graph, placed]);

  // ── Camera director ───────────────────────────────────────────────────────────────────────────
  // Cut-scene grammar, not a follow-cam. When something lands, the camera PUSHES IN on it, HOLDS
  // long enough to read, then PULLS BACK — first to the topic column it belongs to, then out to the
  // whole board. That beat is what makes an event feel like an event: a camera that simply tracks
  // focus never lets you see consequence, because it never shows you the thing in context
  // afterwards. Three shots per event, and the pull-back is the one doing the emotional work.
  const focus = graph.focus ? byId.get(graph.focus) : undefined;
  const [shot, setShot] = useState<"push" | "column" | "wide">("wide");

  useEffect(() => {
    if (!graph.focus) { setShot("wide"); return; }
    setShot("push");
    const a = setTimeout(() => setShot("column"), 2100);  // hold on the subject
    const b = setTimeout(() => setShot("wide"), 4600);    // then let it breathe
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [graph.focus, graph.rev]);

  const target = useMemo(() => {
    if (!focus) return bounds;
    if (shot === "push") {
      const w = KIND_SIZE[focus.kind].w, h = nodeHeight(focus);
      // Not the card alone — a shallow margin keeps its neighbours just in frame, so even the
      // tightest shot still says where this thing sits.
      return { w: w * 2.1, h: h * 2.1, cx: focus.x, cy: focus.y };
    }
    if (shot === "column") return columnBounds(placed, focus.branch) ?? bounds;
    return bounds;
  }, [focus, shot, bounds, placed]);

  const HEADER = 104;
  const MARGIN = 56;
  const fitZoom = Math.min(
    (vp.w - MARGIN * 2) / Math.max(1, target.w),
    (vp.h - HEADER - MARGIN) / Math.max(1, target.h),
  );
  const zoom = Math.max(0.2, Math.min(shot === "push" ? 1.05 : 0.8, fitZoom));

  const tx = vp.w / 2 - target.cx * zoom;
  const ty = HEADER + (vp.h - HEADER) / 2 - target.cy * zoom;

  // Longer and softer on the way out than on the way in: a push-in should feel decisive, a
  // pull-back should feel like relaxing. Same curve, different duration — that asymmetry is most of
  // what separates a directed camera from a lerp.
  const dur = shot === "push" ? 780 : 1250;

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden">
      <div
        className="absolute left-0 top-0 origin-top-left will-change-transform"
        style={{
          transform: `translate3d(${tx}px, ${ty}px, 0) scale(${zoom})`,
          // Long and eased: a camera that snaps is disorienting on a shared screen; a camera that
          // glides reads as intentional attention.
          transition: `transform ${dur}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        }}
      >
        <Edges placed={placed} graph={graph} />
        {placed.map((n, i) => (
          <GraphNode key={n.id} n={n} index={i} live={graph.focus === n.id} rel={rels.get(n.id)} />
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
  const t = Math.min(...placed.map((p) => p.y - nodeHeight(p) / 2));
  const b = Math.max(...placed.map((p) => p.y + nodeHeight(p) / 2));
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

  // One halo per topic, covering its whole cluster.
  const halos = placed
    .filter((n) => n.kind === "topic")
    .map((t) => {
      const own = placed.filter((p) => p.branch === t.branch);
      if (own.length < 2 || t.depth > 1) return null;
      const M = 30;
      const l = Math.min(...own.map((p) => p.x - KIND_SIZE[p.kind].w / 2)) - M;
      const r = Math.max(...own.map((p) => p.x + KIND_SIZE[p.kind].w / 2)) + M;
      const tp = Math.min(...own.map((p) => p.y - nodeHeight(p) / 2)) - M;
      const bt = Math.max(...own.map((p) => p.y + nodeHeight(p) / 2)) + M;
      return {
        id: t.id, x: Math.round(l), y: Math.round(tp),
        w: Math.round(r - l), h: Math.round(bt - tp),
        color: branchColor(branchIds, t.branch),
      };
    })
    .filter(Boolean) as { id: string; x: number; y: number; w: number; h: number; color: string }[];

  // A typed relationship between two DISTANT nodes cannot be drawn as a line without cutting a long
  // diagonal across whatever sits between them — and on a tree layout that is almost always several
  // cards. No curve tuning fixes it; the geometry is simply hostile. So only near pairs get a line.
  // The rest are handed to the nodes themselves as a badge (see `rel` below), which says the same
  // thing without dragging a wire through three unrelated cards.
  const NEAR = 620;
  const all = (graph.edges ?? []).filter((e) => byId.has(e.from) && byId.has(e.to));
  const typed = all.filter((e) => {
    const a = byId.get(e.from)!, b = byId.get(e.to)!;
    return Math.hypot(a.x - b.x, a.y - b.y) <= NEAR;
  });

  return (
    <svg
      className="pointer-events-none absolute overflow-visible"
      style={{ left: -pad, top: -pad, width: pad * 2, height: pad * 2 }}
    >
      <g transform={`translate(${pad},${pad})`}>
        {/* Cluster halos. A bracket assumed a vertical column; a scattered cluster needs an area,
            not a spine. A soft rounded region behind each topic's members says "these belong
            together" without drawing a line to every card — which at this density would be a
            cobweb. Low alpha so it reads as grouping, never as a container you could mistake for a
            card. */}
        {halos.map((h) => (
          <rect
            key={`h-${h.id}`}
            x={h.x} y={h.y} width={h.w} height={h.h} rx={44}
            fill={h.color} fillOpacity={0.045}
            stroke={h.color} strokeOpacity={0.16} strokeWidth={1.5}
          />
        ))}

        {/* The mindmap edges. Now that a topic is a root node on the LEFT with its cards fanning
            right, an edge is a short horizontal hop — which is the geometry a curve is actually good
            at. The earlier versions failed because the layout was wrong for them: a swooping wire up
            to a heading, or a diagonal across a scatter. Same curve function, finally in a layout
            that suits it. */}
        {branches.map((n) => {
          const p = byId.get(n.parent!);
          if (!p) return null;
          return (
            <path
              key={`b-${n.id}`}
              d={curve(...anchor(p, n))}
              fill="none"
              stroke={branchColor(branchIds, n.branch)}
              strokeOpacity={0.42}
              strokeWidth={2}
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

/** Is `n` anywhere beneath `ancestorId`? Walks up rather than down so it stays cheap on a flat list. */
function inSubtree(all: Placed[], n: Placed, ancestorId: string): boolean {
  const byId = new Map(all.map((p) => [p.id, p]));
  let cur: Placed | undefined = n;
  let guard = 0;
  while (cur?.parent && guard++ < 24) {
    if (cur.parent === ancestorId) return true;
    cur = byId.get(cur.parent);
  }
  return false;
}

/** Rail-and-tick connector for the column layout: drop a vertical line from just inside the
 *  parent's left edge, then a short horizontal tick into the child's left edge. Rounded corners so
 *  it reads as drawn rather than as a schematic. */
function elbow(p: Placed, c: Placed): string {
  const railX = Math.round(p.x - KIND_SIZE[p.kind].w / 2 + 14);
  const py = Math.round(p.y + nodeHeight(p) / 2);
  const cy = Math.round(c.y);
  const cx = Math.round(c.x - KIND_SIZE[c.kind].w / 2);
  const r = Math.min(12, Math.max(0, cy - py), Math.max(0, cx - railX));
  return `M ${railX} ${py} L ${railX} ${cy - r} Q ${railX} ${cy} ${railX + r} ${cy} L ${cx} ${cy}`;
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
