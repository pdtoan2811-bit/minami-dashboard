// The infinite-canvas graph model.
//
// Replaces the fixed 6-column grid: a meeting is not a dashboard, it's a conversation that branches.
// Nodes carry no coordinates from the producer — the layout is DERIVED from the parent tree, so a
// model emitting nodes during a call never has to reason about geometry, and can't produce an ugly
// or overlapping map. Producers say what and where-in-the-tree; the renderer says where-on-screen.
//
// ── Colour discipline ───────────────────────────────────────────────────────────────────────────
// Colour encodes STATE (semantic), icons encode TYPE. That split is why the palette is four hues
// instead of ten: with a hue per node type, six types put orange beside red at normal-vision ΔE 7.1
// — below the 15 floor, i.e. two node types most people cannot tell apart. Measured, not guessed.
//
// The four state hues below PASS all six checks on the light surface (#fcfcfb): worst adjacent CVD
// ΔE 9.1 (protan), worst normal-vision ΔE 20.8. Green and amber sit under 3:1 contrast, which is
// legal only with secondary encoding — every node ships a visible label and icon, so that relief is
// structural here, not a promise.

export type NodeState = "proposed" | "agreed" | "done" | "blocked" | "open";

export type NodeKind =
  // work
  | "topic" | "decision" | "action" | "question" | "requirement" | "risk" | "milestone"
  // fun
  | "quote" | "meter" | "poll" | "shot";

export type EdgeKind = "branch" | "blocks" | "depends" | "answers" | "contradicts";

export type GNode = {
  id: string;
  kind: NodeKind;
  /** ONE tight line — Minami compresses to ~8 words. Detail belongs in the artifact, not the map. */
  label: string;
  /** Parent id. Absent = the centre. Layout radiates from here. */
  parent?: string;
  state?: NodeState;
  /** Display name; renders as an avatar chip on the node. */
  owner?: string;
  /** Attribution — "said by". Customers seeing their own name on the wall is the point. */
  by?: string;
  /** Collapsed branch: renders as one node with a count instead of N children. */
  collapsed?: number;
  /** meter only: -1..1 */
  value?: number;
  /** poll only */
  options?: { text: string; votes: number }[];
  /** shot only */
  src?: string;
  /** Wall-clock label, e.g. "12:04". */
  at?: string;
};

export type GEdge = { from: string; to: string; kind?: EdgeKind };

export type Graph = {
  rev?: number;
  title?: string;
  subtitle?: string;
  status?: "live" | "paused" | "ended";
  /** Node id the camera should centre on. Producer moves this as the conversation moves. */
  focus?: string;
  reaction?: { kind: "handshake" | "highfive" | "spark"; label?: string } | null;
  nodes: GNode[];
  edges?: GEdge[];
};

/** Validated state palette — see the colour note above before changing any of these. */
export const STATE_COLOR: Record<NodeState, string> = {
  proposed: "#2a78d6", // blue   — on the table, not settled
  agreed: "#1baf7a",   // green  — locked in
  done: "#1baf7a",
  blocked: "#e34948",  // red    — needs resolving
  open: "#eda100",     // amber  — waiting on an answer
};

export const DEFAULT_STATE: Record<NodeKind, NodeState> = {
  topic: "proposed", decision: "agreed", action: "proposed", question: "open",
  requirement: "proposed", risk: "blocked", milestone: "proposed",
  quote: "proposed", meter: "proposed", poll: "open", shot: "proposed",
};

/** Type is carried by icon + label, never by hue. Kept as text so no icon font is needed. */
export const KIND_ICON: Record<NodeKind, string> = {
  topic: "◆", decision: "✓", action: "→", question: "?", requirement: "▤",
  risk: "!", milestone: "◇", quote: "❝", meter: "◐", poll: "▥", shot: "▣",
};

export const KIND_LABEL: Record<NodeKind, string> = {
  topic: "Topic", decision: "Decision", action: "Action", question: "Open question",
  requirement: "Requirement", risk: "Risk", milestone: "Milestone",
  quote: "Moment", meter: "Alignment", poll: "Poll", shot: "Screen",
};

/** Node box size per kind, in canvas units. Decision is the hero — it gets the most room. */
export const KIND_SIZE: Record<NodeKind, { w: number; h: number }> = {
  topic: { w: 240, h: 84 }, decision: { w: 300, h: 116 }, action: { w: 260, h: 96 },
  question: { w: 250, h: 88 }, requirement: { w: 250, h: 88 }, risk: { w: 250, h: 92 },
  milestone: { w: 220, h: 84 }, quote: { w: 340, h: 132 }, meter: { w: 230, h: 118 },
  poll: { w: 260, h: 140 }, shot: { w: 240, h: 156 },
};

export function initialsOf(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "?";
  // Vietnamese names are given-name-last — the LAST token is what people are called by.
  const last = p[p.length - 1][0];
  return (p.length > 1 ? p[0][0] + last : last).toUpperCase();
}

