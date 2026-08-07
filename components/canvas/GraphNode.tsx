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
  DEFAULT_STATE, KIND_ICON, KIND_LABEL, KIND_SIZE, STATE_COLOR, TINT, initialsOf,
  type Placed,
} from "@/lib/canvas-graph";

export function GraphNode({ n, live, index, rel }: {
  n: Placed; live: boolean; index: number;
  /** Relationships whose other end is too far to draw as a line — worn here instead. */
  rel?: { kind: string; other: string }[];
}) {
  const size = KIND_SIZE[n.kind];
  const state = n.state ?? DEFAULT_STATE[n.kind];
  const color = STATE_COLOR[state];
  const tint = TINT[state];
  const isHero = n.kind === "decision";
  const isTopic = n.kind === "topic";

  // Fire a pulse when a node MATURES (proposed → agreed). Only on change, never on mount: a map
  // that pulses every card on arrival has no way left to signal that something actually happened.
  const [pop, setPop] = useState(false);
  const seen = useRef(state);
  useEffect(() => {
    if (seen.current === state) return;
    seen.current = state;
    setPop(true);
    const t = setTimeout(() => setPop(false), 900);
    return () => clearTimeout(t);
  }, [state]);

  // Topics are signposts, not content. They stay small and quiet so the leaves they carry are what
  // the eye lands on — a map where every node shouts has no hierarchy at all.
  if (isTopic) {
    return (
      <Shell n={n} size={size} index={index}>
        <div
          className="flex h-full items-center gap-2.5 rounded-full bg-white px-5"
          style={{ boxShadow: "0 1px 2px rgba(16,24,40,0.05), 0 8px 20px -8px rgba(16,24,40,0.14)" }}
        >
          <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
          <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-neutral-700">
            {n.label}
          </span>
          {n.collapsed ? (
            <span className="ml-auto shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-semibold text-neutral-500">
              +{n.collapsed}
            </span>
          ) : null}
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
          ...(pop ? { animation: "statePop 900ms var(--ease-out) both" } : null),
          // An unanswered question keeps a slow halo: the map quietly remembering something is open,
          // without the urgency of an alert. Stops the moment it stops being open.
          ...(!pop && state === "open" ? { animation: "waiting 2.8s ease-in-out infinite" } : null),
          boxShadow: isHero
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
          {n.at ? (
            <span className="tabular-nums ml-auto text-[11px] font-medium text-neutral-400">{n.at}</span>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-4 pb-3 pt-3">
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

          {n.detail ? (
            <p className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-neutral-500">{n.detail}</p>
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
  return (
    <div
      className="absolute left-0 top-0 will-change-transform"
      style={{
        width: size.w,
        minHeight: size.h,
        // No CSS transition: positions arrive already eased, from the single rAF loop in GraphCanvas
        // that also draws the edges. Transitioning here as well would double-animate and, worse,
        // desynchronise the cards from the branches connecting them.
        transform: `translate3d(${n.x - size.w / 2}px, ${n.y - size.h / 2}px, 0)`,
      }}
    >
      <div
        className="h-full [animation:nodeIn_var(--dur-4)_var(--ease-spring)_both]"
        style={{ animationDelay: `${Math.min(index * 45, 420)}ms` }}
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
 *  camera being somewhere else entirely. */
function Relations({ rel }: { rel: { kind: string; other: string }[] }) {
  return (
    <div className="mt-2 space-y-1">
      {rel.slice(0, 2).map((r, i) => (
        <div
          key={i}
          className="flex items-center gap-1.5 rounded-lg bg-neutral-100/80 px-2 py-1"
        >
          <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-neutral-400">
            {REL_WORD[r.kind] ?? r.kind}
          </span>
          <span className="truncate text-[11.5px] font-medium text-neutral-600">{r.other}</span>
        </div>
      ))}
    </div>
  );
}

function Footer({ n, color }: { n: Placed; color: string }) {
  const people = n.people ?? (n.owner ? [n.owner] : n.by ? [n.by] : []);
  const hasAny = people.length || n.tags?.length || n.reactions?.length;
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
