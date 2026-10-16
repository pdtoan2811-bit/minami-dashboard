"use client";
// The roster — the top half of /crew (§30), formerly the whole of /agents.
//
// HQ gets its own wide card with a live chat in it, because that's the answer to "all I need is a tile
// like HQ to chat on": one place you talk to, which routes work to everyone else. The rest are bento
// tiles. Below them, the handoff strip — the only view in the dashboard where you can see one agent's
// work becoming another's.
//
// A component rather than a page so /crew can stack it above the products without the two halves
// sharing state: each owns its own poll and its own "new" dialog, exactly as the two pages did.
import AgentChat from "@/components/agents/AgentChat";
import AgentTile from "@/components/agents/AgentTile";
import NewAgent from "@/components/agents/NewAgent";
import { Eyebrow, Glass, K } from "@/app/today/ui";
import { ago, fetchAgents, type AgentRow, type AgentTask } from "@/lib/agents/client";
import { matchesProject, useProjectFilter } from "@/lib/project-filter";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const STATUS_TINT: Record<string, string> = {
  done: "text-green-400", running: "text-amber-300", queued: "text-neutral-400",
  failed: "text-red-400", stopped: "text-neutral-500",
};

export default function Roster() {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [broken, setBroken] = useState<{ file: string; reason: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pf] = useProjectFilter();

  const load = useCallback(async () => {
    try {
      // One request for the whole roster. The strip used to fan out a per-agent task fetch on every
      // 4s tick, which is an N+1 that grows with the roster; the route now returns `recent` itself.
      const d = await fetchAgents();
      setAgents(d.agents);
      setTasks(d.recent || []);
      setBroken(d.broken || []);
      setErr(null);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      setAgents([]);
    }
  }, []);

  // Same cadence as the bento grid's live poll: fast enough that a run starting is visible immediately,
  // slow enough that a roster left open all day costs nothing.
  useEffect(() => { load(); const h = setInterval(load, 4000); return () => clearInterval(h); }, [load]);

  const hq = agents?.find((a) => a.hq) || null;
  // HQ is never filtered out: it's the front door that routes work into every project, so narrowing to
  // one project shouldn't take away the place you'd ask about it. Everyone else belongs to a project
  // through their home folder or a workspace they may be assigned work in.
  const rest = agents?.filter((a) => !a.hq) || [];
  const shown = rest.filter((a) => matchesProject(pf, a.home, ...a.workspaces));
  const shownTasks = tasks.filter((t) => matchesProject(pf, t.cwd));
  const hidden = rest.length - shown.length;

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 px-1">
        <Eyebrow>AGENTS{agents ? ` · ${agents.length}` : ""}</Eyebrow>
        <button onClick={() => setCreating(true)}
          className="ml-auto rounded-full border px-3 py-1 text-[12px] font-medium hover:text-white"
          style={{ borderColor: K.line2, color: K.muted }}>
          + New agent
        </button>
      </div>

      {err && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{err}</p>}

      {/* A registry file that won't parse used to just drop its agent off the roster in silence —
          which, for files this app tells you to hand-edit, reads as "the agent is gone". */}
      {broken.map((b) => (
        <p key={b.file} className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11.5px] text-amber-200/90">
          <b>{b.file}</b> couldn&apos;t be read, so its agent isn&apos;t listed — {b.reason}
        </p>
      ))}

      {pf && hidden > 0 && (
        <p className="px-1 text-[11.5px]" style={{ color: K.faint }}>Filtered to {pf} · {hidden} hidden</p>
      )}

      {agents && agents.length === 0 && (
        <div className="rounded-[30px] border border-dashed px-6 py-14 text-center" style={{ borderColor: K.line2 }}>
          <p className="text-3xl">🜂</p>
          <p className="mt-3 text-sm text-neutral-200">No agents yet.</p>
          <p className="mx-auto mt-2 max-w-md text-[12px] leading-relaxed" style={{ color: K.muted }}>
            An agent is a name, a folder it thinks and remembers in, and a model. Point one at a folder
            you already keep notes in and it inherits that history — or give it a new one and interview
            it into existence.
          </p>
          <button onClick={() => setCreating(true)} className="mt-5 rounded-full px-4 py-1.5 text-[12.5px] font-semibold text-white" style={{ background: K.accent }}>
            Create your first agent
          </button>
        </div>
      )}

      {hq && (
        <Glass className="overflow-hidden">
          <div className="flex items-center gap-2.5 border-b px-4 py-2.5" style={{ borderColor: K.line }}>
            <span className="text-lg">{hq.icon}</span>
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-[13px] font-medium">
                {hq.name}
                <span className="rounded bg-[var(--sakura)]/20 px-1 text-[9px] uppercase tracking-wider text-[var(--sakura)]">HQ</span>
              </p>
              <p className="truncate text-[10.5px]" style={{ color: K.faint }}>{hq.role || "Your front door — it routes work to the others."}</p>
            </div>
            {hq.busy && <span className="ml-auto truncate text-[11px] text-[var(--sakura)]">{hq.label || hq.phase}</span>}
            <Link href={`/agents/${hq.id}`} className={`${hq.busy ? "" : "ml-auto"} shrink-0 rounded-full border px-2.5 py-0.5 text-[10.5px] hover:text-white`}
              style={{ borderColor: K.line2, color: K.muted }}>
              Open
            </Link>
          </div>
          <div className="h-[26rem]"><AgentChat agent={hq} /></div>
        </Glass>
      )}

      {shown.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
          {shown.map((a) => <AgentTile key={a.id} a={a} />)}
        </div>
      )}

      {agents && agents.length > 0 && !hq && (
        <p className="rounded-xl border bg-white/[0.06] px-3 py-2 text-[11px]" style={{ borderColor: K.line, color: K.muted }}>
          No HQ yet. Promote one agent to HQ (its Config tab) to get a front door that can route work to
          the others.
        </p>
      )}

      {shownTasks.length > 0 && (
        <div>
          <div className="mb-2 px-1"><Eyebrow>RECENT WORK</Eyebrow></div>
          <div className="space-y-1">
            {shownTasks.map((t) => {
              const owner = agents?.find((a) => a.id === t.agentId);
              const to = t.handoffTo ? agents?.find((a) => a.id === t.handoffTo) : null;
              return (
                <Link key={t.id} href={`/agents/${t.agentId}?tab=tasks`}
                  className="flex items-center gap-2 rounded-xl border bg-white/[0.06] px-3 py-1.5 text-[11.5px] hover:bg-white/[0.09]"
                  style={{ borderColor: K.line }}>
                  <span className={`w-14 shrink-0 ${STATUS_TINT[t.status] || "text-neutral-500"}`}>{t.status}</span>
                  {/* The chain, read left to right: who handed it over, who ran it, who gets it next. */}
                  {t.from && <span className="shrink-0" style={{ color: K.faint }}>{agents?.find((a) => a.id === t.from)?.icon || t.from} →</span>}
                  <span className="shrink-0">{owner?.icon}</span>
                  <span className="truncate text-neutral-200">{t.title}</span>
                  {to && <span className="shrink-0" style={{ color: K.faint }}>→ {to.icon}</span>}
                  <span className="ml-auto shrink-0 tabular-nums" style={{ color: K.faint }}>{ago(t.createdAt)}</span>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {creating && (
        <NewAgent
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); load(); window.location.href = `/agents/${id}`; }}
        />
      )}
    </section>
  );
}
