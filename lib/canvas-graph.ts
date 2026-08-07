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

/** One-shot effects. These are a VOCABULARY, not decoration: each is bound to a specific semantic
 *  event, so a viewer learns what a movement means without being told. Reusing "glow" for two
 *  different meanings would destroy that, which is why the list is short and deliberately boring to
 *  extend. */
export type NodeFx =
  | "shake"   // a risk or blocker landing — jarring on purpose
  | "jump"    // emphasis; Minami is pointing at this
  | "glow";   // resolved into something good

export type NodeKind =
  // work
  | "topic" | "decision" | "action" | "question" | "requirement" | "risk" | "milestone"
  // fun
  | "quote" | "meter" | "poll" | "shot";

export type EdgeKind = "branch" | "blocks" | "depends" | "answers" | "contradicts";

export type GNode = {
  id: string;
  kind: NodeKind;
  /** ONE tight line — Minami compresses to ~8 words. The headline. */
  label: string;
  /** A supporting line under the headline. This is most of what makes a node feel like a THING
   *  rather than a label: the headline says what, the detail says why it matters. */
  detail?: string;
  /** Short chips — "scope", "pricing", "blocker". Give the map texture at a glance. */
  tags?: string[];
  /** Emoji reactions accumulated on this node during the call. The fun layer, attached to meaning
   *  rather than floating: a 🎉 sits ON the decision that earned it. */
  reactions?: { emoji: string; count: number }[];
  /** Avatar stack — everyone involved, not just the single owner. */
  people?: string[];
  /** 0..1, drawn as a bar. Used by milestone and action. */
  progress?: number;
  /** Count of relation badges this node will wear. Set by the renderer before layout so the height
   *  estimate matches what actually draws — badges are ~30px each and were enough to reintroduce
   *  collisions when unaccounted for. */
  rels?: number;
  /** Transient effect, cleared by the player after it plays. */
  fx?: NodeFx;
  /** Set while this node is being absorbed into another: it flies to the target and fades, then the
   *  player deletes it. Two phases because a node that simply vanishes reads as a bug — the merge
   *  has to be legible as "this became part of that". */
  mergingInto?: string;
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
  topic: { w: 210, h: 62 }, decision: { w: 330, h: 168 }, action: { w: 300, h: 150 },
  question: { w: 300, h: 140 }, requirement: { w: 300, h: 140 }, risk: { w: 300, h: 150 },
  milestone: { w: 280, h: 132 }, quote: { w: 360, h: 186 }, meter: { w: 280, h: 168 },
  poll: { w: 300, h: 196 }, shot: { w: 300, h: 214 },
};

/** Soft tint behind a node's header band, keyed to its state colour. Kept at very low alpha: the
 *  tint should read as *warmth*, not as a coloured box — a saturated card is what makes a canvas
 *  look like a toy rather than a tool. */
export const TINT: Record<NodeState, string> = {
  proposed: "#eff5fd", agreed: "#ecf8f3", done: "#ecf8f3",
  blocked: "#fdefef", open: "#fdf6e7",
};

export function initialsOf(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "?";
  // Vietnamese names are given-name-last — the LAST token is what people are called by.
  const last = p[p.length - 1][0];
  return (p.length > 1 ? p[0][0] + last : last).toUpperCase();
}

// ── Layout ──────────────────────────────────────────────────────────────────────────────────────
// A BALANCED HORIZONTAL TREE, not a radial starburst.
//
// Radial looks like a mind map and reads like nothing: nodes land at arbitrary angles, so there is
// no entry point and no scan order, and long branches sweep across the middle crossing everything
// else. It also put text baselines at every position on a circle, which is exactly as hard to read
// as it sounds.
//
// This is what actual mind-map tools do. The root sits at the centre; top-level branches alternate
// right and left; each side is a tidy tree where depth moves horizontally and siblings STACK
// vertically. The consequences are all the ones we want:
//   · a real reading order — out from the middle, top to bottom within a branch
//   · siblings cannot overlap, by construction: each is allotted its own subtree height
//   · every card shares a baseline with its siblings, so the eye tracks along a row
//   · edges become short horizontal hops instead of long diagonal sweeps
export type Placed = GNode & {
  x: number; y: number;
  /** 0 = root. Drives edge weight, so hierarchy is legible from the lines alone. */
  depth: number;
  /** id of the top-level topic this node hangs under. Every node in a branch shares one, which is
   *  what lets a whole subtree read as belonging together. */
  branch: string;
};

