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
import {
  KIND_SIZE, branchColor, layout, nodeHeight, widthOf, type Graph, type Placed,
} from "@/lib/canvas-graph";
import { EDGE_LABEL, planEdges } from "@/lib/edge-routing";
import { GraphNode } from "@/components/canvas/GraphNode";

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
  // Badges are simply the relationships routing could NOT draw legibly — derived from the same plan
  // that draws the lines, so the two can never disagree. Previously each side had its own distance
  // rule and a relationship could fall in the gap between them and vanish entirely.
  return planEdges(placed, graph.edges ?? []).badges;
}

export function GraphCanvas({ graph, thinking, fit }: {
  graph: Graph;
  thinking?: "listening" | "thinking" | "idle";
  /** Shrink to fit the WHOLE board, the way present mode does.
   *
   *  Zoom-to-fit was scoped to present mode because that is a live 1080p share where a board is
   *  still growing. Review is the other case that needs it and for a stronger reason: the meeting is
   *  over, the board is final, and the only useful first view is all of it. Without this the review
   *  canvas inherited the live camera and parked on one branch of a 57-card map. */
  fit?: boolean;
}) {
  // Read from the DOM rather than threaded through props: the flag is set on <html> by the page from
  // ?broadcast=1, and every consumer of it is a rendering decision rather than data. In an effect so
  // the server and the first client render agree — reading it during render is a hydration mismatch.
  const [broadcast, setBroadcast] = useState(false);
  useEffect(() => setBroadcast(document.documentElement.classList.contains("broadcast")), []);

  /** PRESENT MODE — `/canvas?present=1`, shown from THIS machine and shared as a Chrome tab.
   *
   *  It sets the `broadcast` class too, so it inherits every legibility decision made for the stream
   *  (animations off, heavier borders, larger type). What it does NOT inherit is the geometry, because
   *  every one of those numbers encodes a constraint that only exists when Recall renders the page:
   *  1280x720, 15fps, and a frame Meet may crop. Sharing a tab is letterboxed, not cropped, and runs
   *  at the tab's real resolution — so the 500x600 safe box would throw away most of a 1080p frame. */
  const [present, setPresent] = useState(false);
  useEffect(() => setPresent(document.documentElement.classList.contains("present")), []);

  // Nodes measure themselves after paint and fire this; a re-layout then places them using real
  // heights instead of the wrap-guessing estimate. One extra pass, and it is what lets card text be
  // untruncated without cards spilling out of their cluster.
  const [measureTick, bumpMeasure] = useState(0);
  useEffect(() => {
    let queued = false;
    const onRemeasure = () => {
      if (queued) return;
      queued = true;
      // Coalesce: a burst of cards mounting fires this once per node, and re-laying out per node
      // would thrash. One pass on the next frame covers the whole burst.
      requestAnimationFrame(() => { queued = false; bumpMeasure((n) => n + 1); });
    };
    window.addEventListener("canvas:remeasure", onRemeasure);
    return () => window.removeEventListener("canvas:remeasure", onRemeasure);
  }, []);

  // Two passes: lay out once to learn which relationships are too far to draw, annotate the nodes
  // with how many badges they'll wear, then lay out again so their heights include those badges.
  // One pass would size every card as if it had none, and they'd collide exactly as before.
  const targets = useMemo(() => {
    const first = layout(graph.nodes);
    const rels = farRelations(graph, first);
    if (!rels.size) return first;
    return layout(graph.nodes.map((n) => (rels.has(n.id) ? { ...n, rels: Math.min(2, rels.get(n.id)!.length) } : n)));
    // measureTick is the whole point of the remeasure listener above: `measured` is a module-level
    // Map, so mutating it changes nothing React can see. Without it in the deps this memo only ever
    // ran on a new graph, the layout kept using the wrap-guessing ESTIMATE for every card, and cards
    // whose real content ran taller than the guess overlapped the card below. The listener has been
    // firing correctly the whole time; nothing was listening to the listener.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, measureTick]);
  // ── the release queue ─────────────────────────────────────────────────────────────────────────
  // A chunk hands over three cards in ONE state update, so all three mounted on the same frame and
  // the only thing separating them was a CSS animation-delay — which staggers the fade but not the
  // arrival, and caps out at 420ms anyway. Three cards popping together is not a board being built,
  // it's a board being pasted.
  //
  // So arrival is now a queue: ids are revealed one every RELEASE_MS. Layout still runs over ALL
  // nodes, including unrevealed ones, so their slots are already reserved and nothing reflows as
  // each one lands — the card appears into a space that was always going to be its own.
  const { revealed, hydrated } = useRevealQueue(targets);
  // MEMOISED, and it matters far more than it looks. `useEased` keys its animation off the identity
  // of this array; building a fresh one on every render restarted a 900ms ease on every render, and
  // since easing sets state, that render caused the next one. The board never settled — every node
  // held a new sub-pixel position on every frame forever, the camera dutifully tracked a board that
  // never stopped moving, and the whole surface paid for a full re-layout at 60fps while idle.
  const visible = useMemo(() => targets.filter((t) => revealed.has(t.id)), [targets, revealed]);
  const placed = useEased(visible);
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

  // The newest card on the board, in creation order. `placed` is ordered by cluster, so the last
  // element of it is the bottom of some column, not the latest thing said — the graph's own node
  // order is the only record of what arrived when.
  const newest = useMemo(() => {
    for (let i = graph.nodes.length - 1; i >= 0; i--) {
      const p = byId.get(graph.nodes[i].id);
      if (p && p.kind !== "topic") return p;
    }
    return undefined;
  }, [graph.nodes, byId]);

  const rels = useMemo(() => farRelations(graph, placed), [graph, placed]);
  const branchIds2 = useMemo(() => placed.filter((p) => p.depth === 1).map((p) => p.id), [placed]);

  // ── Topic announcements ───────────────────────────────────────────────────────────────────────
  // A new topic is the one board event worth signalling: a new card is a detail inside a subject you
  // are already watching, a new topic means the conversation went somewhere else. It is announced by
  // a colour flare on the heading — and by the camera arriving there shortly after, which happens on
  // its own because that topic's first card is the newest card.
  const [announce, setAnnounce] = useState<string | null>(null);
  // Seeded AT MOUNT, not on the first effect run. Seeding on first run meant that by the time data
  // had arrived the board already held most of its topics, and all of them were adopted silently —
  // two flares fired across ten topics. At mount the live board holds only its root, so everything
  // raised during the meeting is genuinely new, while a page opened onto a finished board still
  // adopts what is already there instead of replaying its construction.
  const knownTopics = useRef<Set<string>>(
    new Set(targets.filter((t) => t.kind === "topic").map((t) => t.id)),
  );
  // Held in refs, NOT cancelled by the effect's cleanup. The effect re-runs whenever a card is
  // revealed — every 320ms for a whole meeting — and a cleanup that cancels these meant the 6.5s
  // return-to-wide timer was killed within a third of a second, every time. The camera parked on the
  // first topic it saw and stayed there for the rest of the run. Only a NEW announcement should
  // supersede a pending one.
  const holdTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Keyed on the TOPIC LIST, not on `placed`. `placed` changes on every easing frame, so an effect
  // depending on it re-ran ~60 times a second and its cleanup cancelled the hold timers before they
  // could fire — the camera never came back to wide and only the first topic ever flared. The set of
  // topics changes a handful of times a meeting, which is the actual cadence of this event.
  const topicKey = useMemo(
    () => targets.filter((p) => p.kind === "topic").map((t) => t.id).join(","),
    [targets],
  );

  useEffect(() => {
    const topics = targets.filter((p) => p.kind === "topic" && revealed.has(p.id));
    const ids = new Set(topics.map((t) => t.id));

    const fresh = topics.filter((t) => !knownTopics.current.has(t.id));
    knownTopics.current = ids;
    if (!fresh.length) return;

    // If two topics open at once, frame the later one — it is the one the conversation is on.
    const subject = fresh[fresh.length - 1];
    for (const t of holdTimers.current) clearTimeout(t);
    holdTimers.current = [setTimeout(() => setAnnounce(null), 2600)];
    setAnnounce(subject.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicKey, revealed]);

  useEffect(() => () => { for (const t of holdTimers.current) clearTimeout(t); }, []);

  // ── THE CAMERA ────────────────────────────────────────────────────────────────────────────────
  // One scale, one target, one rule. What was here before had TWO movers — a fixed-zoom follow and a
  // fit-to-cluster establishing shot — running at the same time and disagreeing:
  //
  //   · the establishing shot fitted a cluster that was still filling up, so it spent its whole
  //     duration zooming out from the 0.80 clamp as cards arrived
  //   · every topic therefore established at a different, meaningless scale (measured: six distinct
  //     zooms in two minutes)
  //   · its two timers disagreed about when it ended; the 2.6s one silently won and the 6.5s "long
  //     hold" never existed
  //   · the follow point kept updating underneath it, so the handover cut to somewhere new
  //   · 3-4.2s glides against topics arriving every few seconds meant each move was interrupted by
  //     the next — the camera never arrived anywhere
  //
  // None of that is fixable by tuning, because the second mover is what creates it. It is gone.
  //
  // ZOOM IS CONSTANT. Every card is the same size, so there is no detail to zoom into: a scale
  // change buys nothing here and costs the most disorienting operation a camera has. The topic
  // announcement is carried by the colour flare and by the pan that follows naturally — the first
  // card of a new topic lands in that column, so the camera goes there of its own accord.
  // Sized for a SHARED SCREEN, not for a desk. The canvas is streamed as video and re-encoded, so
  // fine detail is destroyed before anyone sees it — 11px body text at 0.66 lands as about 7px of
  // smeared grey on the far end. Near 1:1 the type is rendered at the size it was designed for and
  // survives the round trip. The cost is seeing roughly one column at a time, which is the right
  // trade for a live call: what matters is the subject being discussed now, not the archive.
  // BROADCAST scales the CAMERA, not the page.
  //
  // The bot renders at a fixed 1280x720 and no platform will give us more, so the only way to make
  // the board legible on the far end is to put fewer, larger cards in those pixels. Doing it here
  // rather than with a CSS `zoom` on the root is not a preference: zoom made the h-dvh/w-dvw children
  // overflow the viewport, clipping the header off the top of the frame and cutting the presence pill
  // in half at the bottom-left corner. Caught in a real meeting, not in review. The graph transform
  // has no such side effect, because scaling is what it already exists to do.
  // 1.25 was too big for a 500px-wide safe box. The layout is a MINDMAP — a topic pill on the left
  // with its cards to the right — so the unit that has to fit horizontally is pill + gap + card,
  // about 500px at 1:1. At 1.25 that becomes ~625px and the topic pill is pushed off the left edge of
  // the frame entirely, which is exactly what "eeting bot" in anh's frame was.
  //
  // 1.05 keeps type meaningfully larger than the desktop default while letting a whole branch fit.
  /** Apparent text size must not depend on the window. 15px type in a 1280-wide frame is 1.17% of
   *  the frame; the same 15px at 1920 is 0.78% — so rendering wider WITHOUT scaling makes the board
   *  physically smaller for the viewer, which is the opposite of the point. Scaling against the 1280
   *  baseline spends the extra pixels on SHARPNESS at a constant apparent size, and keeps the layout
   *  identical whatever size the shared window happens to be. */
  //
  // CAPPED AT 1.2, and the cap is the whole decision. Scaling the full 1.5x to 1920 keeps apparent
  // text size identical to the 720p stream — but it also keeps CAPACITY identical, and a 1920x1080
  // render then showed exactly ONE card floating in the middle of the frame while two others sat
  // off-screen. All the extra pixels had gone into type nobody asked to be bigger.
  //
  // 1.2 splits it honestly: type still reads larger than the old stream, three cards fit in a column
  // instead of two, and the real capacity win comes from the safe box being 86% of the frame here
  // versus 39% in broadcast — room the board can branch sideways into.
  const PRESENT_SCALE = Math.min(1.2, Math.max(1, vp.w / 1280));
  const FOLLOW_ZOOM = present ? 1.05 * PRESENT_SCALE : broadcast ? 1.05 : 0.95;
  const HEADER = 104;
  const MARGIN = 56;

  // ── THE SAFE BOX ──────────────────────────────────────────────────────────────────────────────
  // In broadcast, the frame the bot sends is 1280x720 but the region we may actually TRUST is only
  // the 500x600 rectangle in the middle of it — 390px in from each side, 60px from top and bottom.
  //
  // The frame is not the safe area, and the difference is where content goes to die. A shared screen
  // is re-laid-out by every client that receives it: Meet crops and letterboxes it into whatever tile
  // the viewer's layout gives it, participant thumbnails and the call controls sit ON TOP of the
  // edges, and a phone rotates the whole thing into portrait. Anything outside the middle is
  // conditionally visible — which is worse than invisible, because it looks fine on the machine that
  // produced it.
  //
  // So the camera targets the SAFE BOX, not the viewport. Every fit, every dead zone and the centre
  // itself are computed from these numbers. Note the shape: 500 wide by 600 tall is PORTRAIT inside a
  // landscape frame, so exactly one column of cards fits and the board grows downward. That is a
  // consequence of the rule, not a bug in it.
  // ⚠️ THE HEADER LIVES INSIDE THE SAFE BOX, so the camera must not.
  //
  // Centring on the raw safe box put the title straight on top of the first card — "Easy Vision AI"
  // rendered over an ACTION card in a real frame, both unreadable. That was a regression from
  // switching autoTy from `HEADER + …` to the safe-box centre: it moved content up by ~52px and
  // straight under the chrome.
  //
  // The camera therefore targets the safe box MINUS the header's own band. HEADER_BAND is the title
  // plus subtitle plus their breathing room at broadcast type sizes.
  const HEADER_BAND = broadcast ? 96 : 0;
  // Present margins are PROPORTIONAL, not the fixed 390px. A shared tab is fit into the viewer's
  // tile rather than cropped, so the only real risk is call controls and thumbnails sitting over the
  // edges — 7% covers that. The result is landscape rather than the 500x600 portrait slot, so the
  // board can finally grow sideways into branches instead of one column downward.
  const PM = Math.round(vp.w * 0.07);
  const SAFE = present
    ? { left: PM, right: PM, top: Math.round(vp.h * 0.05) + HEADER_BAND, bottom: Math.round(vp.h * 0.06) }
    : broadcast
    ? { left: 390, right: 390, top: 60 + HEADER_BAND, bottom: 60 }
    : { left: MARGIN, right: MARGIN, top: HEADER, bottom: MARGIN };

  /** The safe box in viewport coordinates. Derived from the live viewport rather than hardcoded to
   *  1280x720, so a browser at any size still produces a proportionally correct preview of what the
   *  meeting will actually show. */
  const safe = {
    w: Math.max(120, vp.w - SAFE.left - SAFE.right),
    h: Math.max(120, vp.h - SAFE.top - SAFE.bottom),
    cx: SAFE.left + (vp.w - SAFE.left - SAFE.right) / 2,
    cy: SAFE.top + (vp.h - SAFE.top - SAFE.bottom) / 2,
  };

  /** FIT THE WHOLE BOARD WHEN THE WHOLE BOARD FITS — present mode only.
   *
   *  Following the newest card is right when the frame is small: at 1280x720 inside a 500px safe box
   *  almost nothing fits, so the camera has to choose what to show. At 1080p the safe box is ~1760x880
   *  and most boards fit entirely — and following the newest card there left a THIRD of the frame
   *  empty while the board sat off to one side, which is the opposite of what the extra pixels were
   *  for. Verified in a 1920x1080 render before this existed.
   *
   *  So: if everything fits, centre on the content and stop moving. The camera only starts following
   *  again once the board genuinely outgrows the frame, which is also when movement starts carrying
   *  information instead of just being motion.
   *
   *  Conservative on purpose — `w` is exact, height uses a generous per-card allowance, so it errs
   *  toward "does not fit" and falls back to the follow behaviour rather than clipping a card. */
  /** ── SELECTION: WHAT DOES THIS CARD CONNECT TO? ──────────────────────────────────────────────
   *
   *  A finished board is a wall of cards with no way to ask a question of it. Anh asked to "click on
   *  nodes or edges… showing which edges and nodes belong/relate to them" — which is really the
   *  review problem: during the call the newest card is obviously the subject, but afterwards nothing
   *  tells you what hangs off what.
   *
   *  Related means three different things and all three matter:
   *    ANCESTORS   the path back to the root — the context this card sits inside
   *    DESCENDANTS everything nested under it — what it turned into
   *    PARTNERS    the other end of any relation edge — what it was compared or linked to
   *
   *  Everything else dims rather than disappears, so the shape of the whole board is still readable
   *  around the answer. Dimming beats hiding: hiding re-lays-out the map and you lose your place. */
  const [selected, setSelected] = useState<string | null>(null);
  /** `placed` is re-created on EVERY animation frame by useEased. Anything that reads it from inside a
   *  state-writing effect must do so through a ref, or the effect's dependency list churns at 60fps.
   *  See the note on the camera effect below. */
  const placedRef = useRef<Placed[]>(placed);
  placedRef.current = placed;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // A card that vanishes mid-meeting (merged away by tidy) must not leave the board dimmed forever
  // around a selection that no longer exists.
  useEffect(() => { if (selected && !byId.has(selected)) setSelected(null); }, [selected, byId]);

  const related = useMemo(() => {
    if (!selected) return null;
    const keep = new Set<string>([selected]);
    const byIdAll = new Map(placed.map((p) => [p.id, p]));
    for (let hop = byIdAll.get(selected)?.parent; hop; hop = byIdAll.get(hop)?.parent) keep.add(hop);
    const kids = (id: string) => placed.filter((p) => p.parent === id);
    const queue = [selected];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const k of kids(cur)) if (!keep.has(k.id)) { keep.add(k.id); queue.push(k.id); }
    }
    for (const e of graph.edges ?? []) {
      if (e.from === selected) keep.add(e.to);
      if (e.to === selected) keep.add(e.from);
    }
    return keep;
  }, [selected, placed, graph.edges]);

  /** The handover point between FRAMING THE BOARD and FOLLOWING THE NEWEST CARD.
   *
   *  ⚠️ THIS NUMBER DECIDES WHETHER THE CAMERA MOVES AT ALL. While the whole board fits at this zoom
   *  or better, the camera frames it and holds still; below it, framing is abandoned and the camera
   *  pans to whatever was just said.
   *
   *  It was 0.45 — 47% of desktop follow zoom — so essentially every real board "fit", the camera
   *  never moved, and cards shrank toward illegibility as the meeting went on. Framing something
   *  nobody can read is not framing it.
   *
   *  0.88 is deliberately close to follow zoom: the board is only framed when doing so costs almost
   *  no legibility, and the moment it would cost more than about a tenth the camera stops trying to
   *  show everything and goes to read what was just said. Reading the newest card is the job; seeing
   *  the whole shape is a bonus that is only worth taking while it is nearly free. */
  const FIT_FLOOR = 0.88;

  /** Where the camera points: the whole board's centre, or null to fall back to following the newest
   *  card.
   *
   *  ⚠️ THE GIVE-UP TEST MUST USE THE ZOOM WE ACTUALLY APPLY. It measured the board against
   *  FOLLOW_ZOOM — the UNSHRUNK zoom — so the moment a board grew past one frame at 1.0 the camera
   *  abandoned centring and went back to chasing the newest card, even though the zoom beside it had
   *  already shrunk to make the whole thing fit. Zoom said "show everything" and the centre said
   *  "follow the last card": the board was framed to fit and then pointed somewhere else, which is
   *  precisely the cropped, drifting view anh saw. Both halves now agree on one number. */
  const fitCentre = useMemo(() => {
    if ((broadcast && !present) || !placed.length) return null;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of placed) {
      x0 = Math.min(x0, q.x - q.w / 2); x1 = Math.max(x1, q.x + q.w / 2);
      y0 = Math.min(y0, q.y - 110); y1 = Math.max(y1, q.y + 110);
    }
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const z = Math.max(FIT_FLOOR, Math.min(FOLLOW_ZOOM, Math.min(safe.w / w, safe.h / h)));
    // Only give up once even the floor cannot show it all.
    if (w * z > safe.w || h * z > safe.h) return null;
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }, [broadcast, present, placed, FOLLOW_ZOOM, safe.w, safe.h]);

  /** ── WHY THESE ARE ROUNDED PRIMITIVES AND NOT THE OBJECTS THEMSELVES ─────────────────────────
   *
   *  The camera effect writes state. It therefore must not depend on anything whose IDENTITY changes
   *  per render, or it re-fires forever: render → effect → setState → render. That is exactly what
   *  happened — `byId` (a useMemo over the easing `placed`) and `fitCentre` (a fresh {cx,cy} literal)
   *  were both in the dependency list, and React aborted with "Maximum update depth exceeded".
   *
   *  Two rules, applied here and worth applying to any effect that sets state:
   *    1. depend on PRIMITIVES, never on objects or arrays built during render;
   *    2. ROUND them, so sub-pixel drift from the animation loop cannot re-trigger the effect on a
   *       change too small to see. Whole pixels are the resolution the camera actually has. */
  const newestId = newest?.id ?? null;
  const newestX = newest ? Math.round(newest.x) : null;
  const newestY = newest ? Math.round(newest.y) : null;
  const fitX = fitCentre ? Math.round(fitCentre.cx) : null;
  const fitY = fitCentre ? Math.round(fitCentre.cy) : null;

  const [followAt, setFollowAt] = useState<{ cx: number; cy: number }>(() => ({
    cx: bounds.cx, cy: bounds.cy,
  }));

  // THE ONE RULE: keep the newest card inside a dead zone. Per-AXIS, so a column growing downward
  // nudges the camera down without also dragging it sideways — recentring both axes when only one
  // has drifted is what made small corrections read as the whole board sliding.
  //
  // The zones are deliberately asymmetric. Horizontal drift only happens when the conversation
  // changes topic, which is rare and worth a real move, so that zone is generous. Vertical drift is
  // continuous as a column fills, so that zone is tighter — it should track, not lurch.
  useEffect(() => {
    /** A CLICK IS A NAVIGATION REQUEST. Selecting a card that is off-frame dimmed the whole board
     *  around something anh could not see — the feature answered the question and hid the answer.
     *  Selection therefore outranks both the fit and the follow: you clicked it, so it is what the
     *  camera is for until you clear it. */
    if (selected) {
      const p = placedRef.current.find((q) => q.id === selected);
      if (p) {
        const cx = Math.round(p.x), cy = Math.round(p.y);
        // Returning `prev` unchanged is what makes this a FIXED POINT: a second run with the same
        // inputs writes nothing, so the render loop terminates instead of chasing itself.
        setFollowAt((prev) => (Math.abs(prev.cx - cx) < 1 && Math.abs(prev.cy - cy) < 1 ? prev : { cx, cy }));
        return;
      }
    }

    // Whole board visible → centre it and hold. Checked BEFORE `newest`, so a board that is still
    // only topics is centred too rather than left wherever the camera happened to be.
    if (fitX !== null && fitY !== null) {
      setFollowAt((prev) =>
        Math.abs(prev.cx - fitX) < 1 && Math.abs(prev.cy - fitY) < 1 ? prev : { cx: fitX, cy: fitY });
      return;
    }
    if (newestX === null || newestY === null) return;
    // Dead zone measured against the SAFE BOX. Using the full viewport here let the newest card sit
    // "comfortably on screen" while being under a participant thumbnail or off the edge of a cropped
    // tile for everyone except the machine rendering it.
    const hw = (safe.w / FOLLOW_ZOOM) / 2;
    const hh = (safe.h / FOLLOW_ZOOM) / 2;
    // WIDER DEAD ZONE ON THE STREAM. The cheapest way to stop a camera feeling jumpy is to move it
    // less often, not only to move it more slowly — every move it does not make is a move that cannot
    // judder. A card landing inside the frame needs no camera at all, and at broadcast zoom the frame
    // already holds a whole branch.
    /** ⚠️ THIS CODE ONLY RUNS WHEN FRAMING HAS ALREADY BEEN GIVEN UP ON.
     *
     *  The old 0.92/0.86 came from "fit first in present": most boards fit, so the honest default was
     *  a camera that never moved, and these numbers existed to keep it still. But the fit branch
     *  returns above — by the time execution reaches here the board does NOT fit, the camera IS
     *  panning, and holding still is the one thing it must not do. At 0.92 the newest card had to
     *  reach 92% of the way to the edge before the camera reacted, so a card would appear hard against
     *  the frame, or half outside it, and stay there.
     *
     *  Tightened so a new card lands comfortably inside the frame rather than at its edge. Broadcast
     *  keeps the generous zone: judder is worse on a 15fps re-encode than a card near an edge is. */
    const gx = broadcast && !present ? 0.88 : 0.62;
    const gy = broadcast && !present ? 0.7 : 0.45;
    setFollowAt((prev) => {
      const dx = Math.abs(newestX - prev.cx) > hw * gx;
      const dy = Math.abs(newestY - prev.cy) > hh * gy;
      if (!dx && !dy) return prev;
      return { cx: dx ? newestX : prev.cx, cy: dy ? newestY : prev.cy };
    });
    // PRIMITIVES ONLY — no `byId`, no `fitCentre`, no `newest`. Adding an object back here is what
    // broke it, and would break it again.
  }, [newestId, newestX, newestY, fitX, fitY, safe.w, safe.h, FOLLOW_ZOOM, broadcast, present, selected]);

  /** ── ZOOM SHRINKS TO FIT. This reverses "ZOOM IS CONSTANT", deliberately. ──────────────────
   *
   *  Constant zoom was right when a board was two levels and one column: every card the same size,
   *  camera pans, nothing to zoom into. Applying `nest` changed the premise. A 34-minute call reached
   *  depth 6 and ~5760 canvas units wide — 7257px against a 1280px frame, still overflowing even at
   *  0.6. No amount of panning shows a hierarchy that is five screens wide; anh saw one column of
   *  cards with lines arriving from off-screen and reasonably concluded nothing was branching.
   *
   *  So: keep the constant zoom while the board fits, and shrink only as far as needed once it does
   *  not. FLOORED at 0.45 because an unreadable board is not a better answer than a cropped one —
   *  past that it goes back to panning at the floor. */
  const fitZoom = useMemo(() => {
    if (!placed.length) return FOLLOW_ZOOM;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of placed) {
      x0 = Math.min(x0, q.x - q.w / 2); x1 = Math.max(x1, q.x + q.w / 2);
      y0 = Math.min(y0, q.y - 110); y1 = Math.max(y1, q.y + 110);
    }
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const need = Math.min(safe.w / w, safe.h / h);
    return Math.max(FIT_FLOOR, Math.min(FOLLOW_ZOOM, need));
  }, [placed, safe.w, safe.h, FOLLOW_ZOOM]);

  /** ⚠️ EVERYTHING SHRINKS TO FIT EXCEPT THE 720p BOT RE-ENCODE.
   *
   *  This used to be `present || fit`, on the reasoning that "the desktop view has scroll and pinch".
   *  That is true and it is not the point: the desktop view is what anh watches DURING a call, with
   *  his hands on the conversation rather than on a trackpad. Constant zoom plus a camera that follows
   *  the newest card meant a six-card board already ran off the right edge, with earlier cards simply
   *  gone — the same "nothing is branching" misread that made this shrink-to-fit exist for present
   *  mode, reproduced on the surface he actually looks at.
   *
   *  Broadcast stays fixed: that path is a 1280x720 re-encode where small text is already the enemy,
   *  and a viewer of a video stream cannot pinch. Manual scroll or pinch still hands control over
   *  immediately, so nothing is taken away — it just starts framed. */
  /** ⚠️ THE ZOOM AND THE DEAD ZONE MUST BE THE SAME NUMBER.
   *
   *  This rendered at `fitZoom` in every non-broadcast mode, while the follow effect above sized its
   *  dead zone with `safe.w / FOLLOW_ZOOM`. So while the camera was panning, it decided whether the
   *  newest card was near the edge using a zoom it was not applying — at the old 0.45 floor the dead
   *  zone was computed for a frame twice the size of the one on screen, which is why a new card could
   *  be visibly off the edge and the camera would judge it comfortably inside and refuse to move.
   *
   *  So there are exactly two states now, and each is internally consistent:
   *    fitCentre !== null  the whole board fits readably → frame it, hold still, shrink as needed
   *    fitCentre === null  it does not → FOLLOW_ZOOM, and pan to the newest card
   *
   *  `fitCentre` is the authority for which state we are in precisely because it already applies the
   *  floor, so the pan and the zoom can no longer disagree about whether the board fits. */
  const framing = fitCentre !== null;
  const autoZoom = broadcast && !present ? FOLLOW_ZOOM : framing ? fitZoom : FOLLOW_ZOOM;
  // Centre on the safe box, not on the frame. In broadcast the two differ vertically: the frame's
  // centre sits below the safe box's once the header is accounted for, and that offset is exactly
  // enough to push the newest card under the call controls.
  /** ⚠️ DO NOT CLAMP THE AIM POINT TO THE BOARD'S BOUNDING BOX. Tried, reverted, measured.
   *
   *  The idea was sound — centring on the newest card leaves empty grid below it, so clamp the camera
   *  to the board's bounds and reclaim that space. It fails because this board's bounds are SPARSE:
   *  the root and the older topics sit far off to one side with nothing in between, so the bbox is
   *  mostly empty and clamping to it dragged the camera off the newest card and into the gap. The
   *  frame got emptier, not fuller, and the card anh was waiting for ended up at the edge.
   *
   *  Empty canvas beneath the newest card is the honest picture of a board that ends there. */
  const autoTx = safe.cx - followAt.cx * autoZoom;
  const autoTy = safe.cy - followAt.cy * autoZoom;

  // ── MANUAL NAVIGATION ─────────────────────────────────────────────────────────────────────────
  // Two-finger scroll pans, pinch zooms, and the moment either happens the director LETS GO.
  //
  // Handing control back and forth is the whole design problem here. A camera that keeps following
  // while you are dragging fights you for the viewport and wins, because it re-targets every time a
  // card lands. So the first gesture takes control outright, and a pill appears saying so — control
  // that can be taken silently and never given back is worse than no control at all.
  //
  // It returns on its own after 15s of no gesture. Explicit-only would be safer for the person
  // driving and worse for everyone watching: this is a shared screen, and a board parked wherever
  // someone last looked, silently no longer following the conversation, is the failure that matters.
  const [manual, setManual] = useState<{ tx: number; ty: number; zoom: number } | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Live camera, readable from the wheel handler without making it a dependency. */
  const autoRef = useRef({ tx: 0, ty: 0, zoom: 1 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const release = () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setManual(null), 15000);
    };

    const onWheel = (e: WheelEvent) => {
      // Non-passive: without preventDefault the page itself scrolls behind the canvas.
      e.preventDefault();
      setManual((prev) => {
        const cur = prev ?? { tx: autoRef.current.tx, ty: autoRef.current.ty, zoom: autoRef.current.zoom };
        // macOS reports a trackpad PINCH as a wheel event with ctrlKey set. Nothing else does, which
        // makes this the one reliable way to tell "zoom" from "scroll" on a Mac.
        if (e.ctrlKey || e.metaKey) {
          const next = Math.max(0.12, Math.min(2.5, cur.zoom * Math.exp(-e.deltaY * 0.01)));
          // Zoom about the POINTER, not the viewport centre. Zooming about the centre means the
          // thing you are pointing at slides away as you close in on it, which is why that always
          // feels like fighting the interface.
          const r = el.getBoundingClientRect();
          const px = e.clientX - r.left;
          const py = e.clientY - r.top;
          const k = next / cur.zoom;
          return { zoom: next, tx: px - (px - cur.tx) * k, ty: py - (py - cur.ty) * k };
        }
        // Two-finger scroll. Shift+scroll gives horizontal on hardware that only reports deltaY.
        const dx = e.shiftKey && !e.deltaX ? -e.deltaY : -e.deltaX;
        return { ...cur, tx: cur.tx + dx, ty: cur.ty - e.deltaY };
      });
      release();
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    // ⚠️ REGISTERED ONCE. Deps used to be [autoTx, autoTy, autoZoom], which change on every new card
    // and ~60x/s while the camera eases — so the cleanup cleared the 15s release timer over and over
    // and NOTHING re-armed it. One nudge of the trackpad and the board stayed parked for the rest of
    // the meeting, silently no longer following the conversation: exactly the failure the comment
    // above says is the one that matters. It also thrashed a non-passive listener 60x/s.
    //
    // The live camera values are read through a ref inside the handler instead, so the listener never
    // needs replacing.
    return () => { el.removeEventListener("wheel", onWheel); };
  }, []);

  // Cleared only on unmount — never on a camera change. See above.
  useEffect(() => () => { if (idleTimer.current) clearTimeout(idleTimer.current); }, []);

  // Assigned during render, read inside the wheel handler. This is what lets that listener be
  // registered once instead of on every camera change.
  autoRef.current = { tx: autoTx, ty: autoTy, zoom: autoZoom };

  const zoom = manual ? manual.zoom : autoZoom;
  const tx = manual ? manual.tx : autoTx;
  const ty = manual ? manual.ty : autoTy;

  // Duration follows DISTANCE, and past a point the camera cuts instead of gliding.
  //
  // A single duration for every move is wrong at both ends: a 20px correction stretched over four
  // seconds reads as the board quietly drifting, and a 2800px sweep over the same four seconds is
  // simply unpleasant to watch. Short moves should finish before you notice them; long ones should
  // not be watched at all.
  //
  // The cut is film grammar: you PAN within a location and CUT between them. Past about a screen and
  // a half there is no continuity left to preserve — the start and end frames share nothing — so the
  // glide conveys nothing except motion sickness.
  const prevPos = useRef({ tx, ty });
  const travel = Math.hypot(tx - prevPos.current.tx, ty - prevPos.current.ty);
  useEffect(() => { prevPos.current = { tx, ty }; }, [tx, ty]);
  // A gesture must be 1:1 with the fingers. Easing a pan the user is performing turns a drag into a
  // rubber band and is the single fastest way to make a canvas feel broken.
  //
  // ⚠️ BROADCAST NEEDS ITS OWN NUMBERS, because the medium is different in two ways that both push the
  // same direction. The stream is 15fps, so a 900ms pan is THIRTEEN FRAMES — the eye reads that as a
  // jump with motion blur rather than as a move. And it is 1280x720 re-encoded, so there is no fine
  // detail to track the motion against, which removes the cue that tells you a pan is a pan.
  //
  // The cut also stops working here. Cutting past a screen and a half is right when the viewer can
  // see sharp frames on either side; on a compressed stream a cut is indistinguishable from the
  // picture glitching. So broadcast pans much further before it ever cuts, and takes far longer when
  // it does pan — ~2.4s is 36 frames at 15fps, which is enough to read as deliberate camera movement.
  const CUT_AT = present ? vp.w * 3 : broadcast ? vp.w * 4 : vp.w * 1.5;
  const dur = manual
    ? 0
    : travel > CUT_AT
      ? 0
      : broadcast
        ? Math.min(2400, 700 + travel * 0.9)
        : Math.min(900, 250 + travel * 0.5);

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden">
      <div
        className="absolute left-0 top-0 origin-top-left will-change-transform"
        style={{
          transform: `translate3d(${tx}px, ${ty}px, 0) scale(${zoom})`,
          // Long and eased: a camera that snaps is disorienting on a shared screen; a camera that
          // glides reads as intentional attention.
          // cubic-bezier(0.22, 1, 0.36, 1) is a hard ease-OUT: it covers most of the distance in
          // the first fifth of the duration and then crawls. On a 2.4s move that reads as a lurch
          // followed by nothing — "the camera pans too fast" even though the number says 2.4s. A
          // symmetric ease-in-out spends the time where the eye is actually tracking. At dur=0 this
          // becomes a cut, which is what long jumps get.
          transition: `transform ${dur}ms cubic-bezier(0.4, 0.03, 0.2, 1)`,
        }}
        onClick={() => setSelected(null)}
      >
        {/* Edges are filtered to revealed endpoints inside Edges: a line to a card that hasn't
            arrived yet would have to point at empty space. */}
        <Edges placed={placed} graph={graph} related={related} selected={selected} />
        {placed.map((n, i) => (
          <div
            key={n.id}
            onClick={(e) => { e.stopPropagation(); setSelected((cur) => (cur === n.id ? null : n.id)); }}
            className="cursor-pointer"
            style={{
              // Dim, never hide — see the note on selection. 0.22 is far enough to read as "not this"
              // while leaving the map's silhouette intact.
              opacity: related && !related.has(n.id) ? 0.22 : 1,
              transition: "opacity 260ms ease",
            }}
          >
            <GraphNode
              n={n} index={i} live={graph.focus === n.id} rel={rels.get(n.id)}
              branchHue={branchColor(branchIds2, n.branch)}
              skeleton={!hydrated.has(n.id)}
              announcing={announce === n.id}
              newest={newest?.id === n.id}
              selected={selected === n.id}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Bounding box of the whole map in canvas units, node boxes included. */
function bbox(placed: Placed[]) {
  if (!placed.length) return { w: 900, h: 600, cx: 0, cy: 0 };
  const l = Math.min(...placed.map((p) => p.x - widthOf(p) / 2));
  const r = Math.max(...placed.map((p) => p.x + widthOf(p) / 2));
  const t = Math.min(...placed.map((p) => p.y - nodeHeight(p) / 2));
  const b = Math.max(...placed.map((p) => p.y + nodeHeight(p) / 2));
  return { w: r - l, h: b - t, cx: (l + r) / 2, cy: (t + b) / 2 };
}

/** Edges live in one SVG beneath the nodes. Branch edges are the tree; typed edges are the extra
 *  relationships and are dashed + labelled, so a claim like "blocks" is always spelled out rather
 *  than encoded in a line style nobody can decode. */
function Edges({ placed, graph, related, selected }: {
  placed: Placed[]; graph: Graph;
  /** ids that survive the current selection, or null when nothing is selected */
  related?: Set<string> | null;
  selected?: string | null;
}) {
  /** An edge is only "kept" when BOTH ends are — an edge with one end dimmed is a line into fog, and
   *  reads as a mistake rather than as context. */
  const edgeAlive = (a?: string, b?: string) =>
    !related || (!!a && !!b && related.has(a) && related.has(b));
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
      // widthOf, NOT KIND_SIZE. Cards render at their COLUMN's uniform width, so a card of a
      // narrower kind — an aside is 260 where the column is 360 — measured 50px too small on each
      // side. The halo was drawn tight around widths nothing actually uses, and every wider card
      // hung outside its own topic box: the wrapper visibly failing to contain what belongs to it.
      const l = Math.min(...own.map((p) => p.x - widthOf(p) / 2)) - M;
      const r = Math.max(...own.map((p) => p.x + widthOf(p) / 2)) + M;
      const tp = Math.min(...own.map((p) => p.y - nodeHeight(p) / 2)) - M;
      const bt = Math.max(...own.map((p) => p.y + nodeHeight(p) / 2)) + M;
      return {
        id: t.id, branch: t.branch, x: Math.round(l), y: Math.round(tp),
        w: Math.round(r - l), h: Math.round(bt - tp),
        color: branchColor(branchIds, t.branch),
      };
    })
    .filter(Boolean) as {
      id: string; branch: string; x: number; y: number; w: number; h: number; color: string;
    }[];

  // Every relationship is planned in one place — which get lines, which lanes they take, and which
  // degrade to badges. See lib/edge-routing.ts for the reasoning; nothing about it is decided here.
  const plan = planEdges(placed, graph.edges ?? []);


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
            fill={h.color} fillOpacity={0.05}
            stroke={h.color}
            // THIN AND SOLID, not thick and faded. A 2px stroke at 0.28 opacity is a smudge: the
            // width says "important", the opacity says "ignore me", and the eye resolves the
            // contradiction as blur — which is exactly what video compression then destroys. One
            // crisp hairline at real opacity reads as a boundary at any bitrate. Width no longer
            // changes with state either; only opacity does, so the box never appears to swell.
            strokeOpacity={0.4}
            strokeWidth={1}
          />
        ))}

        {/* THE TREE. One connector per parent-child pair, leaving the parent's outward edge and
            arriving at the child's inward edge, with horizontal tangents at both ends.
            This one rule replaces four — the topic rail, the box-to-box link, the fan, and the
            chain — because with real depth in the graph there is only one kind of connection left to
            draw. A branch and a leaf are the same relationship at different depths. */}
        {placed.filter((n) => n.parent && byId.has(n.parent)).map((n) => {
          const p = byId.get(n.parent!)!;
          const hue = branchColor(branchIds, n.branch);
          const s = n.side;
          const x1 = p.x + s * widthOf(p) / 2;
          const x2 = n.x - s * widthOf(n) / 2;
          const c = (x2 - x1) * 0.5;

          return (
            <path
              key={`tree-${n.id}`}
              d={`M ${x1} ${p.y} C ${x1 + c} ${p.y}, ${x2 - c} ${n.y}, ${x2} ${n.y}`}
              fill="none" stroke={hue} strokeLinecap="round"
              // Thicker near the root: a branch carrying a whole subtree should read as heavier than
              // a twig carrying one leaf, the same way it would if you drew it by hand.
              strokeWidth={n.depth <= 1 ? 3 : n.depth === 2 ? 2 : 1.25}
              // The connection to the selected card is the ANSWER to the click, so it is drawn at
              // full strength while everything off the path recedes. Both ends must survive the
              // selection — see edgeAlive.
              strokeOpacity={edgeAlive(n.id, n.parent) ? (selected ? 1 : 0.9) : 0.12}
              style={{ transition: "stroke-opacity 260ms ease" }}
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

        {plan.lines.map((e) => (
          <g key={`t-${e.key}`}>
            <path
              d={e.d}
              fill="none"
              stroke="#9a9a95"
              strokeWidth={1.5}
              // Dotted, not dashed, and grey rather than a branch colour: a cross-link is the one
              // edge that does NOT belong to the tree, so it must not look like a branch. Same
              // convention every mind map uses for the association line.
              strokeDasharray="1 6"
              strokeLinecap="round"
              // The flow. Only typed edges animate: if every branch pulsed, the map would shimmer
              // constantly and the motion would stop meaning anything.
              style={{ animation: "flow 1.4s linear infinite" }}
            />
            {/* A dot where it leaves, an arrowhead where it lands. Same reason the topic links
                carry dots: a stroke that stops near a rounded corner reads as having missed it. The
                asymmetry is deliberate — a dot means "from here", an arrow means "to there", so the
                direction is legible even where the pill is clipped or too small to read. */}
            <circle cx={e.tail.x} cy={e.tail.y} r={3} fill="#b9b9b4" />
            <path
              d={`M ${e.head.x} ${e.head.y} l ${-6 * e.head.dir} -4 l 0 8 z`}
              fill="#b9b9b4"
            />
            {/* PILL, not bare text. A label sitting directly on the dashed stroke has the line
                running through the middle of the words and neither reads. An opaque pill breaks the
                dash exactly where the label is, so the gap itself says the line is annotated. */}
            {e.pill ? (
              <g>
                <rect
                  x={e.pill.x - e.pill.w / 2} y={e.pill.y - 9.5}
                  width={e.pill.w} height={19} rx={9.5}
                  fill="#ffffff" stroke="#e6e6e2" strokeWidth={1}
                />
                <text
                  x={e.pill.x} y={e.pill.y + 4}
                  textAnchor="middle"
                  className="fill-neutral-500"
                  style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.04em" }}
                >
                  {e.pill.label}
                </text>
              </g>
            ) : null}
          </g>
        ))}
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
  // Tangents follow the dominant axis. A horizontal-tangent curve between two vertically-stacked
  // boxes bulges sideways before coming back, which is exactly the shape that looked wrong.
  if (Math.abs(x2 - x1) >= Math.abs(y2 - y1)) {
    const dx = Math.round(Math.abs(x2 - x1) * 0.45) * (x2 >= x1 ? 1 : -1);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }
  const dy = Math.round(Math.abs(y2 - y1) * 0.45) * (y2 >= y1 ? 1 : -1);
  return `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
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
  const railX = Math.round(p.x - widthOf(p) / 2 + 14);
  const py = Math.round(p.y + nodeHeight(p) / 2);
  const cy = Math.round(c.y);
  const cx = Math.round(c.x - KIND_SIZE[c.kind].w / 2);
  const r = Math.min(12, Math.max(0, cy - py), Math.max(0, cx - railX));
  return `M ${railX} ${py} L ${railX} ${cy - r} Q ${railX} ${cy} ${railX + r} ${cy} L ${cx} ${cy}`;
}

/** BOX TO BOX. Picks the two facing sides and anchors on those, instead of always using left/right.
 *  Two cards stacked vertically were being joined side-to-side, so the line left one card's flank,
 *  travelled sideways and came back — the "not like this" in the screenshot. Choosing the axis with
 *  the greater separation makes the connection leave one box and enter the other by the shortest
 *  sensible route, which is what reads as two boxes being joined. */
function anchor(from: Placed, to: Placed): [number, number, number, number] {
  const fw = KIND_SIZE[from.kind].w / 2, fh = nodeHeight(from) / 2;
  const tw = KIND_SIZE[to.kind].w / 2, th = nodeHeight(to) / 2;
  const dx = to.x - from.x, dy = to.y - from.y;

  // Compare separation against each box's own size: two wide cards a little apart horizontally are
  // still "beside" each other, not "above" each other.
  if (Math.abs(dx) / (fw + tw) >= Math.abs(dy) / (fh + th)) {
    const s = dx >= 0 ? 1 : -1;
    return [from.x + s * fw, from.y, to.x - s * tw, to.y];
  }
  const s = dy >= 0 ? 1 : -1;
  return [from.x, from.y + s * fh, to.x, to.y - s * th];
}


/** How long between one card landing and the next. 250ms is fast enough that a 3-card chunk finishes
 *  inside a second, slow enough that each arrival is a separate event to the eye rather than a burst. */
const RELEASE_MS = 320;
/** How long a card sits as a skeleton before its content fills in.
 *
 *  A card that appears already complete has nothing to watch — it is just there, and "already there"
 *  is indistinguishable from "was there a minute ago". Landing as an empty block first and filling a
 *  beat later gives the arrival a beginning and an end, which is what makes it read as the board
 *  being BUILT rather than repainted. It is also honest: the block appears when the card is created,
 *  the content when it is known. */
const SKELETON_MS = 420;

/** Reveal node ids one at a time, in the order the producer created them.
 *
 *  Deliberately NOT a per-node animation delay. A delay staggers the fade of things that have all
 *  already arrived; this staggers the arrival itself, which is the difference between "three cards
 *  appeared and faded in at slightly different times" and "a card appeared, then another one did".
 *
 *  Everything queues, topics included. Exempting topics looked right on paper — a heading should
 *  precede what it heads — but it meant five topics arriving on one frame, which is the same pop the
 *  queue exists to remove. It isn't needed either: layout() emits a topic immediately before its own
 *  cards, so queueing in that order already puts the heading one beat ahead of what it heads. */
function useRevealQueue(targets: Placed[]) {
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set(targets.map((t) => t.id)));
  // Second stage. Anything present at mount is already hydrated — a page opened onto an existing
  // board should show the board, not play its construction back.
  const [hydrated, setHydrated] = useState<Set<string>>(() => new Set(targets.map((t) => t.id)));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The queue outlives any single render; keeping it in a ref means a re-layout mid-release (a
  // remeasure, say) doesn't restart or drop the pending cards.
  const pending = useRef<string[]>([]);

  useEffect(() => {
    const known = revealed;
    const fresh = targets.filter((t) => !known.has(t.id) && !pending.current.includes(t.id));
    if (!fresh.length) return;

    pending.current.push(...fresh.map((t) => t.id));

    if (timer.current) return;                 // a release cycle is already draining the queue
    const tick = () => {
      const next = pending.current.shift();
      if (!next) { timer.current = null; return; }
      setRevealed((prev) => new Set(prev).add(next));
      setTimeout(() => setHydrated((prev) => new Set(prev).add(next)), SKELETON_MS);
      timer.current = setTimeout(tick, RELEASE_MS);
    };
    // First card of a burst lands immediately; the rest follow on the beat. Waiting RELEASE_MS for
    // the first one just adds latency to every chunk for no visible benefit.
    tick();
  }, [targets, revealed]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // A node that disappeared (merged away) must not linger in the set, or a re-added id with the same
  // label would be considered already-revealed and skip its animation.
  useEffect(() => {
    const live = new Set(targets.map((t) => t.id));
    const prune = (prev: Set<string>) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    };
    setRevealed(prune);
    setHydrated(prune);
  }, [targets]);

  return { revealed, hydrated };
}


