"use client";

// The plan strip — the in-chat door to the flow canvas.
//
// It is the checklist that always sat above the composer, doing one more job: saying that the plan can
// be opened, and opening it. The canvas itself lives in the bento column (components/FlowCanvas.tsx),
// because that is where there is room for a graph and where the expansion can push the other tiles
// aside. This file is deliberately just the door — an earlier revision drew the whole flow here as a
// list, which meant two flow surfaces to keep in agreement. There is now one.

import { ChevronRight, ListChecks } from "lucide-react";
import { type FlowTurn } from "@/lib/flow-model";

/** The collapsed state: the strip above the composer that is the way in.
 *
 *  It reads the folded turn, not raw `TodoWrite` input, and that is the whole point of this revision.
 *  lib/flow-model.ts deliberately understands THREE plan tools — TodoWrite, TaskCreate, TaskUpdate —
 *  because Claude reaches for TaskCreate on its own; and where there is no plan at all it synthesizes
 *  steps from the tool calls. The strip used to look only at TodoWrite, so a turn tracked with
 *  TaskCreate built a perfectly good flow with **no door to it**, and an unplanned turn had none
 *  either. Same class of bug as v1's hidden gear: the feature existed and could not be reached.
 *
 *  It also stays put while a turn is running but has produced no steps yet, so the control lives in
 *  one place your eye can learn rather than appearing and vanishing mid-turn.
 */
export function FlowStrip({ turn, busy, compact, onOpen }: { turn: FlowTurn | undefined; busy: boolean; compact?: boolean; onOpen: () => void }) {
  const steps = turn?.steps ?? [];
  if (!steps.length && !busy) return null;

  const done = steps.filter((s) => s.status === "completed").length;
  const now = steps.find((s) => s.status === "in_progress");
  const planned = !!turn?.planned;
  const actions = steps.reduce((n, s) => n + s.tools.length, 0);

  // Says what it actually is. "plan · 3/12" is a claim about a plan Claude wrote; for a turn we
  // grouped ourselves, claiming a plan would be a small lie told every time.
  const label = !steps.length ? "flow" : planned ? `plan · ${done}/${steps.length}` : `flow · ${steps.length} step${steps.length === 1 ? "" : "s"}`;
  const detail = now ? now.title
    : !steps.length ? "starting…"
    : planned && done === steps.length ? "all steps done"
    : actions ? `${actions} action${actions === 1 ? "" : "s"}` : "";

  // Cramped, the strip gives up its own row and becomes a chip in the pane's utility bar (see the
  // density tiers in lib/density.ts). It keeps the count — "flow · 19 steps" is the part that tells you
  // whether opening it is worth the room — and drops the running-step detail, which is already said by
  // the activity line two inches to the right. Same button, same handler, same one door.
  if (compact) {
    return (
      <button onClick={onOpen}
        title={detail ? `${label} — ${detail}` : "Open the flow — review each step, pause and steer"}
        className="flex shrink-0 items-center gap-1 rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-neutral-500 transition-colors hover:border-white/25 hover:text-neutral-300">
        <ListChecks className="h-2.5 w-2.5 shrink-0" strokeWidth={2.5} />
        <span className="whitespace-nowrap">{label}</span>
        <ChevronRight className="h-2.5 w-2.5 shrink-0" />
      </button>
    );
  }

  return (
    <button onClick={onOpen}
      title="Open the flow — review each step, pause and steer"
      className="mb-2 flex w-full items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-left transition-colors hover:border-white/25 hover:bg-white/[0.04]">
      <ListChecks className="h-3 w-3 shrink-0 text-neutral-500" strokeWidth={2.5} />
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-neutral-500">{label}</span>
      <span className={`min-w-0 flex-1 truncate text-xs ${now ? "text-[var(--sakura)]" : "text-neutral-500"}`}>{detail}</span>
      {/* The affordance has to be visible at rest. v1's control only appeared on hover, on a tile, in
          another view — which is the whole reason nobody could find it. */}
      <span className="flex shrink-0 items-center gap-0.5 rounded-md border border-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-neutral-500">
        flow <ChevronRight className="h-2.5 w-2.5" />
      </span>
    </button>
  );
}
