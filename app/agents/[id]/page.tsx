"use client";
// One agent, four ways of looking at it: talk to it, configure it, read what it's done, give it work.
//
// Tabs rather than four pages because they're four views of one subject and switching between them is
// constant — you read a failed task, change the model, and go back to the chat to ask why. The chat
// stays mounted across tab switches (hidden, not unmounted) so its SSE stream and scroll position
// survive; remounting it would tear down the stream and replay the whole transcript every time.
import AgentChat from "@/components/agents/AgentChat";
import AgentConfig from "@/components/agents/AgentConfig";
import AgentHistory from "@/components/agents/AgentHistory";
import AgentTasks from "@/components/agents/AgentTasks";
import { Nav } from "@/components/Nav";
import { PanelTabs } from "@/components/PanelTabs";
import { fetchAgent, fetchAgents, shortPath, startOnboarding, type AgentDef, type AgentRow } from "@/lib/agents/client";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type Tab = "chat" | "tasks" | "history" | "config";

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const [agent, setAgent] = useState<AgentDef | null>(null);
  const [peers, setPeers] = useState<AgentRow[]>([]);
  const [live, setLive] = useState<AgentRow | null>(null);
  const [tab, setTab] = useState<Tab>((search.get("tab") as Tab) || "chat");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetchAgent(id).then((d) => alive && setAgent(d.agent)).catch((e) => alive && setErr(String(e?.message || e)));
    return () => { alive = false; };
  }, [id]);

  // The roster poll does double duty: peers for the handoff picker, and this agent's own live state
  // for the header. Server-owned, replace semantics — the same contract the bento grid uses, so the
  // header can't drift into claiming an activity state nothing is actually in.
  useEffect(() => {
    const tick = () => fetchAgents().then((d) => {
      setPeers(d.agents.filter((a) => a.id !== id));
      setLive(d.agents.find((a) => a.id === id) || null);
    }).catch(() => {});
    tick();
    const h = setInterval(tick, 4000);
    return () => clearInterval(h);
  }, [id]);

  if (err) return <div className="bg-bento min-h-screen p-6 text-[13px] text-red-300">{err}</div>;
  if (!agent) return <div className="bg-bento min-h-screen p-6 text-[13px] text-neutral-500">Loading…</div>;

  return (
    <div className="bg-bento flex h-screen flex-col text-neutral-100">
      <header className="flex shrink-0 items-center gap-3 px-6 py-4">
        <Link href="/agents" className="text-neutral-600 hover:text-neutral-300">←</Link>
        <span className="text-xl">{agent.icon}</span>
        <div className="min-w-0">
          <h1 className="flex items-center gap-1.5 text-base font-semibold tracking-tight">
            {agent.name}
            {agent.hq && <span className="rounded bg-[var(--sakura)]/20 px-1 text-[9px] uppercase tracking-wider text-[var(--sakura)]">HQ</span>}
          </h1>
          <p className="truncate text-[11px] text-neutral-500">
            {agent.role || "No role set"} · <span className="text-neutral-600">{shortPath(agent.home)}</span>
          </p>
        </div>
        {live?.busy && (
          <span className="ml-3 flex shrink-0 items-center gap-1.5 truncate text-[11px] text-[var(--sakura)]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--sakura)]" />{live.label || live.phase}
          </span>
        )}
        <div className="ml-auto"><Nav /></div>
      </header>

      {!agent.onboardedAt && (
        <div className="mx-6 mb-2 flex shrink-0 items-center gap-3 rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3.5 py-2 text-[11.5px] text-amber-200/90">
          <span>
            {agent.name} hasn&apos;t been interviewed yet — its CLAUDE.md is still a template, so it&apos;ll
            behave like a blank assistant with a name on it.
          </span>
          <button onClick={() => startOnboarding(agent.id).then(() => setTab("chat")).catch((e) => setErr(String(e?.message || e)))}
            className="ml-auto shrink-0 rounded-lg bg-amber-400/20 px-2.5 py-1 text-[11px] text-amber-100">
            Run the interview
          </button>
        </div>
      )}

      <div className="mx-6 mb-6 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-white/10 bg-white/[0.02]">
        <PanelTabs
          active={tab}
          onPick={(k) => setTab(k as Tab)}
          tabs={[
            { key: "chat", label: "Chat" },
            { key: "tasks", label: "Tasks" },
            { key: "history", label: "History" },
            { key: "config", label: "Config" },
          ]}
        />
        {/* Kept mounted — see the note at the top of this file. */}
        <div className={`min-h-0 flex-1 ${tab === "chat" ? "" : "hidden"}`}><AgentChat agent={agent} /></div>
        {tab === "tasks" && <div className="min-h-0 flex-1"><AgentTasks agent={agent} peers={peers} /></div>}
        {tab === "history" && <div className="min-h-0 flex-1"><AgentHistory agent={agent} /></div>}
        {tab === "config" && <div className="min-h-0 flex-1"><AgentConfig agent={agent} onChange={setAgent} /></div>}
      </div>
    </div>
  );
}