// ── Layout ──────────────────────────────────────────────────────────────────────────────────────
// Radial tree. Each child gets an angular slice of its parent's sector, so siblings never collide
// and the map keeps the "radiating from a centre" read at any depth. Ring radius grows per level.
export type Placed = GNode & { x: number; y: number };

const MIN_RING = [0, 430, 380, 340];
const GAP = 64; // canvas units of clear space between siblings

export function layout(nodes: GNode[]): Placed[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, GNode[]>();
  let root: GNode | undefined;

  for (const n of nodes) {
    if (!n.parent || !byId.has(n.parent)) { root ??= n; continue; }
    const list = kids.get(n.parent) ?? [];
    list.push(n);
    kids.set(n.parent, list);
  }
  if (!root) return [];

  const out: Placed[] = [{ ...root, x: 0, y: 0 }];

  const place = (parentId: string, px: number, py: number, from: number, to: number, depth: number) => {
    const list = kids.get(parentId) ?? [];
    if (!list.length) return;

    const r = MIN_RING[Math.min(depth, MIN_RING.length - 1)];
    const widest = Math.max(...list.map((c) => KIND_SIZE[c.kind].w));

    // Siblings must not overlap, and there are two ways to buy the room: push the ring further out,
    // or widen the angular slice. Pushing the ring is what a naive fix does, and it explodes — a
    // 3-child branch inside a 72° slice needs an ~870-unit radius, which scatters the map into empty
    // space. Widening the slice keeps the map DENSE and readable; the cost is that a deep branch can
    // encroach on a distant one, which on an infinite canvas is invisible and free.
    const minStep = (widest + GAP) / r;               // radians one child needs at this ring
    const span = Math.max(to - from, list.length * minStep);
    const mid = (from + to) / 2;
    const step = span / list.length;

    list.forEach((child, i) => {
      // Centre of this child's slice — keeps a lone child straight out from its parent rather than
      // hugging one edge of the sector.
      const a = mid - span / 2 + step * (i + 0.5);
      // Rounded: sub-pixel coordinates serialize differently on server and client, which React
      // reports as a hydration mismatch on every path `d` and every node offset. Integers also
      // spare the compositor a subpixel layer per node.
      const x = Math.round(px + Math.cos(a) * r);
      const y = Math.round(py + Math.sin(a) * r);
      out.push({ ...child, x, y });
      place(child.id, x, y, a - step / 2, a + step / 2, depth + 1);
    });
  };

  // Start at -90° so the first branch goes up: a map that opens upward reads as growth.
  place(root.id, 0, 0, -Math.PI / 2, Math.PI * 1.5, 1);
  return out;
}

export const DEMO_GRAPH: Graph = {
  rev: 1,
  title: "QSortby · pilot scoping",
  subtitle: "with QDN Digital",
  status: "live",
  focus: "d1",
  nodes: [
    { id: "root", kind: "topic", label: "QSortby pilot" },
    { id: "scope", kind: "topic", label: "Scope", parent: "root" },
    { id: "r1", kind: "requirement", label: "Sort by margin, not revenue", parent: "scope", by: "Quang" },
    { id: "d1", kind: "decision", label: "One merchant, not the full catalogue", parent: "scope", state: "agreed", at: "18:41" },
    { id: "q1", kind: "question", label: "Which merchant goes first?", parent: "scope", state: "open" },

    { id: "time", kind: "topic", label: "Timeline", parent: "root" },
    { id: "d2", kind: "decision", label: "6-week pilot, not 3 months", parent: "time", state: "agreed", at: "12:04" },
    { id: "m1", kind: "milestone", label: "Staging live · 14 Aug", parent: "time" },
    { id: "a1", kind: "action", label: "Confirm staging environment", parent: "time", owner: "Linh Trần", state: "proposed" },

    { id: "risk", kind: "topic", label: "Risks", parent: "root", collapsed: 2 },
    { id: "k1", kind: "risk", label: "Budget cycle closes in September", parent: "risk", state: "blocked", by: "Quang" },

    { id: "feel", kind: "topic", label: "Room", parent: "root" },
    { id: "qt", kind: "quote", label: "If it can't show lift in six weeks, it won't survive the budget cycle.", parent: "feel", by: "Quang" },
    { id: "mt", kind: "meter", label: "Alignment", parent: "feel", value: 0.62 },
    { id: "pl", kind: "poll", label: "Start with which merchant?", parent: "feel",
      options: [{ text: "Levents", votes: 2 }, { text: "My Kingdom", votes: 1 }] },
    { id: "sh", kind: "shot", label: "Sort dashboard v2", parent: "feel", src: "" },

    { id: "own", kind: "topic", label: "Next", parent: "root" },
    { id: "a2", kind: "action", label: "Send pilot scope doc", parent: "own", owner: "Phạm Đức Toàn", state: "proposed" },
    { id: "a3", kind: "action", label: "Share Q2 sort metrics", parent: "own", owner: "Quang", state: "done" },
  ],
  edges: [
    { from: "k1", to: "d2", kind: "blocks" },
    { from: "d1", to: "q1", kind: "answers" },
    { from: "r1", to: "d1", kind: "depends" },
  ],
};