/** Eight branch hues. These identify a SUBTREE, never a state — they appear only on edges and a
 *  small dot, never as a node's fill, so they can't be confused with the semantic state colours.
 *  Assigned by order of appearance so the same meeting always colours the same way. */
export const BRANCH_HUES = ["#6a7fd6", "#3fa08a", "#c98a3e", "#a86bb5", "#4f9dc9", "#c0705f", "#7aa04a", "#8a7fa8"];

export function branchColor(branchIds: string[], id: string): string {
  const i = branchIds.indexOf(id);
  return BRANCH_HUES[(i < 0 ? 0 : i) % BRANCH_HUES.length];
}

/** CONTENT-AWARE height. KIND_SIZE.h is a MINIMUM, not the rendered height — a card grows with its
 *  detail line, progress bar, poll rows and footer. Spacing against the minimum is what let two
 *  action cards render flush against each other. Estimating from the same fields the renderer uses
 *  keeps the two in step without a DOM measure-and-reflow pass. Errs high on purpose: too much air
 *  between siblings is untidy, too little is a collision. */
export function nodeHeight(n: GNode): number {
  if (n.kind === "topic") return 62;
  let h = 46;                                       // tinted header band
  h += n.kind === "quote" ? 62 : 30;                // headline (quotes run larger + wrap)
  if (n.detail) h += 36;                            // supporting line, up to 2 rows
  if (typeof n.progress === "number") h += 44;
  if (n.kind === "meter") h += 68;
  if (n.kind === "poll") h += (n.options?.length ?? 0) * 38;
  if (n.kind === "shot") h += 132;
  if (n.people?.length || n.owner || n.by || n.tags?.length || n.reactions?.length) h += 36;
  if (n.rels) h += n.rels * 30;                     // relation badges the map couldn't draw as lines
  return h + 26;                                    // vertical padding
}

/** Semantic order among siblings. Without this a column is whatever order the producer happened to
 *  emit in, so a risk can sit between two actions and it reads as a pile. Structure first, then what
 *  was settled, then what is still open, then work, then the ambient/fun nodes. */
const KIND_ORDER: NodeKind[] = [
  "decision", "requirement", "question", "risk",
  "milestone", "action", "quote", "meter", "poll", "shot",
  // Sub-sections LAST. With topics first, a parent's own cards rendered after an entire nested
  // group's descendants, which made the order look random — a direct child of Scope appearing
  // below everything inside "Other signals".
  "topic",
];
const rank = (n: GNode) => {
  const i = KIND_ORDER.indexOf(n.kind);
  return i < 0 ? KIND_ORDER.length : i;
};

