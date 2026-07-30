"use client";
// One segmented control for the whole app.
//
// This shape was hand-rolled in nine places (bento time-window and sort, the composer's Plan/Code and
// approval pills, the same two again in /settings, Nav, the heatmap range, the panel tabs) and no two
// agreed: px-2 vs px-1.5, text-[10px] vs [11px] vs [10.5px], rounded-md inside rounded-lg vs
// rounded-full, and three different active treatments. Nothing was wrong with any one of them, which
// is exactly why they drifted — a control that looks fine alone still makes the UI read as assembled
// rather than designed when its neighbour is 0.5px different.
//
// `tone` exists for one real case, not for decoration: `bypassPermissions` auto-runs every tool, and
// it must not be the same colour as a benign selection. Everything else is `accent`.
import * as React from "react";

export type SegTone = "accent" | "good";

export type SegOption<T> = {
  value: T;
  label: React.ReactNode;
  /** Colour of the SELECTED state. Only worth overriding for a state that carries risk. */
  tone?: SegTone;
  title?: string;
};

const SIZE = {
  sm: "px-2 py-0.5 text-[10px]",
  md: "px-2 py-0.5 text-[11px]",
} as const;

const ON: Record<SegTone, string> = {
  accent: "bg-[var(--sakura)] text-white",
  good: "bg-green-500/20 text-green-400",
};

// `boolean` is in the constraint for the composer's Plan/Code pair, which is a two-state control whose
// state genuinely is a boolean — cheaper than inventing a "plan" | "code" union and mapping it twice.
export function Segmented<T extends string | number | boolean | null>({
  value, onChange, options, size = "md", lead, title, className = "", disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly SegOption<T>[];
  size?: keyof typeof SIZE;
  /** A static glyph before the first option (the bento sort control's `↕`). */
  lead?: React.ReactNode;
  title?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    // shrink-0 + whitespace-nowrap are load-bearing, not defensive: in /settings this control sits in a
    // `justify-between` row next to a paragraph of description, and without them flex shrank it until
    // "auto-edits" wrapped mid-word inside its own segment.
    <div title={title}
      className={`flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-lg border border-white/10 p-0.5 transition-opacity ${
        disabled ? "pointer-events-none opacity-30" : ""} ${className}`}>
      {lead && <span className="px-1 text-[10px] text-neutral-600">{lead}</span>}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={String(o.value)} onClick={() => onChange(o.value)} title={o.title}
            aria-pressed={on}
            className={`rounded-md font-medium transition-colors ${SIZE[size]} ${
              on ? ON[o.tone ?? "accent"] : "text-neutral-400 hover:text-neutral-200"}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
