"use client";
// One node on the infinite canvas.
//
// v1 of this was a white rounded rectangle with a 3px colour rail and one line of text — which is
// to say, indistinguishable from every SaaS card ever shipped, and carrying so little content that
// the map read as labels floating in a void. The fix isn't more colour, it's more SUBSTANCE:
//
//  · a tinted header band with the kind and a colour-filled icon chip, so a node is identifiable
//    from across the room before you read a word of it
//  · a headline AND a supporting detail line — the headline says what, the detail says why it
//    matters, and that second line is most of what makes a node feel like a thing rather than a tag
//  · a footer that carries people, tags and reactions, so every node shows who is involved
//
// The fun lives in the footer: emoji reactions attach to the node that earned them, so a 🎉 sits on
// the decision rather than floating over the canvas. Personality tied to meaning, not sprinkled on.
//
// Structure is identical across all eleven kinds on purpose. With a different shape per kind, a map
// of eleven types looks assembled rather than designed; kind is legible from the icon and eyebrow.
import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_STATE, FAMILY_COLOR, FAMILY_TINT, KIND_ICON, KIND_LABEL, KIND_SIZE, STATE_COLOR, TINT,
  familyOf, initialsOf, measured, nodeHeight, widthOf,
  type Placed,
} from "@/lib/canvas-graph";

