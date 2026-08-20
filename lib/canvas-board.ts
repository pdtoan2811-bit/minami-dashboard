// THE BOARD — everything that turns a model's proposed actions into nodes and edges.
//
// Extracted from app/api/canvas/live/route.ts when a second producer appeared. There are now two
// completely different ways audio reaches this pipeline:
//
//   FILE   /api/canvas/live      an mp3 sliced on a clock, for the A/B harness
//   LIVE   /api/canvas/ingest    utterances pushed by a Recall bot, cut on a speaker's own pauses
//
// They share nothing upstream and must share EVERYTHING here. The rules below — quote grounding,
// label dedupe, fuzzy topic merge, merge-and-revise — are the difference between a board and a pile
// of cards, and every one of them was bought with a bug. Two copies would drift within a week, and
// the drift would show up as "the live board is worse than the test board" with no obvious cause.
//
// So: no I/O, no models, no SSE. Hand it actions, it maintains a graph.

import type { GNode, Graph, NodeKind, NodeState } from "@/lib/canvas-graph";
import type { RawAction } from "@/lib/canvas-llm";

export const CARD_KINDS = new Set<NodeKind>([
  "decision", "requirement", "question", "risk", "milestone", "action", "quote", "aside", "note",
]);
export const STATES = new Set<NodeState>(["proposed", "agreed", "done", "blocked", "open"]);

/** Is this quote grounded in what was actually said?
 *
 *  Word-overlap, not substring: ASR output and the model's paraphrase of it are never character-
 *  identical, so exact matching rejects everything. 65% of the meaningful words having been said is
 *  the line. The point is not tidiness — it makes fabricating a decision a VALIDATION FAILURE rather
 *  than a matter of the model behaving well. */
export function quoteIsGrounded(source: string, transcript: string[]): boolean {
  // ⚠️ UNICODE-AWARE, and it has to be. The original stripped everything outside [a-z0-9], which is
  // fine for English and DESTROYS Vietnamese: "để xây được màn hình" normalises to "x y c m n h nh",
  // because every diacritic-bearing character is deleted and the word shatters into single letters.
  // Grounding then compares fragments of fragments, so any paraphrase — which is what a judge always
  // produces — fails the overlap test and the card is silently dropped.
  //
  // That is a silent, total failure for a Vietnamese meeting: 200 OK, no errors, no cards, no reason
  // given. \p{L} keeps letters in every script; the `u` flag is what makes the class mean anything.
  const norm = (t: string) =>
    t.toLowerCase().normalize("NFC").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  const hayText = norm(transcript.join(" "));

  /** ⚠️ VERBATIM IS ALWAYS GROUNDED, and this case was being rejected.
   *
   *  A source that appears WORD FOR WORD in the transcript is the strongest possible evidence — there
   *  is nothing to verify. It was still run through the overlap heuristic below and could fail, which
   *  is how typed cards, voice-command captures and short spoken sentences were silently dropped:
   *  apply() returned null, no error, no log, the card simply never appeared. */
  const src = norm(source);
  if (src && hayText.includes(src)) return true;

  /** ⚠️ THE WORD FILTER WAS ENGLISH-CENTRIC AND IT BROKE VIETNAMESE.
   *
   *  `w.length > 2` discards two-letter words, which is harmless in English and severe in Vietnamese,
   *  where a large share of the vocabulary is 2-3 characters — là, có, để, nó, khi, một. A perfectly
   *  clear sentence like "chốt dùng qwen" left only three qualifying words, fell under the `< 4`
   *  floor, and could never be grounded no matter what was said.
   *
   *  Both thresholds are relaxed: keep anything of 2+ characters, and require 3 rather than 4. The
   *  floor still exists to stop a one-word fragment counting as evidence. */
  const words = norm(source).split(" ").filter((w) => w.length > 1);
  if (words.length < 3) return false;
  const hay = new Set(hayText.split(" "));
  const hits = words.filter((w) => hay.has(w)).length;
  return hits / words.length >= 0.65;
}

