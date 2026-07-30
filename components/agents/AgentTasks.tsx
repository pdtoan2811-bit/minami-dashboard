"use client";
// Assign work to one agent, and watch what it's done.
//
// The assign form is the unattended path: it dispatches and returns, and the run outlives whatever
// tab opened it. That's stated in the UI because the instinct is to sit and watch — and a run that
// takes twenty minutes will outlive your patience before it outlives itself.
import { ago, assignTask, fetchTasks, stopTask, type AgentDef, type AgentRow, type AgentTask } from "@/lib/agents/client";
import { useCallback, useEffect, useState } from "react";

const TINT: Record<string, string> = {
  done: "text-green-400", running: "text-amber-300", queued: "text-neutral-400",
  failed: "text-red-400", stopped: "text-neutral-500",
};

export default function AgentTasks({ agent, peers }: { agent: AgentDef; peers: AgentRow[] }) {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [brief, setBrief] = useState("");
  const [cwd, setCwd] = useState(agent.home);
  const [handoffTo, setHandoffTo] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { fetchTasks(agent.id).then((d) => setTasks(d.tasks)).catch(() => {}); }, [agent.id]);
  useEffect(() => { load(); const h = setInterval(load, 4000); return () => clearInterval(h); }, [load]);

  // The cwd choice has to re-seed when you switch agents — otherwise the previous agent's home stays
  // selected and the assign fails the workspace check for reasons that look arbitrary.
  useEffect(() => { setCwd(agent.home); }, [agent.home]);

  const submit = async () => {
    if (!brief.trim()) return;
    setBusy(true); setErr(null);
    try {
      await assignTask(agent.id, { brief: brief.trim(), cwd, handoffTo: handoffTo || undefined });
      setBrief(""); setHandoffTo(""); load();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4 overflow-y-auto p-4">
      <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3.5">
        <p className="text-[10px] uppercase tracking-wider text-neutral-500">Assign a task</p>
        <p className="mt-0.5 text-[11px] text-neutral-600">
          Runs unattended — {agent.name} can&apos;t ask you anything mid-run, so give it enough to decide
          on its own. It writes what it learned back to its home folder when it finishes.
        </p>
        <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={4}
          placeholder={`What should ${agent.name} do? Include what "done" looks like and where the output goes.`}
          className="mt-2 w-full resize-y rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-2 text-[12.5px] leading-relaxed outline-none focus:border-[var(--sakura)]/60" />

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-[10.5px] text-neutral-500">in</label>
          <select value={cwd} onChange={(e) => setCwd(e.target.value)}
            className="rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-neutral-200 outline-none">
            <option value={agent.home}>home</option>
            {agent.workspaces.map((w) => <option key={w} value={w}>{w.replace(/^\/Users\/[^/]+/, "~")}</option>)}
          </select>

          {peers.length > 0 && (
            <>
              <label className="text-[10.5px] text-neutral-500">then hand to</label>
              <select value={handoffTo} onChange={(e) => setHandoffTo(e.target.value)}
                className="rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[11px] text-neutral-200 outline-none">
                <option value="">nobody</option>
                {peers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </>
          )}

          <button onClick={submit} disabled={busy || !brief.trim()}
            className="ml-auto rounded-lg bg-[var(--sakura)] px-3 py-1 text-[11.5px] font-medium text-white disabled:opacity-40">
            {busy ? "Assigning…" : "Assign"}
          </button>
        </div>
        {err && <p className="mt-2 rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-300">{err}</p>}
      </div>

      <div className="space-y-1">
        {!tasks.length && <p className="px-1 text-[11px] text-neutral-600">No tasks yet.</p>}
        {tasks.map((t) => (
          <div key={t.id} className="rounded-xl border border-white/[0.07] bg-white/[0.02]">
            <button onClick={() => setOpen(open === t.id ? null : t.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11.5px]">
              <span className={`w-14 shrink-0 ${TINT[t.status] || "text-neutral-500"}`}>{t.status}</span>
              <span className="truncate text-neutral-300">{t.title}</span>
              {t.from && <span className="shrink-0 text-[10px] text-neutral-600">from {t.from}</span>}
              {t.handoffTo && <span className="shrink-0 text-[10px] text-neutral-600">→ {t.handoffTo}</span>}
              <span className="ml-auto shrink-0 tabular-nums text-[10.5px] text-neutral-600">{ago(t.createdAt)}</span>
            </button>
            {open === t.id && (
              <div className="space-y-2 border-t border-white/[0.07] px-3 py-2.5 text-[11.5px]">
                <p className="text-[10.5px] text-neutral-600">
                  {t.cwd}{t.startedAt ? ` · started ${ago(t.startedAt)} ago` : ""}{t.endedAt ? ` · ended ${ago(t.endedAt)} ago` : ""}
                </p>
                <p className="whitespace-pre-wrap text-neutral-500">{t.brief}</p>
                {t.error && <p className="rounded-lg bg-red-500/10 px-2.5 py-1.5 text-red-300">{t.error}</p>}
                {t.result && <p className="whitespace-pre-wrap rounded-lg bg-white/[0.04] px-2.5 py-2 text-neutral-300">{t.result}</p>}
                <div className="flex gap-2">
                  {t.status === "running" && (
                    <button onClick={() => stopTask(t.id).then(load)} className="rounded-md bg-white/10 px-2 py-0.5 text-[10.5px] text-neutral-300">Stop</button>
                  )}
                  {t.sessionId && (
                    <a href={`/?session=${t.sessionId}`} className="rounded-md bg-white/10 px-2 py-0.5 text-[10.5px] text-neutral-300">Open transcript</a>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
