"use client";
// One agent, as a bento tile.
//
// Same visual grammar as the project tiles on the home board — rounded card, big glyph, a live ring
// while it's working — because it's the same question being answered ("what is running, and what is
// it doing"), just grouped by who rather than by where. Reusing the language means the agent view
// doesn't have to be learned separately.
import Link from "next/link";
import type { AgentRow } from "@/lib/agents/client";

const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");

export default function AgentTile({ a }: { a: AgentRow }) {
  const working = a.busy;
  return (
    <Link
      href={`/agents/${a.id}`}
      className={`group relative flex flex-col gap-2 rounded-2xl border p-4 transition-colors ${
        working ? "border-[var(--sakura)]/40 bg-[var(--sakura)]/[0.06]" : "border-white/10 bg-white/[0.03] hover:border-white/20"
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="relative text-2xl leading-none">
          {a.icon}
          {/* A ring only while genuinely busy — "live but idle" is a warm subprocess, not activity, and
              a permanently-lit tile teaches you to stop reading the light. */}
          {working && <span className="absolute -right-1 -top-1 h-2 w-2 animate-pulse rounded-full bg-[var(--sakura)]" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium text-neutral-100">
            {a.name}
            {a.hq && <span className="rounded bg-[var(--sakura)]/20 px-1 text-[9px] uppercase tracking-wider text-[var(--sakura)]">HQ</span>}
          </p>
          <p className="truncate text-[11px] text-neutral-500">{a.role || "No role set"}</p>
        </div>
      </div>

      <p className="truncate text-[10.5px] text-neutral-600" title={a.home}>{shortPath(a.home)}</p>

      {working ? (
        <p className="truncate text-[11px] text-[var(--sakura)]">{a.label || a.phase}</p>
      ) : a.runningTask ? (
        <p className="truncate text-[11px] text-amber-300/80">
          ↻ {a.runningTask.title}{a.runningCount > 1 ? ` +${a.runningCount - 1} more` : ""}
        </p>
      ) : a.recentTasks?.[0] ? (
        <p className="truncate text-[11px] text-neutral-600">
          {a.recentTasks[0].status === "failed" ? "✗" : "✓"} {a.recentTasks[0].title}
        </p>
      ) : !a.onboardedAt ? (
        // The one nag on this tile, and it earns its place: an agent that never sat through its
        // interview has a CLAUDE.md full of TODOs, and will behave like a blank assistant with a name.
        <p className="truncate text-[11px] text-amber-400/70">Needs its interview</p>
      ) : (
        <p className="truncate text-[11px] text-neutral-700">idle</p>
      )}

      <div className="mt-auto flex items-center gap-2 pt-1 text-[10px] text-neutral-600">
        <span className="rounded bg-white/5 px-1.5 py-0.5">{a.model.replace("claude-", "")}</span>
        {a.workspaces.length > 0 && <span>+{a.workspaces.length} workspace{a.workspaces.length > 1 ? "s" : ""}</span>}
      </div>
    </Link>
  );
}
