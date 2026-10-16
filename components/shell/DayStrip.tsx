"use client";
// The Day strip on Bento (§30): one row above the tiles saying what else is going on — how many
// things wait on you, the next to-do, and each goal's pulse. Bento stayed the front door because the
// work happens there; this is so Today and Autopilot can't be forgotten from it. Every chip routes to
// the page that owns the thing; nothing is acted on here.
import Link from "next/link";
import { useShellData } from "./use-shell";
import { matchesProject, useProjectFilter } from "@/lib/project-filter";

export function DayStrip() {
  const d = useShellData();
  const [pf] = useProjectFilter();
  if (!d) return null;
  const needs = d.needs.filter((n) => matchesProject(pf, n.project)).length;
  const goals = d.day.goals.filter((g) => matchesProject(pf, g.note));
  if (!needs && !d.day.next && !goals.length) return null;
  const chip = "flex min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[12.5px] text-neutral-300 transition-colors hover:border-white/25 hover:text-white";
  return (
    <div className="mb-3 flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none]">
      {needs > 0 && (
        // Opens the bell's drawer rather than a page: the drawer is where "needs you" lives (§30).
        <button onClick={() => window.dispatchEvent(new Event("minami:open-drawer"))} className={chip}
          style={{ borderColor: "color-mix(in srgb, var(--sakura) 50%, transparent)" }}>
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--sakura)]" />{needs} waiting on you
        </button>
      )}
      <Link href="/today" className={`${chip} max-w-[22rem]`}>
        <span className="text-neutral-500">☀</span>
        {d.day.next ? <><span className="truncate">Next: {d.day.next.text}</span><span className="shrink-0 tabular-nums text-neutral-500">{d.day.left} left</span></>
          : d.day.done ? <span>All {d.day.done} to-dos done</span> : <span>No plan yet today</span>}
      </Link>
      {goals.map((g) => (
        <Link key={g.id} href={`/autopilot#goal-${g.id}`} className={`${chip} max-w-[18rem]`} title={g.goal}>
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: g.onTrack == null ? "#9ca3af" : g.onTrack ? "#6fbf8b" : "#e0a33e" }} />
          <span className="truncate">{g.goal}</span>
          <span className="shrink-0 tabular-nums text-neutral-500">{g.daysLeft}d</span>
        </Link>
      ))}
    </div>
  );
}
