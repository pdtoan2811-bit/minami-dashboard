"use client";
// Everything this agent has done, newest first.
//
// The `via` badge is the honest part. A session in the agent's home folder is unambiguously its own;
// a session in a shared repo is only its own if a task record says so. Showing which is which stops
// the history from quietly overclaiming work that belonged to another pane in the same folder.
import { ago, fetchHistory, shortPath, type AgentDef } from "@/lib/agents/client";
import { useEffect, useState } from "react";

type Row = Awaited<ReturnType<typeof fetchHistory>>["sessions"][number];

export default function AgentHistory({ agent }: { agent: AgentDef }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    fetchHistory(agent.id)
      .then((d) => alive && setRows(d.sessions))
      .catch((e) => alive && setErr(String(e?.message || e)));
    return () => { alive = false; };
  }, [agent.id]);

  if (err) return <p className="p-4 text-[11px] text-red-300">{err}</p>;
  if (!rows) return <p className="p-4 text-[11px] text-neutral-600">Reading transcripts…</p>;
  if (!rows.length) {
    return (
      <div className="p-4 text-[11.5px] text-neutral-500">
        <p>Nothing yet.</p>
        <p className="mt-1 text-[11px] text-neutral-600">
          Sessions in <code>{shortPath(agent.home)}</code> count as {agent.name}&apos;s automatically.
          Work in other folders shows up here once it&apos;s been assigned as a task.
        </p>
      </div>
    );
  }

  const cost = rows.reduce((n, s) => n + s.cost, 0);

  return (
    <div className="overflow-y-auto p-4">
      <p className="mb-2 px-1 text-[10.5px] text-neutral-600">
        {rows.length} session{rows.length > 1 ? "s" : ""} · ${cost.toFixed(2)} · last {ago(rows[0].lastActivity)} ago
      </p>
      <div className="space-y-1">
        {rows.map((s) => (
          <a key={s.id} href={`/?session=${s.id}`}
            className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-1.5 text-[11.5px] hover:border-white/15">
            <span className={`shrink-0 rounded px-1 text-[9px] uppercase tracking-wider ${
              s.via === "task" ? "bg-amber-400/15 text-amber-300/80" : "bg-white/5 text-neutral-500"}`}>
              {s.via === "task" ? "task" : "home"}
            </span>
            <span className="truncate text-neutral-300">{s.run?.title || s.task || s.title}</span>
            <span className="ml-auto shrink-0 text-[10px] text-neutral-600">{s.tier}</span>
            <span className="shrink-0 tabular-nums text-[10px] text-neutral-600">{ago(s.lastActivity)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}
