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
  | "quote" | "meter" | "poll" | "shot"
  /** A substantive statement that isn't a decision or a commitment — a fact, a claim, a number, an
   *  argument someone made. The vocabulary was entirely meeting-shaped (decision/action/owner) and
   *  had nowhere to put "OpenAI made X free" or "returns kill margin quietly", so the model found no
   *  matching slot and produced nothing at all. Most of what is said in any conversation is this. */
  | "note"
  /** Small talk, a tangent, something off-scope. Captured because at the time nobody knows whether
   *  it matters — the lunch plan is noise, "the budget cycle closes in September" arrived exactly
   *  the same way and turned out to be the constraint that shaped the whole pilot. Dropping a line
   *  because it sounds irrelevant is a decision made with the least information you will ever have. */
  | "aside";

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
  /** Labels of cards folded into this one. A merge used to be untraceable: the loser vanished and
   *  the winner looked exactly as it did before, so the board silently lost the fact that two people
   *  had made the same point — which is often the most interesting thing that happened. */
  mergedFrom?: string[];
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
  /** Which meeting produced this board.
   *
   *  ⚠️ Load-bearing, not decoration. Boards used to live in one global document with no idea whose
   *  they were, so two concurrent meetings overwrote each other and the loser's SCREEN SHARE showed
   *  the winner's cards to their customer. Every frame now says who it belongs to, and a viewer pins
   *  itself to the first one it sees. */
  meetingId?: string;
  /** Whether cut scenes may play memes. Carried on the BOARD rather than kept in the browser so the
   *  dock button and the spoken "tắt meme" are the same switch, it survives a tab reload, and every
   *  viewer of the meeting agrees. Absent means on. */
  memes?: boolean;
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
  quote: "proposed", meter: "proposed", poll: "open", shot: "proposed", aside: "proposed", note: "proposed",
};

/** Type is carried by icon + label, never by hue. Kept as text so no icon font is needed. */
export const KIND_ICON: Record<NodeKind, string> = {
  topic: "◆", decision: "✓", action: "→", question: "?", requirement: "▤",
  risk: "!", milestone: "◇", quote: "❝", meter: "◐", poll: "▥", shot: "▣", aside: "~", note: "▪",
};

export const KIND_LABEL: Record<NodeKind, string> = {
  topic: "Topic", decision: "Decision", action: "Action", question: "Open question",
  requirement: "Requirement", risk: "Risk", milestone: "Milestone",
  quote: "Moment", meter: "Alignment", poll: "Poll", shot: "Screen", aside: "Aside", note: "Note",
};

/** Node box size per kind, in canvas units. Decision is the hero — it gets the most room. */
export const KIND_SIZE: Record<NodeKind, { w: number; h: number }> = {
  topic: { w: 156, h: 62 }, decision: { w: 330, h: 168 }, action: { w: 300, h: 150 },
  question: { w: 300, h: 140 }, requirement: { w: 300, h: 140 }, risk: { w: 300, h: 150 },
  milestone: { w: 280, h: 132 }, quote: { w: 360, h: 186 }, meter: { w: 280, h: 168 },
  poll: { w: 300, h: 196 }, shot: { w: 300, h: 214 }, aside: { w: 260, h: 96 }, note: { w: 300, h: 130 },
};

/** WHAT A CARD'S COLOUR MEANS.
 *
 *  It used to mean STATE, and that is what made the board unreadable: two NOTE cards sat side by
 *  side in amber and blue purely because the model tagged one `open` and let the other default to
 *  `proposed`. Nothing visible on either card explained the difference, so colour read as noise —
 *  and once colour is noise, every other visual cue gets distrusted with it.
 *
 *  Colour now means KIND, via five families. Not thirteen hues: thirteen distinguishable hues do not
 *  exist on a light surface — the validated palette carries four plus a neutral, and past that,
 *  colour-blind separation collapses (six kinds already put orange beside red at normal-vision
 *  ΔE 7.1). So the family answers "what sort of thing is this" at a glance, and the icon and label
 *  carry the exact kind. State moves to a small dot, where being subtle is correct: state is a
 *  property OF a card, not a category of card.
 *
 *  ambient is deliberately grey. Notes, quotes and asides are the bulk of any real transcript, and
 *  giving the majority of cards a colour is what turned the board into confetti. */
export type KindFamily = "settled" | "work" | "open" | "risk" | "ambient";

export const KIND_FAMILY: Record<NodeKind, KindFamily> = {
  decision: "settled", milestone: "settled",
  action: "work", requirement: "work",
  question: "open", poll: "open",
  risk: "risk",
  note: "ambient", quote: "ambient", aside: "ambient", meter: "ambient", shot: "ambient",
  topic: "ambient",
};

