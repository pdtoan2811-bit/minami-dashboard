"use client";
// The bento, collapsed to a vertical strip.
//
// Why it exists: with a chat panel dragged out to 85–90% there isn't room for a 3-column grid, but
// there's still room for *navigation* — and losing the project switcher entirely is what forces you
// to drag the divider back and forth. So past a threshold the grid doesn't shrink, it changes state.
//
// The rail is the same information at a lower resolution, not a different widget. It keeps every
// signal the tiles carry, in the same encoding:
//   · size      — weight, as a share of the full column height (see WEIGHT below)
//   · opacity   — recency decay, identical thresholds
//   · tint      — the project's own accent colour
//   · status    — live / review / recent dot, same palette
//   · activity  — a pulsing ring when a dashboard run is working in that folder
//
// Hovering the strip slides the names out over the chat. That's the whole context-switching move: at
// 56px an icon says *which* project only if you already know its icon, and a per-chip tooltip makes
// you hunt one at a time. Widening once shows the whole list at once, and costs no layout — the strip
// keeps its 56px footprint and the panel overlays.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ProjectIcon } from "@/components/ProjectIcon";

/** Structural subset of `Project` in app/page.tsx — kept loose so the rail doesn't import the page. */
export type RailProject = {
  name: string; weight: number; last: number; active: boolean; review: boolean; reqs: number; cwd: string;
};

export const RAIL_W = 56; // px — the strip's fixed footprint, and the divider's snap target
const OPEN_W = 208;       // px — the hover-expanded overlay
const GAP = 4;            // px between chips
const MIN_H = 30;         // px — below this a chip is neither clickable nor legible

// `weight` is `reqs + tokens/5000`, which spans three orders of magnitude across real projects — a
// busy repo is ~360× a fresh one, and raw proportions would render every other project as a 2px
// sliver. Log compression keeps the ordering and the *sense* of relative size (~3× across that same
// range) while leaving every project big enough to hit.
const WEIGHT = (w: number) => Math.log1p(Math.max(0, w)) + 0.6;

export default function BentoRail({ projects, current, accent, fmtNum, busyCwds, icons, onOpen, onExpand, onNew }: {
  projects: RailProject[];
  /** Name of the project whose chat panel is open, if any. */
  current: string | null;
  accent: (name: string) => string;
  /** The grid's own number formatter, injected so "2.3k req" reads identically in both views. */
  fmtNum: (n: number) => string;
  /** cwds with a live dashboard run — the rail's version of the tile's activity line. */
  busyCwds: Set<string>;
  /** Per-project 3D icon override, same map the tiles use. */
  icons: Record<string, string | undefined>;
  onOpen: (p: RailProject) => void;
  onExpand: () => void;
  onNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState(0); // measured height available to the chips
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Chip heights are a share of the real column height, so the strip is always exactly full — which
  // means it has to be measured, not guessed: the height changes with the window, and with whether
  // the chat panel is even open.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const read = () => setBox(el.clientHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Opening is delayed, closing is not: a cursor travelling to the chat shouldn't drag the whole list
  // out behind it, but once you've left, the overlay has no business staying over what you clicked.
  const enter = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), 140); };
  const leave = () => { if (timer.current) clearTimeout(timer.current); setOpen(false); };

  const weights = projects.map((p) => WEIGHT(p.weight));
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const avail = Math.max(0, box - GAP * Math.max(0, projects.length - 1));

  return (
    // The footprint is fixed; the panel inside it is what grows. Anything else would shove the chat
    // sideways on hover, which is the one thing a hover must never do.
    <div className="relative h-full" style={{ width: RAIL_W }} onMouseEnter={enter} onMouseLeave={leave}>
      <div className={`absolute inset-y-0 left-0 z-30 flex flex-col border-r py-2 transition-[width,background-color] duration-200 ease-out ${
        open ? "border-white/10 bg-neutral-900/95 shadow-2xl backdrop-blur" : "border-white/[0.07] bg-black/20"}`}
        style={{ width: open ? OPEN_W : RAIL_W }}>

        <div className="flex shrink-0 items-center gap-1 px-2 pb-1">
          {/* The mark doubles as the way out — the affordance you reach for is the one you know. */}
          <button onClick={onExpand} title="Expand the bento (or drag the divider right)"
            className="group flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-lg transition-colors hover:bg-white/10">
            <span className="transition-transform group-hover:scale-110">🌸</span>
          </button>
          <span className={`min-w-0 flex-1 truncate text-[11px] font-semibold tracking-tight transition-opacity duration-150 ${open ? "opacity-100" : "opacity-0"}`}>
            Minami Bento
          </span>
        </div>

        <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {projects.map((p, i) => {
            const h = Math.max(MIN_H, Math.round((avail * weights[i]) / sum));
            // The icon tracks the chip it sits in, so weight reads at a glance even with the names out.
            const icon = Math.max(16, Math.min(34, Math.round(h * 0.52)));
            const age = Date.now() - p.last;
            const on = current === p.name;
            const busy = busyCwds.has(p.cwd);
            const dim = on || p.active || busy ? 1
              : age < 86400e3 ? 0.9 : age < 3 * 86400e3 ? 0.72 : age < 7 * 86400e3 ? 0.56 : 0.42;
            const pc = accent(p.name);
            const status = p.active ? "#4ade80" : p.review ? "#f0a868" : age < 12 * 3600e3 ? "#e8859b" : null;
            return (
              <button key={p.name} onClick={() => onOpen(p)} title={open ? undefined : p.name}
                style={{ height: h, opacity: dim, background: `linear-gradient(135deg, ${pc}26, transparent 70%)` }}
                className={`group relative flex w-full shrink-0 items-center gap-2 overflow-hidden rounded-xl border px-2 transition-[opacity,border-color,background-color] duration-200 hover:!opacity-100 ${
                  open ? "" : "justify-center"} ${
                  on ? "border-[var(--sakura)] ring-1 ring-[var(--sakura)]" : "border-white/10 hover:border-white/30"}`}>
                {busy && <span className="pointer-events-none absolute inset-0 animate-pulse rounded-xl ring-1" style={{ ["--tw-ring-color" as string]: pc + "88" }} />}
                <ProjectIcon name={p.name} icon={icons[p.name]} size={icon} active={p.active} />
                {/* Rendered always, revealed on expand: mounting it on hover would reflow the row and
                    make the names arrive a frame late, which reads as jank rather than as a panel. */}
                <span className={`min-w-0 flex-1 text-left transition-opacity duration-150 ${open ? "opacity-100 delay-75" : "pointer-events-none opacity-0"}`}>
                  <span className="block truncate text-[12px] font-medium text-neutral-100">{p.name}</span>
                  {h >= 42 && (
                    <span className="block truncate text-[10px] tabular-nums text-neutral-500">
                      {fmtNum(p.reqs)} req{busy ? " · working" : p.active ? " · live" : p.review ? " · review" : ""}
                    </span>
                  )}
                </span>
                {status && <span className={`shrink-0 rounded-full ${open ? "h-1.5 w-1.5" : "absolute right-1 top-1 h-1.5 w-1.5"}`} style={{ background: status }} />}
              </button>
            );
          })}
        </div>

        <button onClick={onNew} title="Start a new topic in a folder"
          className={`mx-2 mt-1 flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/15 text-neutral-500 transition-colors hover:border-[var(--sakura)]/50 hover:text-[var(--sakura)] ${open ? "" : "w-8 self-center"}`}>
          ＋<span className={`text-[11px] transition-opacity duration-150 ${open ? "opacity-100" : "hidden opacity-0"}`}>New topic</span>
        </button>
      </div>
    </div>
  );
}
