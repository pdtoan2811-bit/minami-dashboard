// Scripted meetings that drive the canvas, for demoing and for design work.
//
// These exist because the canvas is impossible to judge from a static snapshot. What matters is the
// CHOREOGRAPHY — a line is spoken, Minami decides something is worth keeping, a node drops in, the
// camera moves, a reaction lands. Getting that rhythm right is most of whether the thing feels alive
// or feels like a dashboard that occasionally twitches.
//
// A step is one transcript line plus zero or more canvas actions. The player applies them on a
// timer; the transcript panel renders the same steps as a log. One source, two views, so what you
// see in the panel is exactly what drove the map.

import type { GNode, NodeState } from "@/lib/canvas-graph";

export type Action =
  | { kind: "add"; node: GNode }
  | { kind: "focus"; id: string }
  | { kind: "state"; id: string; state: NodeState }
  | { kind: "react"; id: string; emoji: string }
  | { kind: "collapse"; id: string; count: number }
  | { kind: "celebrate"; label: string; glyph?: "handshake" | "highfive" | "spark" };

export type Step = {
  /** ms after the previous step. Pacing is content: a decision landing needs a beat before the
   *  celebration, or the two read as one event. */
  gap: number;
  who: string;
  say: string;
  /** What Minami does in response. Empty = she listened and decided nothing was worth keeping,
   *  which is most lines in a real meeting and important to show. */
  does?: Action[];
};

export type DemoScript = {
  id: string;
  name: string;
  blurb: string;
  title: string;
  subtitle: string;
  /** Nodes present before the first line — the skeleton Minami starts from. */
  seed: GNode[];
  steps: Step[];
};

const T = (id: string, label: string, parent?: string): GNode => ({ id, kind: "topic", label, parent });

// ── 1 · Customer pilot scoping ──────────────────────────────────────────────────────────────────
const pilot: DemoScript = {
  id: "pilot",
  name: "Pilot scoping",
  blurb: "Customer call · scope, timeline, a decision landing",
  title: "QSortby · pilot scoping",
  subtitle: "with QDN Digital",
  seed: [T("root", "QSortby pilot"), T("scope", "Scope", "root"), T("time", "Timeline", "root")],
  steps: [
    { gap: 0, who: "Quang", say: "So the thing that actually bothers us — the sort puts our worst-margin products on page one." },
    { gap: 2600, who: "Toàn", say: "Right, because it's ranking on revenue. Margin never enters it.",
      does: [
        { kind: "add", node: { id: "r1", kind: "requirement", label: "Sort by margin, not revenue", detail: "Revenue ranking buries the products that actually pay for the store.", parent: "scope", by: "Quang", tags: ["scope"] } },
        { kind: "focus", id: "r1" },
      ] },
    { gap: 2800, who: "Quang", say: "Can we try it across all twelve stores?" },
    { gap: 2200, who: "Toàn", say: "I'd rather do one properly than twelve badly. We won't see signal otherwise.",
      does: [
        { kind: "add", node: { id: "d1", kind: "decision", label: "One merchant, not the full catalogue", detail: "Narrowed from 12 stores so lift is provable inside the window.", parent: "scope", state: "proposed", tags: ["scope"], people: ["Phạm Đức Toàn"] } },
        { kind: "focus", id: "d1" },
      ] },
    { gap: 3000, who: "Quang", say: "Fine. One store, but I want weekly numbers, not a report at the end." },
    { gap: 2400, who: "Toàn", say: "Weekly it is.",
      does: [
        { kind: "state", id: "d1", state: "agreed" },
        { kind: "react", id: "d1", emoji: "🤝" },
        { kind: "celebrate", label: "Scope agreed", glyph: "handshake" },
      ] },
    { gap: 3200, who: "Quang", say: "Which store though? That's not obvious.",
      does: [
        { kind: "add", node: { id: "q1", kind: "question", label: "Which merchant goes first?", detail: "Needs clean margin data and enough weekly volume.", parent: "scope", state: "open", tags: ["blocker"] } },
        { kind: "focus", id: "q1" },
      ] },
    { gap: 2600, who: "Toàn", say: "Let's park that and come back with two candidates on Friday." },
    { gap: 2400, who: "Quang", say: "The other constraint is our budget cycle closes in September.",
      does: [
        { kind: "add", node: { id: "k1", kind: "risk", label: "Budget cycle closes in September", detail: "No provable lift by then and the pilot doesn't renew.", parent: "time", state: "blocked", by: "Quang", tags: ["timing"] } },
        { kind: "focus", id: "k1" },
      ] },
    { gap: 2800, who: "Toàn", say: "Then six weeks, not three months. That lands well before it.",
      does: [
        { kind: "add", node: { id: "d2", kind: "decision", label: "6-week pilot, not 3 months", detail: "Lands before the September budget cycle closes.", parent: "time", state: "agreed", people: ["Quang", "Phạm Đức Toàn"] } },
        { kind: "focus", id: "d2" },
        { kind: "react", id: "d2", emoji: "🔥" },
      ] },
    { gap: 2600, who: "Quang", say: "Works. Send me the scope doc and I'll get it signed off.",
      does: [
        { kind: "add", node: { id: "a1", kind: "action", label: "Send pilot scope doc", detail: "Success metric, window, what we need from them.", parent: "time", owner: "Phạm Đức Toàn", state: "proposed", progress: 0, tags: ["followup"] } },
        { kind: "focus", id: "a1" },
      ] },
  ],
};

