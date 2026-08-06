"use client";

// The plan strip — the in-chat door to the flow canvas, and the pane's own "where am I".
//
// It is the checklist that always sat above the composer, doing one more job: saying that the journey
// can be opened, and opening it. The canvas itself lives in the bento column
// (components/FlowCanvas.tsx), because that is where there is room for a graph and where the expansion
// can push the other tiles aside. This file is deliberately just the door — an earlier revision drew
// the whole flow here as a list, which meant two flow surfaces to keep in agreement. There is now one.
//
// ── v4: it reads the SESSION, not the last turn ──────────────────────────────────────────────────
// It used to fold only the newest turn, so it could say "plan · 3/12" about work that started ninety
// seconds ago and nothing at all about the four things you asked for before that. Since the canvas
// became a session-long journey, the strip reads the same `buildJourney` — so the number on it is the
// number on the canvas it opens, and "where am I" has one answer in this pane rather than two.

import { AlertTriangle, ChevronRight, ListChecks } from "lucide-react";
import { type Journey } from "@/lib/flow-model";

export function FlowStrip({ journey, busy, onOpen }: { journey: Journey | undefined; busy: boolean; onOpen: () => void }) {
  const milestones = journey?.milestones ?? [];
  if (!milestones.length && !busy) return null;

  const { done = 0, total = 0, open = 0, unit = "goals" } = journey?.progress ?? {};
  const last = milestones[milestones.length - 1];
  // The goal actually in flight, which is the one thing worth a word of screen space mid-turn. Falls
  // back to the newest milestone's own summary, so a turn with no plan still says something.
  const now = last?.turn.steps.find((s) => s.status === "in_progress");
  const pct = total ? Math.round((done / total) * 100) : 0;

  // Says what it actually is. "3/12 goals" is a claim about plans Claude wrote; where there were none,
  // `unit` has already fallen back to counting asks, and the label follows it rather than asserting a
  // plan that doesn't exist.
  const label = total ? `${done}/${total} ${unit}` : "flow";
  const detail = now?.title
    || (last ? last.narrative?.outcome || last.headline : "")
    || (busy ? "starting…" : "");

  // It is a CHIP, and only a chip. There used to be a second, full-width form that took its own row
  // above the composer; that was affordable while the 2×2 grid was the default view and the wide form
  // only appeared in a large pane, but with tabs-first every pane you read is large, so "sometimes"
  // became "always" — a permanent ~42px of the transcript, per pane, for a label.
  //
  // The affordance is still visible at rest, which is the one rule this control must not break: v1's
  // door only appeared on hover, on a tile, in another view, which is the whole reason nobody found it.
  return (
    <button onClick={onOpen}
      title={[detail && `now: ${detail}`, open > 0 && `${open} step${open === 1 ? "" : "s"} left open earlier in this session`, "Open the journey — every ask, what it did, and what's still unfinished"]
        .filter(Boolean).join("\n")}
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-white/25 hover:text-neutral-300">
      <ListChecks className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
      {/* The bar is the "where am I" at a glance — the count answers it precisely, the bar answers it
          without being read. Only drawn when there are real goals to be a fraction of. */}
      {total > 0 && (
        <span className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-white/10">
          <span className="block h-full rounded-full bg-[#1f8a5c] transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </span>
      )}
      {/* Tinted while a goal is actually running — the one moment the flow is worth opening mid-turn. */}
      <span className={`whitespace-nowrap tabular-nums ${now ? "text-[var(--sakura)]" : ""}`}>{label}</span>
      {open > 0 && (
        <span className="flex items-center gap-0.5 whitespace-nowrap text-[#e0a94a]" title={`${open} unfinished step${open === 1 ? "" : "s"}`}>
          <AlertTriangle className="h-2.5 w-2.5" />{open}
        </span>
      )}
      <ChevronRight className="h-2.5 w-2.5 shrink-0" />
    </button>
  );
}
