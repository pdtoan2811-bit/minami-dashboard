// EDGE ROUTING — one place that decides how every relationship is expressed.
//
// ── The constraint that determines everything ────────────────────────────────────────────────────
// Cards are HTML; edges are SVG behind them. There is no z-order in which an edge sits above a card.
// So an edge crossing a card is not "a bit untidy" — it is INVISIBLE for that stretch, and what the
// viewer sees is two disconnected stubs with no way to tell what joins what. Occlusion here is
// silent data loss, which is worse than showing nothing, because nothing at least looks like nothing.
//
// Hence the governing rule:
//
//     AN EDGE IS EITHER FULLY LEGIBLE END TO END, OR IT IS NOT DRAWN AS A LINE AT ALL.
//
// No partial states. Every rule below is a consequence of that one.
//
// ── Where a line is allowed to be ────────────────────────────────────────────────────────────────
// Whitespace on this board is structured, not incidental. Cards sit in left-aligned columns, so the
// empty space comes in two shapes: the tall vertical GUTTERS between columns (and to the right of
// the last one), and the short horizontal bands between stacked cards (24px — too thin for a line
// and a label, and it changes with content).
//
// Only gutters are reliably empty and reliably tall. So: all travel happens in a gutter, and a line
// enters a card's row only for the final few pixels of approach to its border. This is channel
// routing, and it is the same answer circuit boards and graph-drawing libraries arrive at, for the
// same reason — it is the only structure that guarantees clearance without knowing the content.
//
// ── Ports, not centres ───────────────────────────────────────────────────────────────────────────
// An edge attaches to a card's left or right BORDER, never its centre. A centre anchor starts the
// stroke inside the card, which is both invisible and a lie about where the relationship attaches.
//
// ── Lanes ────────────────────────────────────────────────────────────────────────────────────────
// Two edges travelling the same gutter at the same depth overlay into one ambiguous stroke. Each
// gutter therefore has numbered lanes at fixed offsets, and an edge occupies one for its vertical
// run. Lanes are assigned by INTERVAL, not by counter: two edges may share a lane if their y-ranges
// don't overlap, because they can never be confused for each other. A naive per-edge counter pushes
// every edge into its own lane and turns a gutter into a cable bundle for no reason.
//
// Assignment is greedy in creation order and never reshuffles. That matches the promise the layout
// already makes — a thing that arrived stays put — so an edge added at minute nine cannot move a
// line you were reading at minute two.
//
// ── The degradation ladder ───────────────────────────────────────────────────────────────────────
// When a line can't be drawn legibly, it degrades rather than being forced through:
//
//   1. SAME COLUMN     → bow out into the column's right gutter and back
//   2. ADJACENT COLUMN → S-curve through the gutter between the two columns
//   3. BADGE           → worn on the card as a chip naming the other end
//
// A relationship falls to (3) when it spans more than one gutter, when its gutter is already at the
// lane cap, or when the pill it must carry cannot fit in the space available. The cap exists because
// a gutter with five lines in it stops reading as five relationships and starts reading as texture —
// past that point the badge genuinely carries more information than the line.
//
// Nothing is ever silently dropped: an edge is a line or a badge, never neither.

import { nodeHeight, widthOf, type GEdge, type Placed } from "@/lib/canvas-graph";

export const EDGE_LABEL: Record<string, string> = {
  answers: "answers",
  blocks: "blocks",
  depends: "depends on",
  contradicts: "vs",
  branch: "",
};

/** How far past a column's right edge the first bow reaches. */
const BOW = 44;
/** Spacing between lanes in the same gutter. Wide enough that two strokes read as two.
 *
 *  ⚠️ This is a STROKE pitch, not a LABEL pitch, and conflating the two is what broke this board. A
 *  1.5px line needs 22px to read as separate; a "depends on" pill is ~79px wide, so two pills hung on
 *  adjacent lanes overlapped by ~57px while their lines stayed perfectly clear. Widening the lane to
 *  pill width is the wrong fix — it would blow the gutter open for every edge, labelled or not. Lanes
 *  stay at stroke pitch and the labels are separated along the run by placePills(). */