// ── 2 · Investor intro ──────────────────────────────────────────────────────────────────────────
const investor: DemoScript = {
  id: "investor",
  name: "Investor intro",
  blurb: "External · pushback, alignment moving in real time",
  title: "Ecom Intel · investor intro",
  subtitle: "Minami announced · recording",
  seed: [T("root", "Ecom Intel"), T("trac", "Traction", "root"), T("raise", "The raise", "root")],
  steps: [
    { gap: 0, who: "Sarah", say: "Walk me through what's actually working. Not the deck — what's working." },
    { gap: 2600, who: "Toàn", say: "Retention. Merchants who connect two sources stay at ninety-one percent after six months.",
      does: [
        { kind: "add", node: { id: "t1", kind: "requirement", label: "91% 6-month retention, 2+ sources", detail: "Single-source merchants churn at roughly triple the rate.", parent: "trac", by: "Phạm Đức Toàn", tags: ["metric"] } },
        { kind: "focus", id: "t1" },
        { kind: "add", node: { id: "mt", kind: "meter", label: "Alignment", detail: "Reading the room.", parent: "root", value: 0.15 } },
      ] },
    { gap: 3000, who: "Sarah", say: "Ninety-one on what base? If that's forty merchants it isn't a number yet." },
    { gap: 2200, who: "Toàn", say: "Two hundred and thirty.",
      does: [{ kind: "state", id: "mt", state: "proposed" }] },
    { gap: 2400, who: "Sarah", say: "Okay. That's more interesting. And the timeline you're raising against?" },
    { gap: 2600, who: "Toàn", say: "Eighteen months to a Series A metric.",
      does: [
        { kind: "add", node: { id: "q1", kind: "question", label: "Is 18 months enough runway?", detail: "Sarah pushed back — wants 24 with the current burn.", parent: "raise", state: "open", tags: ["raise"] } },
        { kind: "focus", id: "q1" },
      ] },
    { gap: 2800, who: "Sarah", say: "Eighteen is tight. Most of my portfolio needed twenty-four to get there." },
    { gap: 2400, who: "Toàn", say: "That's fair. I'd rather plan for twenty-four and beat it." },
    { gap: 2600, who: "Sarah", say: "Good answer. Send the cohort retention broken out and I'll bring it to the partnership.",
      does: [
        { kind: "add", node: { id: "a1", kind: "action", label: "Send cohort retention breakdown", detail: "Split by source count, 6 and 12 month.", parent: "raise", owner: "Phạm Đức Toàn", state: "proposed", tags: ["followup"] } },
        { kind: "focus", id: "a1" },
      ] },
    { gap: 2600, who: "Sarah", say: "And let's get a second call with the full partnership in two weeks.",
      does: [
        { kind: "add", node: { id: "d1", kind: "decision", label: "Second call with the full partnership", detail: "Two weeks out, contingent on the cohort data.", parent: "raise", state: "agreed", people: ["Sarah Chen", "Phạm Đức Toàn"] } },
        { kind: "focus", id: "d1" },
        { kind: "react", id: "d1", emoji: "🎉" },
        { kind: "celebrate", label: "Second call booked", glyph: "handshake" },
      ] },
  ],
};