// FREESTYLE BOARD.
//
// Fifth layout, and the mistake in the fourth was reading "freestyle" as "random". A golden-angle
// scatter with cards orbiting at arbitrary angles produces placement that looks accidental, not
// designed — big holes on one side, clusters bunched on the other, cards sitting at odd diagonal
// offsets from each other.
//
// A real workshop board isn't random either. The GROUPS sit wherever they landed, but the cards
// INSIDE a group are tidy — squared up, evenly spaced, because a human tidied them while talking.
// That distinction is the whole thing:
//
//   inside a cluster  → neat, packed, aligned      (order where the eye reads)
//   between clusters  → loose flow, uneven rows    (freedom where the structure is)
//
// So clusters pack their own cards into a small grid, then flow across the board left-to-right,
// wrapping into rows, with a deterministic offset per cluster so the rows never line up into a
// spreadsheet. Same meeting, same board — no jitter between renders.
const CARD_GAP_Y = 26;      // between stacked cards in a cluster
const STEM = 110;           // gap between a topic node and its cards — room for the edge to read
const CLUSTER_GAP_X = 170;
const CLUSTER_GAP_Y = 110;
const BOARD_W = 3400;       // wrap width; the board grows downward, like a real one

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

  for (const [k, list] of kids) {
    kids.set(k, list.map((n, i) => ({ n, i })).sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i).map((o) => o.n));
  }

  // Every topic is a cluster, at any depth — a sub-topic on a freestyle board is just a topic.
  // Topics holding no cards of their own are skipped: their material lives in the clusters promoted
  // out of them, and an empty label floating in space has nothing to say.
  const clusters = nodes.filter(
    (n) => n.kind === "topic" && n.id !== root.id &&
           (kids.get(n.id) ?? []).some((c) => c.kind !== "topic"),
  );

  // ── each cluster is a small left-to-right mindmap ─────────────────────────────────────────────
  // The topic is a ROOT NODE on the left; its cards fan out to the right, connected by edges. That's
  // the mindmap logic — a heading floating above a tidy grid described the grouping but never showed
  // the relationship, and with no edges at all the cards read as an unattached pile.
  type Packed = { topic: GNode; cells: { n: GNode; dy: number }[]; w: number; h: number; cardX: number };
  const packed: Packed[] = clusters.map((topic) => {
    const members = (kids.get(topic.id) ?? []).filter((c) => c.kind !== "topic");
    const cardW = Math.max(...members.map((m) => KIND_SIZE[m.kind].w));
    let dy = 0;
    const cells = members.map((n) => {
      const cell = { n, dy: dy + nodeHeight(n) / 2 };
      dy += nodeHeight(n) + CARD_GAP_Y;
      return cell;
    });
    const topicW = KIND_SIZE.topic.w;
    return {
      topic, cells,
      cardX: topicW + STEM,
      w: topicW + STEM + cardW,
      h: Math.max(dy - CARD_GAP_Y, KIND_SIZE.topic.h),
    };
  });

  // ── flow the clusters across the board ────────────────────────────────────────────────────────
  const out: Placed[] = [];
  let x = 0, y = 0, rowH = 0, row = 0;

  packed.forEach((p, i) => {
    if (x > 0 && x + p.w > BOARD_W) { x = 0; y += rowH + CLUSTER_GAP_Y; rowH = 0; row++; }
    // Deterministic offset — enough to break the grid, never enough to look accidental. Derived from
    // the index so it's stable across renders.
    const ox = x + ((i * 37) % 11 - 5) * 9 + (row % 2 ? 34 : 0);
    const oy = y + ((i * 53) % 7 - 3) * 10;

    // Topic sits at the vertical CENTRE of what it carries, so the edges fan symmetrically instead
    // of all raking downward from a corner.
    out.push({
      ...p.topic,
      x: Math.round(ox + KIND_SIZE.topic.w / 2),
      y: Math.round(oy + p.h / 2),
      depth: 1, branch: p.topic.id,
    });
    for (const c of p.cells) {
      out.push({
        ...c.n,
        x: Math.round(ox + p.cardX + KIND_SIZE[c.n.kind].w / 2),
        y: Math.round(oy + c.dy),
        depth: 2, branch: p.topic.id,
      });
    }

    x += p.w + CLUSTER_GAP_X;
    rowH = Math.max(rowH, p.h);
  });

  // Centre the board on the origin so the camera's maths stays symmetrical.
  if (out.length) {
    const xs = out.map((n) => n.x), ys = out.map((n) => n.y);
    const sx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const sy = (Math.min(...ys) + Math.max(...ys)) / 2;
    for (const n of out) { n.x -= sx; n.y -= sy; }
  }
  return out;
}