const LANE = 22;
/** Past this many lanes a gutter reads as texture rather than as relationships. */
const MAX_LANES = 4;
/** Vertical slack added to an edge's y-interval when testing lane conflicts, so two edges that end
 *  and begin at nearly the same height still get separate lanes. */
const LANE_PAD = 26;
/** Centres closer than this are the same column, allowing for cards of differing width. */
const SAME_COL = 40;
/** Clearance kept between a pill and any card. */
const PILL_MARGIN = 14;
/** Rendered pill height in GraphCanvas (rect height 19). Kept here because the collision test is
 *  geometry, and geometry belongs with the routing rather than with the renderer. */
const PILL_H = 19;
/** Clear air between two pills before they read as one blob. */
const PILL_GAP = 7;
/** How far along its own run a pill may slide from the midpoint, as a fraction of the run.
 *  Beyond this it stops looking like it belongs to that edge and starts looking like it labels the
 *  card it has drifted next to. */
const SLIDE = 0.28;

export type RoutedEdge = {
  key: string;
  kind: string;
  d: string;
  /** Null when this relationship carries no label worth showing. */
  pill: { x: number; y: number; w: number; label: string } | null;
  /** Where the line meets the target card, for the arrowhead. */
  head: { x: number; y: number; dir: 1 | -1 };
  /** Where it leaves the source. Drawn as a dot for the same reason the topic links have one: a
   *  stroke that merely stops near a rounded corner reads as having missed it. */
  tail: { x: number; y: number };
};

export type EdgePlan = {
  lines: RoutedEdge[];
  /** id → relationships this card wears as chips, because they could not be drawn legibly. */
  badges: Map<string, { kind: string; other: string }[]>;
};

const halfW = (p: Placed) => widthOf(p) / 2;
const pillWidth = (label: string) => (label ? label.length * 6.1 + 18 : 0);

/** Columns, keyed by left edge. Cards in a column are left-aligned but differ in width, so a bow
 *  sized to its own two endpoints can still pass through a wider neighbour — clearance is a property
 *  of the COLUMN, never of the pair. */
function columnsOf(placed: Placed[]) {
  const left: number[] = [];
  const right = new Map<number, number>();
  for (const p of placed) {
    const l = Math.round(p.x - halfW(p));
    if (!right.has(l)) left.push(l);
    right.set(l, Math.max(right.get(l) ?? -Infinity, p.x + halfW(p)));
  }
  left.sort((a, b) => a - b);
  return {
    left,
    keyOf: (p: Placed) => Math.round(p.x - halfW(p)),
    rightOf: (p: Placed) => right.get(Math.round(p.x - halfW(p))) ?? p.x + halfW(p),
    /** Left edge of the next column to the right, or Infinity if this is the last one. */
    nextLeft: (key: number) => left.find((l) => l > key + SAME_COL) ?? Infinity,
    /** How many columns sit strictly between two — 0 means adjacent. */
    between: (k1: number, k2: number) => {
      const [lo, hi] = k1 < k2 ? [k1, k2] : [k2, k1];
      return left.filter((l) => l > lo + SAME_COL && l < hi - SAME_COL).length;
    },
  };
}

/** Greedy interval assignment. Returns the first lane whose occupied ranges don't overlap this one,
 *  or -1 once the cap is reached. */
function takeLane(lanes: [number, number][][], lo: number, hi: number): number {
  for (let i = 0; i < MAX_LANES; i++) {
    const lane = (lanes[i] ??= []);
    if (lane.every(([a, b]) => hi < a || lo > b)) {
      lane.push([lo, hi]);
      return i;
    }
  }
  return -1;
}

