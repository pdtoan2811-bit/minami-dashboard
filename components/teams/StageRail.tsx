"use client";
// A run's stages, as a rail.
//
// Two facts have to be readable at a glance and they're different questions: how far along is this,
// and did anything go wrong. Hence a dot per stage (progress) plus, in the expanded form, whether the
// stage's section actually landed in the dossier — a stage can finish successfully and write nothing,
// and that hole is invisible in a status column that only knows done/failed.
import { STAGE_TONE, type RunStage } from "@/lib/teams/client";

export function StageDots({ stages }: { stages: RunStage[] }) {
  return (
    <span className="flex items-center gap-1">
      {stages.map((s) => (
        <span key={s.key} title={`${s.section} — ${s.status}`}
          className={`h-1.5 w-1.5 rounded-full ${STAGE_TONE[s.status] || "bg-white/15"}`} />
      ))}
    </span>
  );
}

export default function StageRail({ stages }: { stages: RunStage[] }) {
  return (
    <ol className="space-y-1">
      {stages.map((s, i) => (
        <li key={s.key} className="flex items-center gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-1.5">
          <span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-neutral-600">{i + 1}</span>
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STAGE_TONE[s.status] || "bg-white/15"}`} />
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-neutral-300">{s.section}</span>
          {s.status === "done" && s.appended === false && (
            <span title="This stage finished without writing its section — everything after it is missing that context."
              className="shrink-0 rounded bg-amber-400/15 px-1.5 text-[9.5px] uppercase tracking-wider text-amber-300/90">
              no section
            </span>
          )}
          {s.error && <span className="max-w-[45%] shrink-0 truncate text-[10.5px] text-red-300/80" title={s.error}>{s.error}</span>}
          <span className="shrink-0 text-[10.5px] text-neutral-600">{s.status}</span>
        </li>
      ))}
    </ol>
  );
}