export function GraphNode({ n, live, index, rel, branchHue, skeleton, announcing, newest, selected }: {
  n: Placed; live: boolean; index: number;
  /** Clicked — the card whose connections are being traced. Drawn as a ring rather than a fill so the
   *  card's own kind colour still reads; the selection is a question about the card, not a new state
   *  of it. */
  selected?: boolean;
  /** True for the first beat after the card lands, before its content fills in. */
  skeleton?: boolean;
  /** This topic just opened — the one event the camera moves for. */
  announcing?: boolean;
  /** The most recently added card: what is being talked about right now. */
  newest?: boolean;
  /** Relationships whose other end is too far to draw as a line — worn here instead. */
  rel?: { kind: string; other: string }[];
  /** The cluster's colour, so a heading can carry it without the card palette changing. */
  branchHue?: string;
}) {
  // FALL BACK, DO NOT THROW. An unknown kind used to crash here — KIND_SIZE[n.kind] is undefined, so
  // reading .h took down the whole canvas and replaced the board with an error overlay. The ingest
  // path validates (CARD_KINDS.has(kind) ? kind : "note"), so a meeting cannot produce one; a direct
  // publish to /api/canvas can, and did. One bad card must cost that card's dimensions, never the
  // entire board in the middle of a call.
  const size = { w: widthOf(n), h: (KIND_SIZE[n.kind] ?? KIND_SIZE.note).h };
  const state = n.state ?? DEFAULT_STATE[n.kind];
  // Colour is KIND, never state — see the note on KIND_FAMILY. State survives as the small dot in
  // the header, which is the right weight for it: you look for it, it doesn't shout at you.
  const family = familyOf(n);
  const color = FAMILY_COLOR[family];
  const tint = FAMILY_TINT[family];
  const stateColor = STATE_COLOR[state];
  // Only worth showing when it isn't simply what this kind always is. A "proposed" badge on every
  // card teaches you to stop reading badges.
  const showState = state !== DEFAULT_STATE[n.kind];
  const isHero = n.kind === "decision";
  const isTopic = n.kind === "topic";

  // Fire a pulse when a node MATURES (proposed → agreed). Only on change, never on mount: a map
  // that pulses every card on arrival has no way left to signal that something actually happened.
  const [pop, setPop] = useState(false);
  // The moment the skeleton fills in. A ring in the card's own colour flares and fades — it marks
  // the arrival as an EVENT, and because it uses the kind colour it also teaches the palette: you
  // learn "green means decided" by watching a decision arrive green.
  const [justFilled, setJustFilled] = useState(false);
  const wasSkeleton = useRef(!!skeleton);
  useEffect(() => {
    if (wasSkeleton.current && !skeleton) {
      setJustFilled(true);
      const t = setTimeout(() => setJustFilled(false), 900);
      wasSkeleton.current = false;
      return () => clearTimeout(t);
    }
    wasSkeleton.current = !!skeleton;
  }, [skeleton]);

  const seen = useRef(state);
  useEffect(() => {
    if (seen.current === state) return;
    seen.current = state;
    setPop(true);
    const t = setTimeout(() => setPop(false), 900);
    return () => clearTimeout(t);
  }, [state]);

  // ── stage one: the block ──────────────────────────────────────────────────────────────────────
  // Same box, same position, same size — only the content is missing. Nothing moves when it fills,
  // because a card that resizes on hydrate would shove its neighbours and undo the whole point of
  // reserving the slot before the card arrives.
  if (skeleton && !isTopic) {
    return (
      <Shell n={n} size={size} index={index}>
        <div
          className="flex h-full flex-col overflow-hidden rounded-[18px] border bg-white"
          style={{ borderColor: color, boxShadow: `0 0 0 3px ${tint}` }}
        >
          <div className="flex items-center gap-2 px-4 py-3" style={{ background: tint }}>
            <span className="size-5 rounded-md" style={{ background: color, opacity: 0.35 }} />
            <span className="h-2 w-16 rounded-full" style={{ background: color, opacity: 0.28 }} />
          </div>
          <div className="flex flex-1 flex-col gap-2.5 px-4 pt-4">
            {/* Bars, not a spinner. A spinner says "waiting"; bars say "text is coming, roughly this
                much of it", which is the only useful thing a placeholder can tell you. */}
            <span className="h-3 w-4/5 rounded-full bg-neutral-200" style={{ animation: "shimmer 1.1s ease-in-out infinite" }} />
            <span className="h-2.5 w-full rounded-full bg-neutral-100" style={{ animation: "shimmer 1.1s ease-in-out 120ms infinite" }} />
            <span className="h-2.5 w-3/5 rounded-full bg-neutral-100" style={{ animation: "shimmer 1.1s ease-in-out 240ms infinite" }} />
          </div>
        </div>
      </Shell>
    );
  }

  // Topics are signposts, not content. They stay small and quiet so the leaves they carry are what
  // the eye lands on — a map where every node shouts has no hierarchy at all.
  // A topic is a HEADER, not a card. It was rendered as a floating white pill, which made it look
  // like just another (oddly small) node rather than the label for everything beneath it. Depth 1 is
  // the column title; deeper topics are section labels inside it — a clear size step, so you can
  // tell a column from a section at a glance.
  // A topic is the cluster's HEADING. It was 19px of plain text floating beside 300px cards — the
  // "big cards next to tiny pills" mismatch. It now carries a branch-coloured marker and a rule that
  // runs to the edge of the group, so it reads as a heading with a scope rather than as a stray
  // label, and gives the cluster a definite top-left corner for everything else to align against.
  if (isTopic) {
    const hue = branchHue ?? "#8a8a86";
    return (
      <Shell n={n} size={size} index={index}>
        <div className="relative flex h-full flex-col justify-center">
          {/* The flare. A wash in the branch's own colour blooms behind the heading and clears —
              paired with the camera move, so a new topic is announced twice over: once by where you
              are looking, once by colour arriving where you land. Behind the text, never over it. */}
          {announcing ? (
            <span
              className="pointer-events-none absolute -inset-x-3 -inset-y-2 rounded-2xl"
              style={{ background: hue, animation: "topicArrive 2400ms var(--ease-out) both" }}
              aria-hidden
            />
          ) : null}
          <div className="relative flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{
                background: hue,
                ...(announcing ? { animation: "topicPulse 2400ms var(--ease-out) both" } : null),
              }}
              aria-hidden
            />
            {/* Every topic is a pill in its own branch colour. It used to be a pill only when
                active and plain grey otherwise, which made the palette mean two things at once —
                "this is branch X" and "we are here now" — and left the rest of the board looking
                unfinished. The colour now says only which branch it is; the green ring says where
                we are. One cue, one meaning. */}
            <span
              className="rounded-lg px-2 py-0.5 text-[17px] font-bold leading-tight tracking-[-0.02em] text-white"
              style={{ background: hue }}
            >
              {n.label}
            </span>
            {n.collapsed ? (
              <span className="shrink-0 rounded-full bg-neutral-200/70 px-1.5 py-0.5 text-[10.5px] font-bold text-neutral-500">
                +{n.collapsed}
              </span>
            ) : null}
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell n={n} size={size} index={index}>
      <div
        className="relative flex h-full flex-col overflow-hidden rounded-[18px] bg-white"
        style={{
          ["--pop" as string]: `${color}66`,
          // ONE animation slot, so precedence has to be explicit rather than emergent. It used to be
          // four conditional spreads and the last one that matched silently won — which is why the
          // green "we're on this card" ring never appeared on a card whose state happened to be
          // `open`: the ambient waiting halo was spread after it and took the slot.
          //
          // Order is by lifetime, shortest first. A transient event (just arrived, just matured)
          // outranks a standing condition (this is the current card, this question is unanswered),
          // because the event is over in under a second and the condition will still be true after.
          animation: pop
            ? "statePop 900ms var(--ease-out) both"
            : justFilled
              ? "fillIn 900ms var(--ease-out) both"
              : newest
                ? "newestRing 1.6s cubic-bezier(0.4, 0.03, 0.2, 1) infinite"
                : state === "open"
                  ? "waiting 2.8s ease-in-out infinite"
                  : undefined,
          // SELECTION OUTRANKS THE RESTING SHADOW. A ring in the card's own kind colour, plus a
          // lifted shadow — the same visual grammar as `newest`, because both answer "this one", just
          // one by arriving and the other by being asked about.
          boxShadow: selected
            ? `0 0 0 2.5px ${color}, 0 1px 2px rgba(16,24,40,0.06), 0 22px 50px -12px rgba(16,24,40,0.30)`
            : isHero
              ? "0 1px 2px rgba(16,24,40,0.06), 0 18px 44px -12px rgba(16,24,40,0.22)"
              : "0 1px 2px rgba(16,24,40,0.05), 0 10px 26px -10px rgba(16,24,40,0.15)",
        }}
      >
        {/* Header band — tint + icon chip + kind. The identity strip. */}
        <div
          className="flex items-center gap-2 px-4 py-2.5 transition-colors duration-[var(--dur-4)]"
          style={{ background: tint }}
        >
          <span
            className="grid size-[22px] shrink-0 place-items-center rounded-lg text-[12px] font-bold text-white transition-colors duration-[var(--dur-4)]"
            style={{ background: color }}
            aria-hidden
          >
            {KIND_ICON[n.kind]}
          </span>
          <span className="text-[10.5px] font-bold uppercase tracking-[0.13em]" style={{ color }}>
            {KIND_LABEL[n.kind]}
          </span>
          {showState ? (
            <span className="ml-auto flex items-center gap-1.5">
              <span className="size-1.5 rounded-full" style={{ background: stateColor }} aria-hidden />
              <span className="text-[10px] font-semibold capitalize text-neutral-500">{state}</span>
            </span>
          ) : null}
          {n.at ? (
            <span className={`tabular-nums text-[11px] font-medium text-neutral-400 ${showState ? "ml-2" : "ml-auto"}`}>
              {n.at}
            </span>
          ) : null}
        </div>

        <div
          className="flex min-h-0 flex-1 flex-col px-4 pb-3 pt-3"
          style={justFilled ? { animation: "contentIn 460ms var(--ease-out) both" } : undefined}
        >
          {n.kind === "quote" ? (
            <p className="text-[17px] font-medium leading-snug tracking-[-0.01em] text-neutral-800">
              “{n.label}”
            </p>
          ) : (
            <p
              className={`leading-snug tracking-[-0.01em] text-neutral-900 ${
                isHero ? "text-[19px] font-semibold" : "text-[15.5px] font-semibold"
              }`}
            >
              {n.label}
            </p>
          )}

          {/* No line-clamp. Truncated detail is unreadable exactly when you most need it — while
              working out why a card is wrong. Layout measures real heights now, so long text costs a
              taller card rather than a broken cluster. */}
          {n.detail ? (
            <p className="mt-1 text-[12.5px] leading-snug text-neutral-500">{n.detail}</p>
          ) : null}

          {n.kind === "meter" && typeof n.value === "number" ? <Meter value={n.value} /> : null}
          {n.kind === "poll" && n.options ? <Poll options={n.options} /> : null}
          {n.kind === "shot" ? <Shot src={n.src} /> : null}
          {typeof n.progress === "number" ? <Progress value={n.progress} color={color} /> : null}

          {rel?.length ? <Relations rel={rel} /> : null}
          <Footer n={n} color={color} />
        </div>

        {live ? (
          <span
            className="pointer-events-none absolute inset-0 rounded-[18px]"
            style={{ boxShadow: `0 0 0 2px ${color}, 0 0 0 7px ${color}1f` }}
            aria-hidden
          />
        ) : null}
      </div>
    </Shell>
  );
}