/** Out, down, back — with rounded corners. A rounded rectangle path, not a curve.
 *
 *  The first version used a cubic with both control points out in the gutter. That is fine for two
 *  adjacent cards and wrong for everything else: a cubic is widest at its middle, so an edge spanning
 *  eight cards balloons into a huge slanted arc that belongs to no column and crosses the reading
 *  order of the whole board. Several of them at once look like spilled string.
 *
 *  A bracket keeps the promise the routing model actually makes — travel happens IN the gutter. The
 *  vertical run is parallel to the column whatever its length, so two edges in adjacent lanes read as
 *  two parallel lines rather than two overlapping ellipses, and a label can sit anywhere along the run
 *  because the run is straight. */
function bracket(x1: number, y1: number, x2: number, y2: number, gx: number): string {
  const down = y2 >= y1;
  // Corner radius shrinks on short spans so the two corners never overlap and invert the curve.
  const r = Math.min(16, Math.abs(y2 - y1) / 2, Math.max(0, gx - Math.max(x1, x2)));
  const s = down ? 1 : -1;
  return [
    `M ${x1} ${y1}`,
    `L ${gx - r} ${y1}`,
    `Q ${gx} ${y1}, ${gx} ${y1 + s * r}`,
    `L ${gx} ${y2 - s * r}`,
    `Q ${gx} ${y2}, ${gx - r} ${y2}`,
    `L ${x2} ${y2}`,
  ].join(" ");
}

/** PORTS — where on a card an edge is allowed to attach.
 *
 *  Every edge used to leave and arrive at the exact vertical middle of its card's border. With one
 *  edge that is correct and with three it is a knot: three strokes converge on one point, and at the
 *  point where you most need to see which is which they are perfectly superimposed. It is the same
 *  failure the topic fan had when it converged on the heading.
 *
 *  So a side is treated as a RANGE, not a point. Every edge touching a given side of a given card is
 *  collected, sorted by where its other end sits vertically, and spread evenly down that side. Sorting
 *  by the other end is what keeps it clean: edges then leave in the same order they arrive, so they
 *  cannot cross each other on the way out.
 *
 *  Nothing is remembered between runs. Ports are recomputed from the board's current geometry every
 *  time it changes, so a card that gains an edge, loses one, or moves simply gets a new distribution
 *  on the next frame — the arrangement is always a function of the board as it is now. */
type PortReq = { edgeKey: string; nodeId: string; side: "L" | "R"; sortY: number };

function assignPorts(reqs: PortReq[], byId: Map<string, Placed>) {
  /** edgeKey|nodeId → the y to attach at. */
  const out = new Map<string, number>();
  const groups = new Map<string, PortReq[]>();
  for (const r of reqs) {
    const k = `${r.nodeId}:${r.side}`;
    (groups.get(k) ?? (groups.set(k, []), groups.get(k)!)).push(r);
  }
  for (const [k, list] of groups) {
    const node = byId.get(list[0].nodeId)!;
    const h = nodeHeight(node);
    // Ports stay clear of the rounded corners, and never spread further than 18px apart — a fan
    // wider than that stops reading as "several edges on one card" and starts reading as several
    // unrelated things touching it.
    const usable = Math.max(0, Math.min(h - 36, (list.length - 1) * 18));
    list.sort((p, q) => p.sortY - q.sortY);
    list.forEach((r, i) => {
      const t = list.length === 1 ? 0.5 : i / (list.length - 1);
      out.set(`${r.edgeKey}|${r.nodeId}`, node.y - usable / 2 + usable * t);
    });
    void k;
  }
  return out;
}

/** Point on a cubic at t. The pill for a cross-column edge used to be placed at `gx`, the control
 *  point — but a cubic does not pass through its controls. With P1 and P2 both at gx the curve's
 *  midpoint sits at (x1 + x2 + 6·gx)/8, so every pill floated off the line it was labelling, by more
 *  the wider the gutter. Evaluating the curve is the fix; there is no shortcut that stays correct. */
function cubicAt(t: number, x1: number, y1: number, gx: number, x2: number, y2: number) {
  const u = 1 - t;
  return {
    x: u * u * u * x1 + 3 * u * u * t * gx + 3 * u * t * t * gx + t * t * t * x2,
    y: u * u * u * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y2,
  };
}

