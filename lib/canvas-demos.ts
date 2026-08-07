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

import type { GNode, NodeFx, NodeState } from "@/lib/canvas-graph";

export type Action =
  | { kind: "add"; node: GNode }
  | { kind: "focus"; id: string }
  | { kind: "state"; id: string; state: NodeState }
  | { kind: "react"; id: string; emoji: string }
  | { kind: "collapse"; id: string; count: number }
  | { kind: "celebrate"; label: string; glyph?: "handshake" | "highfive" | "spark" }
  /** Play one of the semantic effects on an existing node. */
  | { kind: "fx"; id: string; fx: NodeFx }
  /** Absorb `from` into `into`: it flies across, fades, and the player deletes it. Used when two
   *  things said separately turn out to be the same thing — which is most of what a good meeting
   *  summary does. */
  | { kind: "merge"; from: string; into: string; label?: string; detail?: string }
  /** Draw a typed relationship between two existing nodes — the "they're arguing" case. */
  | { kind: "edge"; from: string; to: string; edge: "blocks" | "depends" | "answers" | "contradicts" }
  /** Re-word a node in place. People change their minds mid-sentence; the map has to follow. */
  | { kind: "amend"; id: string; label?: string; detail?: string };

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
// Written to behave like an actual meeting rather than a feature tour: people brainstorm three ideas
// at once, argue, wander off-topic, contradict each other, change their minds mid-sentence, and
// discover halfway through that two things they said separately were the same thing. Roughly a third
// of the lines produce NO canvas action at all — banter, hedging, thinking aloud — because a demo
// where every sentence spawns a node teaches the wrong thing about how this behaves.
const pilot: DemoScript = {
  id: "pilot",
  name: "Pilot scoping",
  blurb: "Customer call · brainstorm, argument, tangent, a merge",
  title: "QSortby · pilot scoping",
  subtitle: "with QDN Digital",
  seed: [T("root", "QSortby pilot")],
  steps: [
    { gap: 0, who: "Quang", say: "Before we start — did the staging box come back up? Linh was fighting it this morning." },
    { gap: 2200, who: "Linh", say: "Back up. It was a DNS thing, nothing to do with us." },
    { gap: 2000, who: "Toàn", say: "Good. So — the sort." },

    { gap: 2400, who: "Quang", say: "The thing that actually bothers us is the sort puts our worst-margin products on page one." },
    { gap: 2600, who: "Toàn", say: "Because it ranks on revenue. Margin never enters it.",
      does: [
        { kind: "add", node: T("scope", "Scope", "root") },
        { kind: "add", node: { id: "r1", kind: "requirement", label: "Rank on margin, not revenue", detail: "Revenue ranking buries the products that actually pay for the store.", parent: "scope", by: "Quang", tags: ["scope"] } },
        { kind: "focus", id: "r1" },
      ] },

    // brainstorm burst — three ideas in one breath
    { gap: 2600, who: "Linh", say: "We could also weight by stock cover. And seasonality. Maybe returns rate too, that kills margin quietly.",
      does: [
        { kind: "add", node: T("ideas", "Other signals", "scope") },
        { kind: "add", node: { id: "r2", kind: "requirement", label: "Weight by stock cover", detail: "Don't promote what we can't fulfil.", parent: "ideas", by: "Linh Trần", tags: ["idea"] } },
        { kind: "add", node: { id: "r3", kind: "requirement", label: "Factor in returns rate", detail: "A high-return product has negative real margin.", parent: "ideas", by: "Linh Trần", tags: ["idea"] } },
        { kind: "focus", id: "r2" },
      ] },
    { gap: 2600, who: "Quang", say: "That's three different products. Pick one." },
    { gap: 2200, who: "Toàn", say: "Agreed. Returns rate is a v2 thing.",
      does: [{ kind: "fx", id: "r3", fx: "shake" }] },

    // the argument
    { gap: 2600, who: "Quang", say: "Try it across all twelve stores. We need to know it generalises." },
    { gap: 2400, who: "Toàn", say: "I'd rather do one properly than twelve badly. Twelve gives us noise, not signal.",
      does: [
        { kind: "add", node: { id: "d1", kind: "decision", label: "One merchant, not the full catalogue", detail: "Narrowed from 12 so lift is provable inside the window.", parent: "scope", state: "proposed", tags: ["scope"], people: ["Phạm Đức Toàn"] } },
        { kind: "focus", id: "d1" },
        { kind: "edge", from: "r2", to: "d1", edge: "contradicts" },
      ] },
    { gap: 2800, who: "Quang", say: "One store doesn't prove anything to my board." },
    { gap: 2200, who: "Toàn", say: "Twelve half-configured stores won't either. One clean result is more persuasive than twelve muddy ones." },
    { gap: 2600, who: "Quang", say: "…Fine. One store. But weekly numbers, not a report at the end.",
      does: [
        { kind: "state", id: "d1", state: "agreed" },
        { kind: "react", id: "d1", emoji: "🤝" },
        { kind: "celebrate", label: "Scope agreed", glyph: "handshake" },
      ] },

    // tangent — Minami correctly keeps out of it
    { gap: 3000, who: "Linh", say: "Sorry, unrelated — are we still doing the team lunch Thursday?" },
    { gap: 1800, who: "Quang", say: "Friday now. Book it." },
    { gap: 1800, who: "Toàn", say: "Ha. Back to the sort." },

    { gap: 2400, who: "Quang", say: "Which store though? That's not obvious.",
      does: [
        { kind: "add", node: { id: "q1", kind: "question", label: "Which merchant goes first?", detail: "Needs clean margin data and enough weekly volume.", parent: "scope", state: "open", tags: ["blocker"] } },
        { kind: "focus", id: "q1" },
      ] },
    { gap: 2400, who: "Toàn", say: "Park it — two candidates by Friday.",
      does: [{ kind: "fx", id: "q1", fx: "jump" }] },

    { gap: 2600, who: "Quang", say: "The real constraint is our budget cycle closes in September.",
      does: [
        { kind: "add", node: T("time", "Timeline", "root") },
        { kind: "add", node: T("cons", "Constraints", "time") },
        { kind: "add", node: { id: "k1", kind: "risk", label: "Budget cycle closes in September", detail: "No provable lift by then and the pilot doesn't renew.", parent: "cons", state: "blocked", by: "Quang", tags: ["timing"] } },
        { kind: "focus", id: "k1" },
        { kind: "fx", id: "k1", fx: "shake" },
      ] },
    { gap: 2600, who: "Toàn", say: "Then six weeks, not three months.",
      does: [
        { kind: "add", node: T("agreed", "Agreed", "time") },
        { kind: "add", node: { id: "d2", kind: "decision", label: "6-week pilot, not 3 months", detail: "Lands before the September budget cycle closes.", parent: "agreed", state: "agreed", people: ["Quang", "Phạm Đức Toàn"] } },
        { kind: "focus", id: "d2" },
        { kind: "edge", from: "k1", to: "d2", edge: "blocks" },
        { kind: "react", id: "d2", emoji: "🔥" },
      ] },

    // changing his mind mid-sentence
    { gap: 2600, who: "Quang", say: "Actually make it five. I want a week of slack before the cycle closes.",
      does: [
        { kind: "amend", id: "d2", label: "5-week pilot, one week of slack", detail: "Shortened from six so there's a buffer before the September cycle." },
      ] },

    // the realisation — two things were the same thing
    { gap: 2800, who: "Quang", say: "Hang on. Margin ranking and the one-store pilot aren't two asks. They're the same thing.",
      does: [{ kind: "fx", id: "r1", fx: "glow" }] },
    { gap: 2400, who: "Toàn", say: "You're right — it's one decision.",
      does: [
        { kind: "merge", from: "r1", into: "d1",
          label: "Margin-sorted pilot on one merchant",
          detail: "Margin ranking and the single-store scope were the same decision all along." },
      ] },

    { gap: 2800, who: "Quang", say: "Send me the scope doc and I'll get it signed off.",
      does: [
        { kind: "add", node: T("commit", "Commitments", "time") },
        { kind: "add", node: { id: "a1", kind: "action", label: "Send pilot scope doc", detail: "Success metric, window, what we need from them.", parent: "commit", owner: "Phạm Đức Toàn", state: "proposed", progress: 0, tags: ["followup"] } },
        { kind: "focus", id: "a1" },
      ] },
    { gap: 2200, who: "Linh", say: "And I'll get the staging feed pointed at their catalogue.",
      does: [
        { kind: "add", node: { id: "a2", kind: "action", label: "Point staging at their catalogue", detail: "Needs a read-only API key from their side.", parent: "commit", owner: "Linh Trần", state: "proposed", progress: 0.1 } },
        { kind: "focus", id: "a2" },
      ] },
    { gap: 2200, who: "Quang", say: "Good. Same time next week." },
  ],
};