export type Board = ReturnType<typeof createBoard>;

export function createBoard() {
  /** ── THE BOARD'S OWN WORDS FOLLOW THE ROOM ──────────────────────────────────────────────────
   *
   *  The judge is told to write in the language being spoken, and it does. But the board itself
   *  shipped three ENGLISH words that no model ever chose: the root is "Meeting", the fallback
   *  cluster is "General", and the graph title is "Meeting". On a Vietnamese call those are the
   *  largest text on screen and the only English on it — anh saw exactly that, a board reading
   *  "Meeting … General" over cards that were entirely Vietnamese.
   *
   *  They are structural, so no prompt can fix them. They are set here instead, from the language
   *  actually detected in the transcript. */
  let lang: "vi" | "en" = "en";
  const WORDS = {
    en: { root: "Meeting", general: "General" },
    vi: { root: "Cuộc họp", general: "Chung" },
  };
  const nodes: GNode[] = [{ id: "root", kind: "topic", label: WORDS.en.root }];
  const edges: NonNullable<Graph["edges"]> = [];
  const topicByName = new Map<string, string>();
  const cardByLabel = new Map<string, string>();
  const seenLabels = new Set<string>();
  let seq = 0;

  const topicId = (name: string) => {
    const key = name.trim().toLowerCase().slice(0, 40);
    const hit = topicByName.get(key);
    if (hit) return hit;

    // Fuzzy merge before creating. Chunks are judged in parallel, so each starts with whatever topics
    // happened to exist and invents its own name for the same subject — one run produced "OpenAI
    // Lumen", "OpenAI Sore" and "OpenAI Models" as three clusters for one subject. Exact-name dedupe
    // cannot catch that. If a candidate shares most of its meaningful words with an existing topic,
    // it IS that topic.
    const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
    const mine = words(key);
    if (mine.size) {
      for (const [existing, id] of topicByName) {
        const theirs = words(existing);
        const shared = [...mine].filter((w) => theirs.has(w)).length;
        if (shared / Math.min(mine.size, theirs.size) >= 0.5) {
          topicByName.set(key, id);   // remember the alias so we only pay this once
          return id;
        }
      }
    }
    const id = `t${++seq}`;
    topicByName.set(key, id);
    nodes.push({ id, kind: "topic", label: name.trim().slice(0, 40), parent: "root" });
    return id;
  };

  /** Fold `target` into `into`: reattach every edge, drop the duplicate node. */
  const mergeCards = (targetLabel: string, intoLabel: string) => {
    const from = cardByLabel.get(targetLabel.trim().toLowerCase());
    const to = cardByLabel.get(intoLabel.trim().toLowerCase());
    if (!from || !to || from === to) return false;
    return mergeIds(from, to);
  };

  /** By-id merge, for callers that already hold the nodes — no label round trip. */
  const mergeNodes = (f: GNode, t: GNode) => mergeIds(f.id, t.id);

  const mergeIds = (from: string, to: string) => {
    if (from === to) return false;
    const i = nodes.findIndex((n) => n.id === from);
    if (i < 0) return false;
    // Carry the loser's detail over if the winner has none — merging shouldn't lose text.
    const winner = nodes.find((n) => n.id === to);
    if (winner && !winner.detail && nodes[i].detail) winner.detail = nodes[i].detail;
    // Keep the absorbed label. Two cards merging means the same point was made twice — worth seeing
    // on the board, not just in a log line nobody reads.
    if (winner) {
      winner.mergedFrom = [
        ...(winner.mergedFrom ?? []),
        nodes[i].label,
        ...(nodes[i].mergedFrom ?? []),
      ].slice(0, 4);
    }
    /** ⚠️ ADOPT THE ORPHANS BEFORE REMOVING THE PARENT.
     *
     *  Edges were already re-pointed here; PARENT LINKS were not. So merging a card that had children
     *  left them pointing at an id that no longer existed — and layout() drops every orphan after the
     *  first, silently. Measured live on 2026-08-18: 3 of 31 nodes had a dead parent, so three cards
     *  anh had said out loud existed in the graph, counted in "17 cards", were written to notes.md,
     *  and were invisible on the board.
     *
     *  Children move to the winner, which is the merge's own logic: the two cards were the same point,
     *  so anything hanging off the loser hangs off the winner. */
    /** ⚠️ RE-HOME THE WINNER FIRST, or it adopts itself and the whole branch disappears.
     *
     *  If the winner is a DESCENDANT of the loser — which is the shape the judge prompt actively
     *  encourages, since a nested detail card is often the clearer wording of its parent — then the
     *  blanket adoption below sets winner.parent = winner. That node is then unreachable from root,
     *  so layout never places it, and it is not an orphan either (its parent id resolves), so nothing
     *  warns. The surviving card and everything under it silently leave the board while still being
     *  counted, archived and written to notes.md. */
    const dyingParent = nodes[i].parent;
    // Captured before the splice: the loser's label must keep resolving, to the WINNER, so a later
    // judge action citing the absorbed wording still lands somewhere real.
    const dyingLabel = nodes[i].label.trim().toLowerCase();
    const isUnderLoser = (start?: string) => {
      let cur = start, hops = 0;
      while (cur && hops++ < 64) {
        if (cur === from) return true;
        cur = nodes.find((n) => n.id === cur)?.parent;
      }
      return false;
    };
    if (isUnderLoser(to)) {
      const w = nodes.find((n) => n.id === to);
      if (w) w.parent = dyingParent;
    }
    for (const n of nodes) if (n.parent === from && n.id !== to) n.parent = to;
    nodes.splice(i, 1);
    for (const e of edges) {
      if (e.from === from) e.from = to;
      if (e.to === from) e.to = to;
    }
    // Self-edges and duplicates can both appear as a result of the rewrite above.
    for (let j = edges.length - 1; j >= 0; j--) {
      const e = edges[j];
      if (e.from === e.to || edges.some((o, k) => k < j && o.from === e.from && o.to === e.to)) {
        edges.splice(j, 1);
      }
    }
    cardByLabel.set(dyingLabel, to);
    return true;
  };

  /** Rewrite an existing card in place. The id is kept deliberately: the canvas animates a card it
   *  already knows about, so a revision reads as the card CHANGING rather than one vanishing and a
   *  similar one appearing somewhere else. */
  /** `node` may be supplied directly. The by-id callers used to hand back a LABEL and let this
   *  re-resolve it through cardByLabel — an index keyed on a value that is neither unique nor stable.
   *  A topic and a card sharing a label meant the wrong node was edited or destroyed, and the caller
   *  was told it succeeded. Passing the node it already found removes the round trip entirely. */
  const reviseCard = (
    a: { target?: string; label?: string; detail?: string; state?: string; kind?: string },
    direct?: GNode,
  ) => {
    const id = direct ? direct.id : cardByLabel.get((a.target ?? "").trim().toLowerCase());
    const node = direct ?? (id ? nodes.find((n) => n.id === id) : undefined);
    if (!node) return false;
    if (a.label) {
      const next = a.label.slice(0, 90);
      // Refuse a relabel that would collide with a DIFFERENT live card. cardByLabel.set would
      // otherwise overwrite that card's entry, and from then on every revise/merge/`under` aimed at
      // it would silently land on this one instead — it becomes permanently uncorrectable.
      const clash = cardByLabel.get(next.trim().toLowerCase());
      if (clash && clash !== node.id && nodes.some((x) => x.id === clash)) return false;
      cardByLabel.delete(node.label.toLowerCase());
      seenLabels.delete(node.label.trim().toLowerCase());
      node.label = next;
      cardByLabel.set(next.toLowerCase(), node.id);
      seenLabels.add(next.trim().toLowerCase());
    }
    if (a.detail) node.detail = a.detail.slice(0, 160);
    if (STATES.has(a.state as NodeState)) node.state = a.state as NodeState;
    if (CARD_KINDS.has(a.kind as NodeKind)) node.kind = a.kind as NodeKind;
    return true;
  };

  return {
    nodes,
    edges,
    /** Topic labels created so far. Handed to the next judge call so parallel chunks converge on one
     *  name for a subject instead of each inventing their own. */
    /** Draw the warm-up cards. Ghosts under the seeded topic, so the shape of the call is visible
     *  before the first word — see GNode.placeholder for why they must stay distinguishable. */
    seedPlaceholders: (labels: string[], parent?: string) => {
      let n = 0;
      for (const raw of labels.slice(0, 5)) {
        const label = raw.trim().slice(0, 90);
        if (!label) continue;
        const id = `ph${++n}`;
        nodes.push({ id, kind: "note", label, parent: parent ?? "root", placeholder: true });
      }
      return n;
    },

    /** ⚠️ CALLED THE MOMENT ANYTHING REAL ARRIVES, and deliberately not keyed on which card.
     *
     *  A placeholder that outlives the first real utterance stops being a warm-up and becomes a lie
     *  on a screen anh is sharing. They go all at once, and they leave nothing behind: not in
     *  seenLabels, not in cardByLabel, or a later merge or rename could resolve onto a ghost. */
    clearPlaceholders: () => {
      const gone = nodes.filter((n) => n.placeholder);
      if (!gone.length) return 0;
      for (const g of gone) {
        const key = g.label.trim().toLowerCase();
        seenLabels.delete(key);
        if (cardByLabel.get(key) === g.id) cardByLabel.delete(key);
        const i = nodes.findIndex((n) => n.id === g.id);
        if (i >= 0) nodes.splice(i, 1);
      }
      // Anything that had been hung under a ghost goes back to the root rather than vanishing with it.
      for (const n of nodes) if (n.parent && !nodes.some((x) => x.id === n.parent)) n.parent = "root";
      return gone.length;
    },

    topicNames: () => nodes.filter((n) => n.kind === "topic" && n.id !== "root").map((n) => n.label),
    cards: () => nodes.filter((n) => n.kind !== "topic"),
    topicId,
    mergeCards,
    reviseCard,

    /** The tidy pass works in ids, not labels — it is reading the board it was handed, so there is
     *  no name to resolve and no chance of it inventing one. */
    mergeById: (fromId: string, intoId: string) => {
      const f = nodes.find((n) => n.id === fromId);
      const t = nodes.find((n) => n.id === intoId);
      if (!f || !t || f === t) return false;
      return mergeNodes(f, t);
    },
    /** Re-parent a card under another card — what turns a flat list into an actual mind map.
     *
     *  The tidy pass has always proposed these and the caller threw them away (`void nest`), so every
     *  board stayed exactly two levels deep however long the meeting ran: topic → card, forever. The
     *  model was doing the work and nobody applied it.
     *
     *  ⚠️ THE CYCLE GUARD IS NOT OPTIONAL. Re-parenting a card under its own descendant makes an
     *  orphaned ring: the nodes still exist, the layout walks parents forever, and the canvas hangs
     *  with no error. The prompt asks the model not to; that is a request, not a guarantee, so it is
     *  enforced here where it can actually be checked. */
    /** Told once, from the transcript — see WORDS. Renames the root in place so a board that started
     *  before the first word was heard does not keep an English title for the rest of the call. */
    setLanguage: (next: "vi" | "en") => {
      if (next === lang) return false;
      const root = nodes.find((n) => n.id === "root");
      if (root && root.label === WORDS[lang].root) root.label = WORDS[next].root;
      lang = next;
      return true;
    },

    nestById: (id: string, underId: string) => {
      if (id === underId) return false;
      /** ⚠️ DEPTH CAP. Nothing stopped the tidy pass deepening the tree: a 34-minute call reached
       *  SIX levels, which is both unreadable and the direct cause of the board being ~5760 units
       *  wide against a 1280px frame. A mind map earns its shape from breadth, not from a chain.
       *
       *  4 is topic → point → detail → sub-detail, which is as deep as anything said out loud has
       *  ever justified. Past that the model should be MERGING, not burrowing. */
      const depthOf = (nid: string) => {
        let d = 0, cur = nodes.find((n) => n.id === nid);
        const seen = new Set<string>();
        while (cur?.parent && !seen.has(cur.id)) { seen.add(cur.id); cur = nodes.find((n) => n.id === cur!.parent); d++; }
        return d;
      };
      if (depthOf(underId) + 1 > 4) return false;
      const node = nodes.find((n) => n.id === id);
      const target = nodes.find((n) => n.id === underId);
      if (!node || !target || node.kind === "topic") return false;
      // Walk up from the proposed parent: if we meet the node being moved, this would close a loop.
      let hop: GNode | undefined = target;
      const seen = new Set<string>();
      while (hop) {
        if (hop.id === id) return false;
        if (seen.has(hop.id)) return false;
        seen.add(hop.id);
        hop = hop.parent ? nodes.find((n) => n.id === hop!.parent) : undefined;
      }
      if (node.parent === underId) return false;
      node.parent = underId;
      return true;
    },

    /** Drop the most recently added card — what "Minami, bỏ cái vừa rồi" removes.
     *
     *  Newest by POSITION in `nodes`, because that is the order cards were pushed; the graph carries
     *  no timestamps. Topics are never removed: a topic usually has surviving children, and undoing a
     *  card should not orphan the rest of a branch. Edges touching the node go with it, or the board
     *  is left drawing a line to something that no longer exists. */
    removeLast: () => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].kind === "topic") continue;
        // Same adoption rule as mergeCards: children rise to their grandparent rather than dangle.
        const dying = nodes[i];
        for (const n of nodes) if (n.parent === dying.id) n.parent = dying.parent;
        const [gone] = nodes.splice(i, 1);
        /** ⚠️ THE INDEXES MUST DIE WITH THE NODE.
         *
         *  `seenLabels` and `cardByLabel` were never reconciled on removal, and both failures are the
         *  first thing a user hits after clicking undo:
         *
         *    seenLabels   still holds the label, so apply() refuses to create that card again — the
         *                 speaker repeats the point they just watched vanish and it never comes back,
         *                 for the rest of the meeting, silently.
         *    cardByLabel  still maps the label to a dead id, so the next card that hangs `under` it
         *                 gets a parent that no longer exists and lands as an orphan on the root. */
        seenLabels.delete(gone.label.trim().toLowerCase());
        if (cardByLabel.get(gone.label.trim().toLowerCase()) === gone.id) {
          cardByLabel.delete(gone.label.trim().toLowerCase());
        }
        for (let j = edges.length - 1; j >= 0; j--) {
          if (edges[j].from === gone.id || edges[j].to === gone.id) edges.splice(j, 1);
        }
        return gone;
      }
      return null;
    },

    /** Put a removed card back, with its original id and parent.
     *
     *  Redo is not "add a similar card" — it must restore THE card, or the undo/redo pair silently
     *  rewrites history: a new id breaks every edge that pointed at it and the parent link is lost,
     *  so a redone card lands under the wrong branch. Re-inserting the original node keeps the board
     *  identical to before the undo, which is the only thing that makes undo safe to use. */
    restore: (node: GNode) => {
      if (nodes.some((n) => n.id === node.id)) return false;
      // Undo and redo are not necessarily adjacent: a merge, a typed card or a tidy pass can land
      // between them and take the parent with it. Re-home to the nearest surviving ancestor rather
      // than restoring a card that points at nothing and gets swept onto the root.
      let up: string | undefined = node.parent;
      const seen = new Set<string>();
      while (up && !seen.has(up) && !nodes.some((n) => n.id === up)) {
        seen.add(up);
        up = undefined;
      }
      node.parent = up ?? "root";
      nodes.push(node);
      seenLabels.add(node.label.trim().toLowerCase());
      if (node.kind !== "topic") cardByLabel.set(node.label.trim().toLowerCase(), node.id);
      return true;
    },

    /** Attach a reaction to an existing card, which is what makes a cut scene fire for it.
     *
     *  Separate from reviseById because a reaction is not a revision: it changes nothing about what
     *  the card SAYS, and passing it through the revise path would drag the label-collision and
     *  dedup rules over a field none of them are about. */
    react: (id: string, emoji: string) => {
      const node = nodes.find((n) => n.id === id);
      if (!node) return false;
      node.reactions = [{ emoji, count: 1 }];
      return true;
    },

    reviseById: (r: { id: string; label?: string; detail?: string }) => {
      const node = nodes.find((n) => n.id === r.id);
      if (!node) return false;
      return reviseCard({ label: r.label, detail: r.detail }, node);
    },

    /** One proposed action → a card, or nothing. Returns the node so a caller can animate it.
     *
     *  `lines` is the transcript this action is allowed to cite. Everything the model claims must be
     *  traceable to it, which is why grounding happens HERE rather than being trusted upstream. */
    apply(a: RawAction, lines: string[]): GNode | null {
      // Board edits are not new cards and must not be counted or grounded as if they were: there is
      // no source quote for "these two were the same thing".
      if (a.op === "merge") { mergeCards(a.target ?? "", a.into ?? ""); return null; }
      if (a.op === "revise") { reviseCard(a); return null; }
      if (!a.label) return null;
      const kind = (CARD_KINDS.has(a.kind as NodeKind) ? a.kind : "note") as NodeKind;
      if (!quoteIsGrounded(a.source ?? "", lines)) return null;

      // The same sentence can legitimately be judged twice — the file path overlaps chunks by 6s, and
      // the live path can hand the same words to two speakers' streams. Dedupe on the label rather
      // than trusting the model not to repeat itself.
      const key = a.label.trim().toLowerCase();
      if (seenLabels.has(key)) return null;
      seenLabels.add(key);

      // `under` names a card; `topic` names a cluster. A card wins when it resolves, because the
      // model only reaches for it when the new point genuinely hangs off a specific earlier one — and
      // an unresolvable name falls back to the topic rather than being guessed at.
      const underId = a.under ? cardByLabel.get(a.under.trim().toLowerCase()) : undefined;
      const node: GNode = {
        id: `c${++seq}`,
        kind,
        parent: underId ?? topicId(a.topic || WORDS[lang].general),
        label: a.label.slice(0, 90),
        detail: a.detail?.slice(0, 160),
        state: STATES.has(a.state as NodeState) ? (a.state as NodeState) : undefined,
      };
      // A REACTION IS A MOMENT, and it has to be attached the instant the card is created.
      //
      // The full-screen cut scene fires off node.reactions, and nothing in the live path ever wrote
      // to it — reactions came only from the once-per-run relate pass, which the meeting never
      // reaches. So the most distinctive thing this product does had never once fired in a real
      // meeting, and no amount of agreeing out loud could have triggered it.
      if (a.emoji) node.reactions = [{ emoji: a.emoji, count: 1 }];

      nodes.push(node);
      cardByLabel.set(node.label.toLowerCase(), node.id);

      // Relationship, if it names a card we actually have. Resolved by label because the model never
      // sees ids; unresolvable ones are dropped rather than guessed — the same rule that stops it
      // referencing nodes that don't exist.
      if (a.relatesTo && a.relation) {
        const target = cardByLabel.get(a.relatesTo.trim().toLowerCase());
        if (target && target !== node.id) {
          edges.push({ from: node.id, to: target, kind: a.relation as never });
        }
      }
      return node;
    },

    /** A snapshot safe to POST or send down an SSE stream. */
    graph(meta: Partial<Graph> = {}): Graph {
      return {
        rev: Date.now(),
        title: WORDS[lang].root,
        status: "live",
        ...meta,
        nodes: nodes.map((n) => ({ ...n })),
        edges: edges.map((e) => ({ ...e })),
      };
    },
  };
}