/** PILL PLACEMENT — the labels, separated from the lines that carry them.
 *
 *  Lanes guarantee that two STROKES read as two. They cannot guarantee it for labels, because a pill
 *  is ~3.5x the lane pitch wide: three edges converging on one card got three clear lines and three
 *  labels stacked on top of each other, which is worse than no labels at all — you can see there are
 *  relationships and cannot read any of them.
 *
 *  A pill's meaning does not depend on WHERE along its edge it sits, only on which edge it sits on.
 *  So the label can slide while the line stays put. Each pill proposes candidate positions along its
 *  own run, midpoint first and working outward, and takes the first that collides with nothing
 *  already placed.
 *
 *  When no candidate is clear, the edge DEMOTES TO A BADGE rather than shipping an unreadable label.
 *  That is the same ladder the rest of this file follows — legible or not drawn — extended from lines
 *  to the labels on them. Demoting the whole edge rather than just dropping its pill is deliberate:
 *  a bare unlabelled line in a cluster of labelled ones reads as a mistake, and the badge still
 *  carries both the kind and the other end, so nothing is lost.
 *
 *  Order matters and is deliberate: SHORTEST run first. A short run has the fewest places to put its
 *  label, so it should claim its spot while the board is empty; a long run has room to slide out of
 *  the way. Reversing this demotes the short edges, which are usually the tightly-related ones. */
function placePills(
  built: { edge: RoutedEdge; run: (t: number) => { x: number; y: number } }[],
  demote: (edge: RoutedEdge) => void,
) {
  const taken: { x1: number; y1: number; x2: number; y2: number }[] = [];
  const hits = (x: number, y: number, w: number) => {
    const box = { x1: x - w / 2 - PILL_GAP, y1: y - PILL_H / 2 - PILL_GAP, x2: x + w / 2 + PILL_GAP, y2: y + PILL_H / 2 + PILL_GAP };
    return taken.some((t) => !(box.x2 < t.x1 || box.x1 > t.x2 || box.y2 < t.y1 || box.y1 > t.y2));
  };

  // Midpoint first, then alternating outward — a label wants to be in the middle of its line and
  // should only move as far as it must.
  const OFFSETS = [0, -0.5, 0.5, -1, 1];

  for (const { edge, run } of [...built].sort((a, b) => runLength(a.run) - runLength(b.run))) {
    const pill = edge.pill;
    if (!pill) continue;

    let placed = false;
    for (const o of OFFSETS) {
      const p = run(0.5 + o * SLIDE);
      if (hits(p.x, p.y, pill.w)) continue;
      pill.x = p.x;
      pill.y = p.y;
      taken.push({
        x1: p.x - pill.w / 2 - PILL_GAP, y1: p.y - PILL_H / 2 - PILL_GAP,
        x2: p.x + pill.w / 2 + PILL_GAP, y2: p.y + PILL_H / 2 + PILL_GAP,
      });
      placed = true;
      break;
    }
    if (!placed) demote(edge);
  }
}