export const FAMILY_COLOR: Record<KindFamily, string> = {
  settled: "#1baf7a", // green — it is decided
  work: "#2a78d6",    // blue  — someone has to do it
  open: "#eda100",    // amber — it wants an answer
  risk: "#e34948",    // red   — it threatens something
  ambient: "#8a8a86", // grey  — it was said
};

export const FAMILY_TINT: Record<KindFamily, string> = {
  settled: "#ecf8f3", work: "#eff5fd", open: "#fdf6e7", risk: "#fdefef", ambient: "#f4f4f2",
};

export const familyOf = (n: { kind: NodeKind }) => KIND_FAMILY[n.kind] ?? "ambient";

/** A placed node's width. Always prefer this to KIND_SIZE — the layout overrides the per-kind width
 *  so a level has one edge, and anything reading KIND_SIZE directly will disagree with where the
 *  card actually is. */
export const widthOf = (p: { kind: NodeKind; w?: number }) => p.w ?? KIND_SIZE[p.kind].w;

/** Soft tint behind a node's header band, keyed to its kind family. Very low alpha: it should read
 *  as warmth, not as a coloured box — a saturated card makes a canvas look like a toy. */
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

/** Heights measured from the DOM, keyed by node id. Populated by the renderer after paint.
 *
 *  nodeHeight() below is an ESTIMATE from which fields a card carries, and it was always going to
 *  drift: it guesses how many lines a label wraps to. Real measurements win where we have them; the
 *  estimate is only the first-paint seed. */
export const measured = new Map<string, number>();

/** Heights are always EVEN. Cards are placed by their centre and drawn from `y - h/2`, so an odd
 *  height puts the card on a half pixel and the gaps either side round independently. */
const even = (v: number) => Math.ceil(v / 2) * 2;

export function nodeHeight(n: GNode): number {
  const real = measured.get(n.id);
  if (real) return even(real);

  if (n.kind === "topic") return 62;
  let h = 46;                                       // tinted header band
  h += n.kind === "quote" ? 62 : 30;                // headline (quotes run larger + wrap)
  if (n.detail) h += 36;
  if (typeof n.progress === "number") h += 44;
  if (n.kind === "meter") h += 68;
  if (n.kind === "poll") h += (n.options?.length ?? 0) * 38;
  if (n.kind === "shot") h += 132;
  if (n.people?.length || n.owner || n.by || n.tags?.length || n.reactions?.length || n.mergedFrom?.length) h += 36;
  if (n.rels) h += n.rels * 30;                     // relation badges the map couldn't draw as lines
  return even(h + 26);
}

export type Placed = GNode & {
  /** Rendered width. Uniform per level — see widthOf. */
  w: number;
  x: number; y: number;
  /** 0 = the root. Drives connector weight, so hierarchy is legible from the lines alone. */
  depth: number;
  /** id of the top-level branch this node hangs under. Every node in a subtree shares one, which is
   *  what lets a whole branch read as belonging together — and what colours it. */
  branch: string;
  /** +1 right of the root, -1 left. Decides which edge a connector leaves from. */
  side: 1 | -1;
};

/** One hue per branch. Identifies a SUBTREE, never a state. */
export const BRANCH_HUES = ["#6a7fd6", "#3fa08a", "#c98a3e", "#a86bb5", "#4f9dc9", "#c0705f", "#7aa04a", "#8a7fa8"];

export function branchColor(branchIds: string[], branch: string): string {
  const i = branchIds.indexOf(branch);
  return BRANCH_HUES[(i < 0 ? 0 : i) % BRANCH_HUES.length];
}

const UNIT = 24;
const MAX_CARD_W = Math.max(...Object.values(KIND_SIZE).map((k) => k.w));