// ── 2 · Investor intro ──────────────────────────────────────────────────────────────────────────
const investor: DemoScript = {
  id: "investor",
  name: "Investor intro",
  blurb: "External · pushback, alignment moving in real time",
  title: "Ecom Intel · investor intro",
  subtitle: "Minami announced · recording",
  seed: [T("root", "Ecom Intel")],
  steps: [
    { gap: 0, who: "Sarah", say: "Walk me through what's actually working. Not the deck — what's working." },
    { gap: 2600, who: "Toàn", say: "Retention. Merchants who connect two sources stay at ninety-one percent after six months.",
      does: [
        { kind: "add", node: T("trac", "Traction", "root") },
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
        { kind: "add", node: T("raise", "The raise", "root") },
        { kind: "add", node: { id: "q1", kind: "question", label: "Is 18 months enough runway?", detail: "Sarah pushed back — wants 24 with the current burn.", parent: "raise", state: "open", tags: ["raise"] } },
        { kind: "focus", id: "q1" },
        { kind: "fx", id: "q1", fx: "shake" },
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
  seed: [T("root", "Brand direction")],
  steps: [
    { gap: 0, who: "Linh", say: "I pulled a few references. This first one is what I keep coming back to." },
    { gap: 2400, who: "Toàn", say: "The restraint is right. It doesn't look like a dashboard company.",
      does: [
        { kind: "add", node: T("look", "Look & feel", "root") },
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
        { kind: "add", node: T("name", "Naming", "root") },
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
        { kind: "fx", id: "q1", fx: "jump" },
      ] },
  ],
};

export const DEMOS: DemoScript[] = [pilot, investor, workshop];
export const DEMO_BY_ID = new Map(DEMOS.map((d) => [d.id, d]));