// ── 3 · Brand workshop ──────────────────────────────────────────────────────────────────────────
const workshop: DemoScript = {
  id: "workshop",
  name: "Brand workshop",
  blurb: "Creative · mood board, a poll, the fun nodes",
  title: "Ecom Intel · brand direction",
  subtitle: "workshop with Ownego",
  seed: [T("root", "Brand direction"), T("look", "Look & feel", "root"), T("name", "Naming", "root")],
  steps: [
    { gap: 0, who: "Linh", say: "I pulled a few references. This first one is what I keep coming back to." },
    { gap: 2400, who: "Toàn", say: "The restraint is right. It doesn't look like a dashboard company.",
      does: [
        { kind: "add", node: { id: "s1", kind: "shot", label: "Reference · editorial grid", detail: "Shared by Linh at 03:12", parent: "look", src: "" } },
        { kind: "focus", id: "s1" },
      ] },
    { gap: 2800, who: "Linh", say: "The other direction is warmer. More colour, more personality." },
    { gap: 2200, who: "Toàn", say: "Let's actually put it to the room.",
      does: [
        { kind: "add", node: { id: "p1", kind: "poll", label: "Which direction?", parent: "look", options: [{ text: "Editorial restraint", votes: 0 }, { text: "Warm & playful", votes: 0 }], state: "open" } },
        { kind: "focus", id: "p1" },
      ] },
    { gap: 2600, who: "Linh", say: "Editorial for me.",
      does: [{ kind: "add", node: { id: "p1", kind: "poll", label: "Which direction?", parent: "look", options: [{ text: "Editorial restraint", votes: 2 }, { text: "Warm & playful", votes: 1 }], state: "open" } }] },
    { gap: 2400, who: "Toàn", say: "Three to one. Editorial, with warmth in the motion rather than the colour.",
      does: [
        { kind: "add", node: { id: "d1", kind: "decision", label: "Editorial base, warmth in motion", detail: "Restraint in colour and type; personality carried by movement.", parent: "look", state: "agreed", people: ["Linh Trần", "Phạm Đức Toàn"] } },
        { kind: "focus", id: "d1" },
        { kind: "react", id: "d1", emoji: "🎨" },
      ] },
    { gap: 3000, who: "Linh", say: "On the name — I still think 'Intel' makes people think chips." },
    { gap: 2400, who: "Toàn", say: "It's the clearest thing we've had though. Everything else needs explaining.",
      does: [
        { kind: "add", node: { id: "qt", kind: "quote", label: "Everything else needs explaining. That's the whole argument.", parent: "name", by: "Phạm Đức Toàn", at: "11:20" } },
        { kind: "focus", id: "qt" },
        { kind: "react", id: "qt", emoji: "👏" },
      ] },
    { gap: 2800, who: "Linh", say: "Park it? I don't think we settle naming today." },
    { gap: 2200, who: "Toàn", say: "Agreed, park it.",
      does: [
        { kind: "add", node: { id: "q1", kind: "question", label: "Does the name survive?", detail: "Parked — revisit after the visual direction is built out.", parent: "name", state: "open", tags: ["parked"] } },
        { kind: "collapse", id: "name", count: 2 },
        { kind: "focus", id: "q1" },
      ] },
  ],
};

export const DEMOS: DemoScript[] = [pilot, investor, workshop];
export const DEMO_BY_ID = new Map(DEMOS.map((d) => [d.id, d]));