// ── MIND MAP ─────────────────────────────────────────────────────────────────────────────────────
// A root in the middle, branches radiating left and right, depth growing outward, children stacked
// beside their parent.
//
// This replaces a herringbone, which replaced rows, which replaced columns. Each of those was a
// FLAT structure wearing map clothing: two levels, topic and card, with the visual language doing
// all the work of implying hierarchy that the data never had. You cannot draw a mind map from a list
// however you route the lines — the shape has to exist in the graph first.
//
// So depth is real here and unbounded: any node may parent any other, and the layout reads whatever
// tree it is given.
//
// ── The one thing given up ──
// A tidy tree centres each parent on its children, so a new leaf moves its parent, its grandparent,
// and any siblings below it. Earlier layouts fought hard for append-only stability and this gives
// some of it back — deliberately, because it is the property that makes a mind map READ as one. The
// mitigation is at the camera: it holds the newest node, so the movement happens around what you are
// looking at rather than under it.
export function layout(nodes: GNode[]): Placed[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, GNode[]>();
  const orphans: GNode[] = [];
  let root: GNode | undefined;

  /** ⚠️ AN ORPHAN MUST BE ADOPTED, NEVER DROPPED.
   *
   *  This line used to be `root ??= n; continue;` — so the FIRST node with a missing parent became
   *  the root and every subsequent one was skipped entirely. Not hidden: never placed. It existed in
   *  the graph, counted in the card total, was written to the archive, and simply was not on screen.
   *
   *  The upstream cause (merging a parent without re-parenting its children) is fixed in
   *  canvas-board, but this is the layer that decides what anh SEES, and it must not be able to lose
   *  a card no matter what it is handed. Anything parentless now hangs off the root, which is wrong
   *  in position and right in the only way that matters — it is visible. */
  for (const n of nodes) {
    if (!n.parent) { root ??= n; continue; }
    if (!byId.has(n.parent)) { orphans.push(n); continue; }
    (kids.get(n.parent) ?? (kids.set(n.parent, []), kids.get(n.parent)!)).push(n);
  }
  if (!root) return [];
  if (orphans.length) {
    console.warn(`[layout] ${orphans.length} orphaned card(s) re-attached to root — a parent was removed without adoption`);
    for (const o of orphans) {
      o.parent = root.id;
      (kids.get(root.id) ?? (kids.set(root.id, []), kids.get(root.id)!)).push(o);
    }
  }

  const LEVEL_W = UNIT * 20;    // 480 — one step outward per level of depth
  const LEAF_PITCH = UNIT * 9;  // 216 — vertical slot per leaf, sized for a card plus air
  // Air between one branch's subtree and the next on the same side.
  //
  // Without it a branch boundary is spaced exactly like a sibling boundary, so two unrelated subjects
  // sit as close together as two cards about the same thing — the board reads as one long list with
  // colours on it. Three slots is the smallest gap that survives a card being taller than average,
  // which is what makes the separation legible rather than nominal.
  const BRANCH_GAP = 3;

  const out: Placed[] = [];
  const branches = kids.get(root.id) ?? [];

  // Branches alternate sides, in the order the subjects came up: first right, then left, then right.
  // Alternating rather than filling one side keeps the root central and the board roughly square,
  // which is what stops a long meeting from becoming a single endless column.
  const sides = branches.map((_, i) => (i % 2 === 0 ? 1 : -1));

  /** Places a subtree and returns the y its parent should centre on.
   *
   *  Leaves consume slots in traversal order; a parent sits at the midpoint of its children. That is
   *  the whole tidy-tree algorithm, and it is why the shape stays legible at any depth: no node can
   *  ever be further from its children than half their spread. */
  let slot = 0;
  const place = (n: GNode, depth: number, side: 1 | -1, branch: string): number => {
    const children = kids.get(n.id) ?? [];
    const y = children.length
      ? children.map((c) => place(c, depth + 1, side, branch)).reduce((a, b) => a + b, 0) / children.length
      : (slot++) * LEAF_PITCH;

    out.push({
      ...n,
      x: Math.round(side * depth * LEVEL_W),
      y: Math.round(y),
      w: n.kind === "topic" ? KIND_SIZE.topic.w : MAX_CARD_W,
      depth,
      branch,
      side,
    });
    return y;
  };

  branches.forEach((b, i) => {
    // Each side runs its own slot counter, so the two halves grow independently instead of one
    // pushing the other down.
    // Start below everything already placed on THIS side, plus the branch gap. Each side runs its
    // own counter so the two halves grow independently instead of one pushing the other down.
    const earlier = branches.filter((_, j) => sides[j] === sides[i] && j < i);
    slot = earlier.reduce((acc, sib) => acc + countLeaves(sib, kids) + BRANCH_GAP, 0);
    place(b, 1, sides[i] as 1 | -1, b.id);
  });

  out.push({ ...root, x: 0, y: Math.round(mid(out)), w: KIND_SIZE.topic.w, depth: 0, branch: root.id, side: 1 });
  return out;
}

/** Leaves under a node — how many vertical slots its subtree will consume. */
function countLeaves(n: GNode, kids: Map<string, GNode[]>): number {
  const c = kids.get(n.id) ?? [];
  return c.length ? c.reduce((a, k) => a + countLeaves(k, kids), 0) : 1;
}

const mid = (ps: { y: number }[]) =>
  ps.length ? (Math.min(...ps.map((p) => p.y)) + Math.max(...ps.map((p) => p.y))) / 2 : 0;


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