/** Positioning + entrance + idle breath.
 *
 *  THREE nested layers, and the nesting is the whole point — each owns one transform, so they can
 *  run simultaneously without fighting for the same property:
 *
 *    outer   translate to (x, y), TRANSITIONED  → glides when the layout reshuffles
 *    middle  entrance keyframe (scale + drop)   → the arrival
 *    inner   idle breath                        → the ambient life
 *
 *  Position was `left`/`top` before, which cannot be transitioned smoothly and forces layout on
 *  every change. That is why adding a node made its siblings TELEPORT: the radial layout
 *  redistributes angles whenever a branch gains a child, so every sibling gets a new coordinate at
 *  once. Same maths now, but the map re-forms in front of you instead of cutting. It also reads as
 *  causal — you see the branch make room for the thing that just arrived. */
function Shell({
  n, size, index, children,
}: { n: Placed; size: { w: number; h: number }; index: number; children: React.ReactNode }) {
  // Measure after paint and hand the real height back to the layout. One observer per node is
  // cheap; the alternative is guessing how text wraps, which is what put cards outside their halos.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => {
      // offsetHeight, NOT getBoundingClientRect: the card sits inside the camera's `scale(zoom)`
      // transform, and getBoundingClientRect reports the SCALED height. Zoomed out that reads back
      // smaller than the card really is, so the layout packs the next card into space the first one
      // actually occupies — the overlap. offsetHeight is layout height, before any transform.
      const h = el.offsetHeight;
      if (h > 20 && Math.abs((measured.get(n.id) ?? 0) - h) > 2) {
        measured.set(n.id, h);
        window.dispatchEvent(new CustomEvent("canvas:remeasure"));
      }
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [n.id]);

  // Vertical placement MUST use the same height the layout reserved. It used to use
  // KIND_SIZE[kind].h — a fixed per-kind constant — while layout() spaced siblings by nodeHeight(),
  // which accounts for detail text, footers and relation badges. Two different numbers for the same
  // card: the layout leaves a 240px slot, the card is drawn as if it were 150px tall and its content
  // spills past the bottom into the next one. Measuring heights could never fix that on its own.
  const h = nodeHeight(n);
  return (
    <div
      className="absolute left-0 top-0 will-change-transform"
      style={{
        width: size.w,
        minHeight: h,
        // No CSS transition: positions arrive already eased, from the single rAF loop in GraphCanvas
        // that also draws the edges. Transitioning here as well would double-animate and, worse,
        // desynchronise the cards from the branches connecting them.
        transform: `translate3d(${n.x - size.w / 2}px, ${n.y - h / 2}px, 0)`,

      }}
    >
      {/* Band caption. Sits OUTSIDE the measured element on purpose: the layout already reserved a
          row for it (BAND_LABEL_H), so including it in the card's measured height would double-count
          and reopen the overlap this pass just closed. */}
      <div
        ref={ref}
        className="h-full [animation:nodeIn_var(--dur-4)_var(--ease-spring)_both]"
        // No delay. This used to stagger a burst of simultaneous mounts by index — but arrival is
        // now staggered upstream by the release queue, and a card that waits its turn and THEN waits
        // another 420ms before animating just looks stalled. Each card animates the moment it lands.
      >
        {/* Effect layer — its own element so a shake or a jump never fights the entrance above it
            or the breath below it. Three transforms, three owners. */}
        <div className="h-full" style={fxStyle(n)}>
          <div
            className="h-full"
            style={{ animation: `breathe ${7 + (index % 5)}s ease-in-out ${index * 0.35}s infinite` }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Maps a node's transient fx (and the merge state) onto an animation. */
function fxStyle(n: Placed): React.CSSProperties {
  if (n.mergingInto) return { animation: "absorb 800ms var(--ease-out) both" };
  switch (n.fx) {
    case "shake": return { animation: "shake 520ms var(--ease-out) both" };
    case "jump": return { animation: "jump 700ms var(--ease-spring) both" };
    case "glow": return { animation: "glowPulse 1100ms var(--ease-out) both" };
    default: return {};
  }
}

const REL_WORD: Record<string, string> = {
  blocks: "Blocks", depends: "Depends on", answers: "Answers", contradicts: "Contradicts",
};

/** A relationship the map couldn't draw. Reads as a sentence on the card — "Blocks · 5-week pilot"
 *  — which is more legible than a wire crossing three unrelated nodes ever was, and survives the
 *  camera being somewhere else entirely.
 *
 *  Two is the cap because a card wearing four chips is a list, not a card, and the height it forces
 *  pushes its neighbours around. But the overflow is COUNTED rather than dropped: the routing model
 *  promises a relationship is always a line or a badge and never neither, and a chip list that
 *  silently ends at two would break that promise at the last possible step — the one place nobody
 *  would think to look for it. */
function Relations({ rel }: { rel: { kind: string; other: string }[] }) {
  const shown = rel.slice(0, 2);
  const more = rel.length - shown.length;
  return (
    <div className="mt-2 space-y-1">
      {shown.map((r, i) => (
        <div
          key={i}
          className="flex items-center gap-1.5 rounded-lg bg-neutral-100/80 px-2 py-1"
        >
          <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.1em] text-neutral-400">
            {REL_WORD[r.kind] ?? r.kind}
          </span>
          <span className="truncate text-[11.5px] font-medium leading-snug text-neutral-600">{r.other}</span>
        </div>
      ))}
      {more > 0 ? (
        <div className="px-2 text-[10px] font-bold uppercase tracking-[0.1em] text-neutral-400">
          +{more} more
        </div>
      ) : null}
    </div>
  );
}

function Footer({ n, color }: { n: Placed; color: string }) {
  const people = n.people ?? (n.owner ? [n.owner] : n.by ? [n.by] : []);
  const hasAny = people.length || n.tags?.length || n.reactions?.length || n.mergedFrom?.length;
  if (!hasAny) return null;

  return (
    <div className="mt-auto flex items-center gap-2 pt-2.5">
      {people.length ? <AvatarStack names={people} /> : null}
      {n.by && !n.owner ? (
        <span className="truncate text-[11.5px] font-medium text-neutral-500">{n.by}</span>
      ) : null}
      {n.owner ? <span className="truncate text-[11.5px] font-medium text-neutral-600">{n.owner}</span> : null}

      {n.tags?.length ? (
        <span className="flex min-w-0 gap-1">
          {n.tags.slice(0, 2).map((t) => (
            <span
              key={t}
              className="truncate rounded-md bg-neutral-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-neutral-500"
            >
              {t}
            </span>
          ))}
        </span>
      ) : null}

      {n.mergedFrom?.length ? (
        <span
          className="flex min-w-0 items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[10.5px] font-semibold text-neutral-500"
          title={`Merged in: ${n.mergedFrom.join(" · ")}`}
        >
          <span aria-hidden>⤿</span>
          <span className="truncate">
            {n.mergedFrom.length === 1 ? n.mergedFrom[0] : `${n.mergedFrom.length} merged in`}
          </span>
        </span>
      ) : null}

      {n.reactions?.length ? (
        <span className="ml-auto flex shrink-0 gap-1">
          {n.reactions.map((r, i) => (
            <span
              key={i}
              className="flex items-center gap-1 rounded-full border border-neutral-200/80 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-neutral-600"
              // Reactions pop in a beat after the node lands, so the celebration reads as a
              // RESPONSE to the node rather than as part of it.
              style={{ animation: `reactionIn 520ms var(--ease-spring) ${240 + i * 90}ms both` }}
            >
              <span className="text-[12px] leading-none">{r.emoji}</span>
              <span className="tabular-nums">{r.count}</span>
            </span>
          ))}
        </span>
      ) : (
        <span className="ml-auto shrink-0 rounded-full" style={{ background: `${color}00` }} />
      )}
    </div>
  );
}

function AvatarStack({ names }: { names: string[] }) {
  return (
    <span className="flex shrink-0 -space-x-1.5">
      {names.slice(0, 3).map((nm, i) => (
        <span
          key={i}
          className="grid size-[22px] place-items-center rounded-full bg-neutral-700 text-[9.5px] font-bold text-white ring-2 ring-white"
          title={nm}
        >
          {initialsOf(nm)}
        </span>
      ))}
    </span>
  );
}

function Progress({ value, color }: { value: number; color: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="mt-2.5">
      <div className="flex items-baseline justify-between text-[11px] font-medium text-neutral-400">
        <span>Progress</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-neutral-100">
        <span className="block h-1.5 rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

/** Alignment is a STATE, not a series, so a status hue is right — and it always ships with the
 *  number and a word, never colour alone. */
function Meter({ value }: { value: number }) {
  const v = Math.max(-1, Math.min(1, value));
  const pct = ((v + 1) / 2) * 100;
  const word = v > 0.25 ? "Converging" : v < -0.25 ? "Diverging" : "Neutral";
  const color = v > 0.25 ? STATE_COLOR.agreed : v < -0.25 ? STATE_COLOR.blocked : "#a3a3a3";
  return (
    <div className="mt-2.5">
      <div className="flex items-baseline gap-2">
        <span className="tabular-nums text-[30px] font-bold leading-none tracking-[-0.02em] text-neutral-900">
          {v > 0 ? "+" : ""}{v.toFixed(2)}
        </span>
        <span className="text-[12px] font-bold" style={{ color }}>{word}</span>
      </div>
      <div className="relative mt-2.5 h-2 rounded-full bg-neutral-100">
        <span className="absolute left-1/2 top-1/2 h-3.5 w-px -translate-x-1/2 -translate-y-1/2 bg-neutral-300" />
        <span
          className="absolute top-0 h-2 rounded-full"
          style={{ background: color, left: `${Math.min(50, pct)}%`, width: `${Math.abs(pct - 50)}%` }}
        />
      </div>
    </div>
  );
}

function Poll({ options }: { options: { text: string; votes: number }[] }) {
  const total = Math.max(1, options.reduce((s, o) => s + o.votes, 0));
  const lead = Math.max(...options.map((o) => o.votes));
  return (
    <div className="mt-2.5 space-y-2">
      {options.map((o, i) => {
        const winning = o.votes === lead;
        return (
          <div key={i}>
            <div className="flex justify-between text-[12px]">
              <span className={`truncate ${winning ? "font-semibold text-neutral-700" : "text-neutral-500"}`}>
                {o.text}
              </span>
              <span className="tabular-nums ml-2 font-semibold text-neutral-400">{o.votes}</span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-neutral-100">
              <span
                className="block h-2 rounded-full transition-[width] duration-[var(--dur-4)]"
                style={{
                  width: `${(o.votes / total) * 100}%`,
                  background: winning ? STATE_COLOR.proposed : "#cfd4da",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Shot({ src }: { src?: string }) {
  return (
    <div className="mt-2.5 aspect-video overflow-hidden rounded-xl bg-neutral-100 ring-1 ring-neutral-200/70">
      {/* Plain <img>: runtime screen captures, not build-time assets — next/image would add a
          round-trip for nothing. */}
      {src ? <img src={src} alt="" className="size-full object-cover" /> : (
        <div className="grid size-full place-items-center text-[11px] font-medium text-neutral-400">
          no capture yet
        </div>
      )}
    </div>
  );
}