/** Extent of one topic cluster — the camera's "establishing shot" target for a topic. */
export function columnBounds(placed: Placed[], branch: string) {
  const own = placed.filter((p) => p.branch === branch);
  if (!own.length) return null;
  const t = Math.min(...own.map((p) => p.y - nodeHeight(p) / 2));
  const b = Math.max(...own.map((p) => p.y + nodeHeight(p) / 2));
  const l = Math.min(...own.map((p) => p.x - KIND_SIZE[p.kind].w / 2));
  const r = Math.max(...own.map((p) => p.x + KIND_SIZE[p.kind].w / 2));
  return { w: r - l, h: b - t, cx: (l + r) / 2, cy: (t + b) / 2 };
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
    { id: "r1", kind: "requirement", label: "Sort by margin, not revenue",
      detail: "Revenue ranking buries the products that actually pay for the store.",
      parent: "scope", by: "Quang", tags: ["scope"], reactions: [{ emoji: "💯", count: 2 }] },
    { id: "d1", kind: "decision", label: "One merchant, not the full catalogue",
      detail: "Narrowed from 12 stores so we can show lift inside the pilot window.",
      parent: "scope", state: "agreed", at: "18:41",
      people: ["Phạm Đức Toàn", "Quang", "Linh Trần"], tags: ["scope"],
      reactions: [{ emoji: "🎉", count: 3 }, { emoji: "🤝", count: 1 }] },
    { id: "q1", kind: "question", label: "Which merchant goes first?",
      detail: "Needs a store with clean margin data and enough weekly volume.",
      parent: "scope", state: "open", tags: ["blocker"] },

    { id: "time", kind: "topic", label: "Timeline", parent: "root" },
    { id: "d2", kind: "decision", label: "6-week pilot, not 3 months",
      detail: "Has to land before the September budget cycle closes.",
      parent: "time", state: "agreed", at: "12:04", people: ["Quang", "Phạm Đức Toàn"],
      reactions: [{ emoji: "🔥", count: 2 }] },
    { id: "m1", kind: "milestone", label: "Staging live · 14 Aug",
      detail: "Sort engine pointed at real catalogue data.", parent: "time", progress: 0.35 },
    { id: "a1", kind: "action", label: "Confirm staging environment",
      detail: "Needs the merchant's product feed and a read-only API key.",
      parent: "time", owner: "Linh Trần", state: "proposed", progress: 0.2, tags: ["setup"] },

    { id: "risk", kind: "topic", label: "Risks", parent: "root", collapsed: 2 },
    { id: "k1", kind: "risk", label: "Budget cycle closes in September",
      detail: "If lift isn't provable by then, the pilot doesn't get renewed.",
      parent: "risk", state: "blocked", by: "Quang", tags: ["timing"] },

    { id: "feel", kind: "topic", label: "The room", parent: "root" },
    { id: "qt", kind: "quote", label: "If it can't show lift in six weeks, it won't survive the budget cycle.",
      parent: "feel", by: "Quang", at: "04:12", reactions: [{ emoji: "👏", count: 2 }] },
    { id: "mt", kind: "meter", label: "Alignment", detail: "Converging since the scope narrowed.",
      parent: "feel", value: 0.62 },
    { id: "pl", kind: "poll", label: "Start with which merchant?", parent: "feel",
      options: [{ text: "Levents", votes: 2 }, { text: "My Kingdom", votes: 1 }],
      reactions: [{ emoji: "🗳️", count: 3 }] },
    { id: "sh", kind: "shot", label: "Sort dashboard v2",
      detail: "Shared by Linh at 09:14", parent: "feel", src: "" },

    { id: "own", kind: "topic", label: "Next", parent: "root" },
    { id: "a2", kind: "action", label: "Send pilot scope doc",
      detail: "One pager: success metric, window, what we need from them.",
      parent: "own", owner: "Phạm Đức Toàn", state: "proposed", progress: 0.6, tags: ["followup"] },
    { id: "a3", kind: "action", label: "Share Q2 sort metrics",
      detail: "Baseline to measure the pilot against.",
      parent: "own", owner: "Quang", state: "done", progress: 1,
      reactions: [{ emoji: "✅", count: 1 }] },
  ],
  edges: [
    { from: "k1", to: "d2", kind: "blocks" },
    { from: "d1", to: "q1", kind: "answers" },
    { from: "r1", to: "d1", kind: "depends" },
  ],
};