/** Crude length of a run, enough to order pills by how much room they have to slide. */
function runLength(run: (t: number) => { x: number; y: number }) {
  const a = run(0.5 - SLIDE);
  const b = run(0.5 + SLIDE);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function planEdges(placed: Placed[], edges: GEdge[] = []): EdgePlan {
  const byId = new Map(placed.map((p) => [p.id, p]));
  const cols = columnsOf(placed);
  const lines: RoutedEdge[] = [];
  const badges = new Map<string, { kind: string; other: string }[]>();
  /** gutter key → lanes. A gutter is identified by the column it hangs off. */
  const gutters = new Map<string, [number, number][][]>();
  const lanesFor = (k: string) => gutters.get(k) ?? (gutters.set(k, []), gutters.get(k)!);

  const toBadge = (e: GEdge, b: Placed) => {
    const list = badges.get(e.from) ?? [];
    list.push({ kind: e.kind ?? "branch", other: b.label });
    badges.set(e.from, list);
  };

  // ── PASS 1 · decide, without drawing ──────────────────────────────────────────────────────────
  // Which edges become lines, which gutter and lane each takes, and which side of which card each
  // end wants. Geometry cannot be built yet: a port depends on how many OTHER edges share that side,
  // which is only known once every edge has been classified.
  type Decided = {
    key: string; kind: string; a: Placed; b: Placed;
    mode: "same" | "cross"; gx: number; label: string; pw: number; dir: 1 | -1;
  };
  const decided: Decided[] = [];
  const reqs: PortReq[] = [];

  // ONE RELATIONSHIP, ONE REPRESENTATION.
  //
  // The judge emits edges per chunk and the relate pass adds more, so the same pair arrives twice —
  // often as A→B and B→A, which the route's dedupe (`from === from && to === to`) treats as two
  // different edges. Both then route independently, and because they compete for the same gutter one
  // wins a line while the other overflows to a badge. The board showed `blocks` as a drawn arrow AND
  // as a chip on the source card, saying the same thing twice and looking like two facts.
  //
  // Canonicalising on the UNORDERED pair fixes it at the only place that can see both. First wins, so
  // direction is whichever the model asserted first — the same "what arrived stays put" promise the
  // lane assignment makes.
  const seenPair = new Set<string>();
  const unique = edges.filter((e) => {
    const pair = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    if (seenPair.has(pair)) return false;
    seenPair.add(pair);
    return true;
  });

  for (const e of unique) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    // An endpoint that isn't on the board yet isn't a relationship yet. It will route on the frame
    // its card is revealed — no state to keep, nothing to clean up.
    if (!a || !b || a === b) continue;

    const label = EDGE_LABEL[e.kind ?? "branch"] ?? "";
    const pw = pillWidth(label);
    const lo = Math.min(a.y, b.y) - LANE_PAD;
    const hi = Math.max(a.y, b.y) + LANE_PAD;
    const key = `${e.from}->${e.to}`;

    // ── 1. same column: bow out into the right gutter ─────────────────────────────────────────
    if (Math.abs(a.x - b.x) < SAME_COL) {
      const colKey = cols.keyOf(a);
      const lane = takeLane(lanesFor(`r${colKey}`), lo, hi);
      if (lane < 0) { toBadge(e, b); continue; }

      const edge = Math.max(cols.rightOf(a), cols.rightOf(b));
      // The lane sits at a fixed x, and the pill sits ON it — so clearance is just the pill's own
      // half-width. No solving backwards through a curve's parametrisation.
      const gx = edge + Math.max(BOW, pw / 2 + PILL_MARGIN) + lane * LANE;

      // If the bow would reach into the next column, the gutter isn't wide enough for this
      // relationship and a badge says it better.
      if (gx + 4 > cols.nextLeft(colKey)) { toBadge(e, b); continue; }

      // Both ends leave on the RIGHT — that is what a same-column bow is. They are sorted by the
      // other end's height, so the upper card's edge leaves above the lower card's.
      decided.push({ key, kind: e.kind ?? "branch", a, b, mode: "same", gx, label, pw, dir: 1 });
      reqs.push({ edgeKey: key, nodeId: a.id, side: "R", sortY: b.y });
      reqs.push({ edgeKey: key, nodeId: b.id, side: "R", sortY: a.y });
      continue;
    }

    // ── 2. adjacent columns: S-curve through the gutter between them ──────────────────────────
    const ka = cols.keyOf(a);
    const kb = cols.keyOf(b);
    if (cols.between(ka, kb) > 0) { toBadge(e, b); continue; }

    const leftIsA = a.x < b.x;
    const gapL = leftIsA ? cols.rightOf(a) : cols.rightOf(b);
    const gapR = leftIsA ? b.x - halfW(b) : a.x - halfW(a);
    const gap = gapR - gapL;
    // The pill has to live in the gutter too. If the gutter can't hold it, this relationship can't
    // be a labelled line here.
    if (gap < pw + PILL_MARGIN * 2) { toBadge(e, b); continue; }

    const lane = takeLane(lanesFor(`g${Math.min(ka, kb)}-${Math.max(ka, kb)}`), lo, hi);
    if (lane < 0) { toBadge(e, b); continue; }

    // Lanes fan from the gutter's centre outward, so the first edge sits in the middle of the empty
    // space rather than hard against one column.
    const spread = ((lane + 1) >> 1) * LANE * (lane % 2 === 0 ? 1 : -1);
    const gx = (gapL + gapR) / 2 + spread;
    if (gx - pw / 2 < gapL + PILL_MARGIN || gx + pw / 2 > gapR - PILL_MARGIN) { toBadge(e, b); continue; }

    const dir: 1 | -1 = leftIsA ? 1 : -1;
    decided.push({ key, kind: e.kind ?? "branch", a, b, mode: "cross", gx, label, pw, dir });
    // Each end leaves on the side that faces the other card.
    reqs.push({ edgeKey: key, nodeId: a.id, side: dir === 1 ? "R" : "L", sortY: b.y });
    reqs.push({ edgeKey: key, nodeId: b.id, side: dir === 1 ? "L" : "R", sortY: a.y });
  }

  // ── PASS 2 · allocate ports ───────────────────────────────────────────────────────────────────
  const ports = assignPorts(reqs, byId);
  const portY = (key: string, n: Placed) => ports.get(`${key}|${n.id}`) ?? n.y;

  // ── PASS 3 · draw ─────────────────────────────────────────────────────────────────────────────
  // Each line is built with its RUN: a function from t to a point on the path it actually follows.
  // The pill then has somewhere honest to slide to, and pass 4 can move labels without touching a
  // single stroke.
  const built: { edge: RoutedEdge; run: (t: number) => { x: number; y: number }; d: Decided }[] = [];

  for (const d of decided) {
    const y1 = portY(d.key, d.a);
    const y2 = portY(d.key, d.b);

    if (d.mode === "same") {
      const x1 = d.a.x + halfW(d.a);
      const x2 = d.b.x + halfW(d.b);
      const edge: RoutedEdge = {
        key: d.key, kind: d.kind,
        d: bracket(x1, y1, x2, y2, d.gx),
        tail: { x: x1, y: y1 },
        pill: d.label ? { x: d.gx, y: (y1 + y2) / 2, w: d.pw, label: d.label } : null,
        head: { x: x2, y: y2, dir: 1 },
      };
      // The bow's vertical run is straight at x = gx, so t maps linearly onto it. Clamped inside the
      // corner radii, since a pill parked on a corner sits half off the line.
      built.push({
        edge, d,
        run: (t) => ({ x: d.gx, y: y1 + (y2 - y1) * Math.min(0.85, Math.max(0.15, t)) }),
      });
      continue;
    }

    const x1 = d.a.x + d.dir * halfW(d.a);
    const x2 = d.b.x - d.dir * halfW(d.b);
    const edge: RoutedEdge = {
      key: d.key, kind: d.kind,
      d: `M ${x1} ${y1} C ${d.gx} ${y1}, ${d.gx} ${y2}, ${x2} ${y2}`,
      tail: { x: x1, y: y1 },
      pill: d.label ? { x: d.gx, y: (y1 + y2) / 2, w: d.pw, label: d.label } : null,
      head: { x: x2, y: y2, dir: d.dir },
    };
    built.push({ edge, d, run: (t) => cubicAt(Math.min(0.85, Math.max(0.15, t)), x1, y1, d.gx, x2, y2) });
  }

  // ── PASS 4 · place the labels ─────────────────────────────────────────────────────────────────
  // Lines are final by here. Only pills move, and an edge whose pill cannot be made legible falls
  // back down the same ladder everything else uses.
  const demoted = new Set<string>();
  placePills(
    built.map(({ edge, run }) => ({ edge, run })),
    (edge) => {
      const b = built.find((x) => x.edge === edge);
      if (!b) return;
      demoted.add(edge.key);
      const list = badges.get(b.d.a.id) ?? [];
      list.push({ kind: b.d.kind, other: b.d.b.label });
      badges.set(b.d.a.id, list);
    },
  );

  for (const { edge } of built) if (!demoted.has(edge.key)) lines.push(edge);

  return { lines, badges };
}
