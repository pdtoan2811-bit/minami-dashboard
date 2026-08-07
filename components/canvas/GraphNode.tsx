// One node on the infinite canvas.
//
// Every node is the same object at three levels of emphasis — a soft-light card, a state-coloured
// rail down its left edge, and a type icon. That sameness is deliberate: on a map with eleven node
// kinds, inventing a different shape per kind is what makes a canvas look assembled rather than
// designed. Kind is legible from the icon and the eyebrow label; state is legible from the rail.
//
// Depth comes from light, not from borders: a near-white card on an off-white field, lifted by a
// large soft shadow. That's the "soft minimal" register — it reads as premium without any glow,
// gradient or neon, and it survives a customer's mediocre projector.
import {
  DEFAULT_STATE, KIND_ICON, KIND_LABEL, KIND_SIZE, STATE_COLOR, initialsOf,
  type Placed,
} from "@/lib/canvas-graph";

export function GraphNode({ n, live, index }: { n: Placed; live: boolean; index: number }) {
  const size = KIND_SIZE[n.kind];
  const state = n.state ?? DEFAULT_STATE[n.kind];
  const color = STATE_COLOR[state];
  const isHero = n.kind === "decision";

  return (
    <div
      className="absolute [animation:nodeIn_var(--dur-4)_var(--ease-spring)_both]"
      style={{
        left: n.x - size.w / 2,
        top: n.y - size.h / 2,
        width: size.w,
        minHeight: size.h,
        // Stagger keeps a burst of nodes from landing as one blob, capped so a late node never waits.
        animationDelay: `${Math.min(index * 45, 500)}ms`,
      }}
    >
      <div
        className={`relative flex h-full flex-col justify-center overflow-hidden rounded-2xl bg-white ${
          isHero ? "px-5 py-4" : "px-4 py-3.5"
        }`}
        style={{
          // Two-layer shadow: a tight contact shadow to seat the card, and a wide soft one for lift.
          boxShadow: isHero
            ? "0 1px 2px rgba(16,24,40,0.06), 0 12px 32px -8px rgba(16,24,40,0.18)"
            : "0 1px 2px rgba(16,24,40,0.05), 0 6px 18px -6px rgba(16,24,40,0.12)",
          // The idle "breath". Per-node phase offset so the map undulates instead of pulsing as one
          // object, which would read as a loading state rather than as something alive.
          animation: `breathe ${7 + (index % 5)}s ease-in-out ${index * 0.35}s infinite`,
        }}
      >
        {/* State rail. Colour lives here and nowhere else, so text always keeps its ink token. */}
        <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} aria-hidden />

        <div className="mb-1 flex items-center gap-1.5">
          <span className="text-[11px] leading-none" style={{ color }} aria-hidden>
            {KIND_ICON[n.kind]}
          </span>
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.11em] text-neutral-400">
            {KIND_LABEL[n.kind]}
          </span>
          {n.at ? <span className="tabular-nums ml-auto text-[10.5px] text-neutral-300">{n.at}</span> : null}
        </div>

        {n.kind === "quote" ? (
          <p className="text-[16px] font-medium leading-snug text-neutral-800">“{n.label}”</p>
        ) : (
          <p
            className={`leading-snug text-neutral-800 ${isHero ? "text-[17px] font-semibold" : "text-[14.5px] font-medium"}`}
          >
            {n.label}
          </p>
        )}

        {n.kind === "meter" && typeof n.value === "number" ? <Meter value={n.value} /> : null}
        {n.kind === "poll" && n.options ? <Poll options={n.options} /> : null}
        {n.kind === "shot" ? <Shot src={n.src} /> : null}

        {(n.owner || n.by || n.collapsed) && n.kind !== "meter" ? (
          <div className="mt-2 flex items-center gap-2">
            {n.owner || n.by ? (
              <>
                <Avatar name={(n.owner || n.by)!} />
                <span className="truncate text-[11.5px] text-neutral-500">
                  {n.owner ? n.owner : `${n.by} said`}
                </span>
              </>
            ) : null}
            {n.collapsed ? (
              <span className="ml-auto rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-500">
                +{n.collapsed} more
              </span>
            ) : null}
          </div>
        ) : null}

        {/* Live ring on the focused node — the camera is already here, this says why. */}
        {live ? (
          <span
            className="pointer-events-none absolute inset-0 rounded-2xl"
            style={{ boxShadow: `0 0 0 2px ${color}, 0 0 0 6px ${color}22` }}
            aria-hidden
          />
        ) : null}
      </div>
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-neutral-200 text-[9.5px] font-semibold text-neutral-600">
      {initialsOf(name)}
    </span>
  );
}

/** Diverging meter. Alignment is a state, so a status hue is right — and it always ships with the
 *  number and a word, never colour alone. */
function Meter({ value }: { value: number }) {
  const v = Math.max(-1, Math.min(1, value));
  const pct = ((v + 1) / 2) * 100;
  const word = v > 0.25 ? "Converging" : v < -0.25 ? "Diverging" : "Neutral";
  const color = v > 0.25 ? STATE_COLOR.agreed : v < -0.25 ? STATE_COLOR.blocked : "#a3a3a3";
  return (
    <div className="mt-2">
      <div className="flex items-baseline gap-2">
        <span className="tabular-nums text-[22px] font-semibold leading-none text-neutral-800">
          {v > 0 ? "+" : ""}{v.toFixed(2)}
        </span>
        <span className="text-[11.5px] font-medium" style={{ color }}>{word}</span>
      </div>
      <div className="relative mt-2 h-1.5 rounded-full bg-neutral-100">
        <span className="absolute left-1/2 top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-neutral-300" />
        <span
          className="absolute top-0 h-1.5 rounded-full"
          style={{ background: color, left: `${Math.min(50, pct)}%`, width: `${Math.abs(pct - 50)}%` }}
        />
      </div>
    </div>
  );
}

function Poll({ options }: { options: { text: string; votes: number }[] }) {
  const total = Math.max(1, options.reduce((s, o) => s + o.votes, 0));
  return (
    <div className="mt-2 space-y-1.5">
      {options.map((o, i) => (
        <div key={i}>
          <div className="flex justify-between text-[11.5px] text-neutral-600">
            <span className="truncate">{o.text}</span>
            <span className="tabular-nums ml-2 text-neutral-400">{o.votes}</span>
          </div>
          <div className="mt-1 h-1.5 rounded-full bg-neutral-100">
            <span
              className="block h-1.5 rounded-full"
              style={{ width: `${(o.votes / total) * 100}%`, background: STATE_COLOR.proposed }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function Shot({ src }: { src?: string }) {
  return (
    <div className="mt-2 aspect-video overflow-hidden rounded-lg bg-neutral-100">
      {/* Plain <img>: runtime screen captures, not build-time assets — next/image would add a
          round-trip for nothing. */}
      {src ? <img src={src} alt="" className="size-full object-cover" /> : (
        <div className="grid size-full place-items-center text-[10.5px] text-neutral-400">no capture</div>
      )}
    </div>
  );
}
