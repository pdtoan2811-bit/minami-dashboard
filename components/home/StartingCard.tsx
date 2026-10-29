"use client";
// The dashed placeholder a new task holds its slot with (§37) — Thomas's pick V1 from pitch `task-lands`,
// 2026-10-29: "a placeholder from the click". The real card only exists once the chat has replied
// (20–60s), and until then the tile showed nothing, then a card simply appeared and was easy to miss.
// So the slot is taken at the click and the same place fills in: nothing pops in later.
// Driven by lib/ask.ts's starting store, the same one behind the shell's chip.
import { useSyncExternalStore } from "react";
import { getStarting, subscribeStarting, type Starting } from "@/lib/ask";
import type { ThreadView } from "@/lib/use-threads";

const none: Starting[] = [];

/** Starts in this project that don't have their real card yet. A failed start drops out at once — the
 *  chip carries the error and the draft is back in the sheet, so a card would only say it twice. */
export function useStartingCards(project: string, tasks: ThreadView[]): Starting[] {
  const all = useSyncExternalStore(subscribeStarting, getStarting, () => none);
  return all.filter((s) => s.project === project && s.state !== "failed"
    && !(s.sid && tasks.some((t) => t.sessions.some((x) => x.id === s.sid))));
}

export function StartingCard({ s }: { s: Starting }) {
  const where = s.state === "ready" ? "✓ Worktree · ✓ Sent · waiting for the first reply"
    : s.step === "sent" ? "✓ Worktree · ✓ Sent · opening the chat…" : "Making its worktree…";
  return (
    <div className="rounded-xl border border-dashed border-[var(--sakura)]/55 bg-[var(--sakura)]/[0.05] p-3" aria-live="polite">
      <p className="flex items-center gap-1.5 text-[11px] text-[var(--sakura)]">
        <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-[var(--sakura)] border-t-transparent" />
        starting…<span className="ml-auto text-neutral-500">now</span>
      </p>
      <p className="mt-1 line-clamp-2 text-[13.5px] font-semibold leading-snug text-neutral-100">{s.title}</p>
      <p className="mt-2 text-[11.5px] text-neutral-500">{where}</p>
      <div className="mt-2.5 flex gap-[3px]">{[0, 1, 2].map((i) => <span key={i} className="h-1 flex-1 rounded-sm bg-white/[0.06]" />)}</div>
    </div>
  );
}
