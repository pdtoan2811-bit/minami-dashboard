"use client";
// The roster — the agent view's front door.
//
// HQ gets its own wide card with a live chat in it, because that's the answer to "all I need is a tile
// like HQ to chat on": one place you talk to, which routes work to everyone else. The rest are bento
// tiles. Below them, the handoff strip — the only view in the dashboard where you can see one agent's
// work becoming another's.
import AgentChat from "@/components/agents/AgentChat";
import AgentTile from "@/components/agents/AgentTile";
import NewAgent from "@/components/agents/NewAgent";
import { Nav } from "@/components/Nav";
import { ago, fetchAgents, type AgentRow, type AgentTask } from "@/lib/agents/client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const STATUS_TINT: Record<string, string> = {
  done: "text-green-400", running: "text-amber-300", queued: "text-neutral-400",
  failed: "text-red-400", stopped: "text-neutral-500",
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [broken, setBroken] = useState<{ file: string; reason: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // One request for the whole page. The strip used to fan out a per-agent task fetch on every
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
  const rest = agents?.filter((a) => !a.hq) || [];

  return (
    <div className="bg-bento min-h-screen text-neutral-100">
      <header className="flex items-center gap-3 px-6 py-5">
        <span className="text-xl">🜂</span>
        <h1 className="text-base font-semibold tracking-tight">Agents</h1>
        {agents && <span className="text-[11px] text-neutral-600">{agents.length}</span>}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setCreating(true)} className="rounded-lg border border-white/10 px-2.5 py-1 text-[11px] text-neutral-300 hover:border-[var(--sakura)]/50 hover:text-neutral-100">
            + New agent
          </button>
          <Nav />
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-6 pb-16">
        {err && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{err}</p>}

        {/* A registry file that won't parse used to just drop its agent off the roster in silence —
            which, for files this app tells you to hand-edit, reads as "the agent is gone". */}
        {broken.map((b) => (
          <p key={b.file} className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2 text-[11.5px] text-amber-200/90">
            <b>{b.file}</b> couldn&apos;t be read, so its agent isn&apos;t listed — {b.reason}
          </p>
        ))}

        {agents && agents.length === 0 && (
          <div className="rounded-2xl border border-dashed border-white/15 px-6 py-14 text-center">
            <p className="text-3xl">🜂</p>
            <p className="mt-3 text-sm text-neutral-300">No agents yet.</p>
            <p className="mx-auto mt-2 max-w-md text-[12px] leading-relaxed text-neutral-500">
              An agent is a name, a folder it thinks and remembers in, and a model. Point one at a folder
              you already keep notes in and it inherits that history — or give it a new one and interview
              it into existence.
            </p>
            <button onClick={() => setCreating(true)} className="mt-5 rounded-lg bg-[var(--sakura)] px-3.5 py-1.5 text-[12px] font-medium text-white">
              Create your first agent
            </button>
          </div>
        )}

        {hq && (
          <section className="overflow-hidden rounded-2xl border border-[var(--sakura)]/25 bg-white/[0.03]">
            <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-4 py-2.5">
              <span className="text-lg">{hq.icon}</span>
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[13px] font-medium">
                  {hq.name}
                  <span className="rounded bg-[var(--sakura)]/20 px-1 text-[9px] uppercase tracking-wider text-[var(--sakura)]">HQ</span>
                </p>
                <p className="truncate text-[10.5px] text-neutral-500">{hq.role || "Your front door — it routes work to the others."}</p>
              </div>
              {hq.busy && <span className="ml-auto truncate text-[11px] text-[var(--sakura)]">{hq.label || hq.phase}</span>}
              <Link href={`/agents/${hq.id}`} className={`${hq.busy ? "" : "ml-auto"} shrink-0 rounded-lg border border-white/10 px-2 py-0.5 text-[10.5px] text-neutral-400 hover:text-neutral-100`}>
                Open
              </Link>
            </div>
            <div className="h-[26rem]"><AgentChat agent={hq} /></div>
          </section>
        )}

        {rest.length > 0 && (
          <section>
            <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">Roster</h2>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3">
              {rest.map((a) => <AgentTile key={a.id} a={a} />)}
            </div>
          </section>
        )}

        {agents && agents.length > 0 && !hq && (
          <p className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] text-neutral-500">
            No HQ yet. Promote one agent to HQ (its Config tab) to get a front door that can route work to
            the others.
          </p>
        )}

        {tasks.length > 0 && (
          <section>
            <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wider text-neutral-500">Recent work</h2>
            <div className="space-y-1">
              {tasks.map((t) => {
                const owner = agents?.find((a) => a.id === t.agentId);
                const to = t.handoffTo ? agents?.find((a) => a.id === t.handoffTo) : null;
                return (
                  <Link key={t.id} href={`/agents/${t.agentId}?tab=tasks`}
                    className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-1.5 text-[11.5px] hover:border-white/15">
                    <span className={`w-14 shrink-0 ${STATUS_TINT[t.status] || "text-neutral-500"}`}>{t.status}</span>
                    {/* The chain, read left to right: who handed it over, who ran it, who gets it next. */}
                    {t.from && <span className="shrink-0 text-neutral-600">{agents?.find((a) => a.id === t.from)?.icon || t.from} →</span>}
                    <span className="shrink-0">{owner?.icon}</span>
                    <span className="truncate text-neutral-300">{t.title}</span>
                    {to && <span className="shrink-0 text-neutral-600">→ {to.icon}</span>}
                    <span className="ml-auto shrink-0 tabular-nums text-neutral-600">{ago(t.createdAt)}</span>
                  </Link>
                );
              })}
            </div>
          </section>
        )}
      </main>

      {creating && (
        <NewAgent
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); load(); window.location.href = `/agents/${id}`; }}
        />
      )}
    </div>
  );
}
