"use client";
// /autopilot (§30): the goals (§29) and the automations (§27) on one page, goals first. A goal is the outcome;
// the automations are the runners that produce it — on two pages, "is this goal moving?" and "did its job run
// last night?" were answered a tab apart. Here each goal lists the runners working on it, and the runners list
// puts those first and the rest under Housekeeping.
//
// Both feeds are fetched here, not inside their sections, so the goal ↔ runner match and the shell's project
// filter are computed once over the same data the sections draw.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Goal } from "@/lib/goals";
import type { Automation } from "@/lib/automations";
import { matchesProject, projectKey, useProjectFilter } from "@/lib/project-filter";
import { Ground, TopBar, K } from "../today/ui";
import { GoalsSection, useGoals } from "./GoalsSection";
import { RunnersSection, useAutomations } from "./RunnersSection";
import { PhoneAutopilot } from "./PhoneAutopilot";
import { AsksProvider } from "./Asks";
import { MinamiPanel } from "./MinamiPanel";
import { useCompact } from "@/lib/use-media";
import { dayOf } from "./DayStrip";
import { StorageSection, useStorage } from "./StorageSection";

// The vault's goal runner measures and acts on every goal, whatever project the goal belongs to (lib/goals.ts).
const GOAL_RUNNER = "com.thomas.goal-runner";

// A runner serves a goal when it is the goal runner, or when it is filed under the goal's project. Goals name
// their project by vault note ("ecvision"), automations by display name ("Video Studio"); projectKey folds both,
// and matchesProject's one-way prefix lets an "ecvision" goal claim the "ecvisionContent" jobs, not the reverse.
const serves = (a: Automation, g: Goal) => a.id === GOAL_RUNNER || (!!projectKey(g.note) && !!projectKey(a.project) && matchesProject(g.note, a.project));

// Tabs (2026-10-22): "need tab navigation rather than goal and runners on same page". One page and two data folders
// (§31): goals and runners have different writers and rules, so each tab is its own module. The tab follows the
// URL: ?tab=runners, or a hash the rest of the app already links to (#runners, #auto-<id> → Runners; #goal-<id> →
// Goals), so the bell drawer, the Day strip chips and a goal's "worked on by" links all land on the right tab.
export type Tab = "goals" | "runners" | "storage";
function tabFromUrl(): Tab {
  const h = location.hash;
  if (/^#(runners|auto-)/.test(h)) return "runners";
  if (/^#goal-/.test(h)) return "goals";
  const t = new URLSearchParams(location.search).get("tab");
  return t === "runners" || t === "storage" ? t : "goals";
}
export function useTab(): [Tab, (t: Tab) => void] {
  const [tab, setTab] = useState<Tab>("goals");
  useEffect(() => {
    const sync = () => setTab(tabFromUrl());
    sync();
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => { window.removeEventListener("hashchange", sync); window.removeEventListener("popstate", sync); };
  }, []);
  const pick = (t: Tab) => { setTab(t); history.replaceState(null, "", t === "goals" ? location.pathname : `?tab=${t}`); };
  return [tab, pick];
}

export function Tabs({ tab, pick, goals, runners, storage }: { tab: Tab; pick: (t: Tab) => void; goals: { n: number; bad: number }; runners: { n: number; bad: number }; storage?: { label: string; bad: boolean } }) {
  const one = (t: Tab, label: string, c: { n: number; bad: number }) => (
    <button key={t} role="tab" aria-selected={tab === t} onClick={() => pick(t)}
      className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-[15px] font-semibold transition-colors"
      style={tab === t ? { background: "rgba(255,255,255,.12)", color: K.ink } : { color: K.muted }}>
      {label}<span className="text-[13px] font-medium" style={{ color: K.faint }}>{c.n}</span>
      {c.bad > 0 && <span className="rounded-full px-1.5 text-[11.5px] font-semibold" style={{ background: "rgba(243,199,102,.18)", color: "#f3c766" }}>{c.bad}</span>}
    </button>
  );
  return (
    <div role="tablist" className="inline-flex gap-1 rounded-full p-1" style={{ background: "rgba(255,255,255,.04)", border: `1px solid ${K.line}` }}>
      {one("goals", "Goals", goals)}{one("runners", "Runners", runners)}
      {/* Storage (§32) shows free GB instead of a count; amber when below the floor or the janitor has gone quiet. */}
      <button role="tab" aria-selected={tab === "storage"} onClick={() => pick("storage")}
        className="inline-flex h-10 items-center gap-2 rounded-full px-4 text-[15px] font-semibold transition-colors"
        style={tab === "storage" ? { background: "rgba(255,255,255,.12)", color: K.ink } : { color: K.muted }}>
        Storage{storage && <span className="text-[13px] font-medium" style={{ color: storage.bad ? "#f3c766" : K.faint }}>{storage.label}</span>}
      </button>
    </div>
  );
}

export function Autopilot() {
  const [pf] = useProjectFilter();
  const compact = useCompact();
  const g = useGoals();
  const feed = useAutomations();
  const [tab, pick] = useTab();
  // The goal on screen, so the Minami panel's threads and its message box are about THAT goal.
  const [goalId, setGoalId] = useState<string | null>(null);
  const stFeed = useStorage();
  const st = stFeed.s;
  const storage = st && !st.error ? { label: `${st.freeGB.toFixed(0)} GB`, bad: st.stale || st.freeGB < st.thresholds.lowGB } : undefined;

  const goals = useMemo(() => g.goals?.filter((x) => matchesProject(pf, x.note)) ?? null, [g.goals, pf]);
  const all = feed.items;
  const runnersFor = useMemo(() => (goal: Goal) => (all ?? []).filter((a) => serves(a, goal)), [all]);
  // Serving is judged against the goals on screen: with the filter on another project, its goal's runners are
  // housekeeping as far as this view is concerned.
  const serving = useMemo(() => new Set((all ?? []).filter((a) => (goals ?? []).some((x) => serves(a, x))).map((a) => a.id)), [all, goals]);
  // A runner that serves a visible goal stays visible even if its own project is another one — otherwise
  // filtering to "ecvision" would list the goal runner under the goal and then hide its card.
  const items = useMemo(() => all?.filter((a) => matchesProject(pf, a.project) || serving.has(a.id)) ?? null, [all, pf, serving]);

  // The page draws after two fetches, so the browser's own jump to #goal-<id> / #runners / #auto-<id> fires on an
  // empty page and lands nowhere. Re-do it once, the first time both feeds have arrived.
  const jumped = useRef(false);
  const ready = !!g.goals && !!all;
  useEffect(() => {
    if (!ready || jumped.current) return;
    jumped.current = true;
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) return;
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: id.startsWith("auto-") ? "center" : "start" }));
  }, [ready]);

  const hidden = (g.goals && goals ? g.goals.length - goals.length : 0) + (all && items ? all.length - items.length : 0);
  // The amber count on a tab: goals whose last run is behind, runners that need a look.
  const counts = {
    goals: { n: goals?.length ?? 0, bad: (goals ?? []).filter((x) => x.log.at(-1)?.decision.on_track === false).length },
    // the same rule as the strip's "N need a look" sentence, so the badge and the page never disagree
    runners: { n: items?.length ?? 0, bad: items ? dayOf(items).looks.length : 0 },
  };

  return (
    // One feed of the chats this page started: the Minami panel on desktop, a row on the card on a phone (Asks.tsx).
    <AsksProvider>
    <Ground>
      <TopBar title="Autopilot" />
      {/* On a phone the stacked cards made an 8,918px page; the phone gets its own view (PhoneAutopilot.tsx). */}
      {compact && tab !== "storage" ? <PhoneAutopilot goals={goals} runners={items} feed={feed} tab={tab} reloadGoals={g.reload} tabs={<Tabs tab={tab} pick={pick} goals={counts.goals} runners={counts.runners} storage={storage} />} /> : (
      // V4 of the autopilot-layout pitch (2026-10-22): the page on the left uses the width for numbers, to-dos and the
      // runner table; Minami is docked on the right (MinamiPanel.tsx) and holds every chat this tab started, with the
      // page's one message box. Storage has no chats, so it keeps the single column.
      <div className={`mx-auto px-5 pb-28 pt-2 sm:pb-16 ${tab === "storage" ? "max-w-[1160px]" : "max-w-[1560px]"}`}>
        {pf && (
          <p className="mb-4 text-[12.5px]" style={{ fontFamily: "var(--today-mono)", color: K.faint }}>
            Filtered to {pf} · {hidden} hidden
          </p>
        )}
        <div className="mb-5"><Tabs tab={tab} pick={pick} goals={counts.goals} runners={counts.runners} storage={storage} /></div>
        {tab === "storage" ? (
          <section id="storage" className="scroll-mt-6"><StorageSection feed={stFeed} /></section>
        ) : (
          <div className="grid items-start gap-6" style={{ gridTemplateColumns: "minmax(0,1fr) 380px" }}>
            {tab === "goals" ? (
              <section id="goals" className="min-w-0 scroll-mt-6">
                <GoalsSection goals={goals} total={g.goals?.length ?? 0} err={g.err} busy={g.busy} runNow={g.runNow} reload={g.reload} runnersFor={runnersFor} onShown={setGoalId} />
                {goals && g.goals && g.goals.length > 0 && goals.length === 0 && (
                  <p className="mt-4 text-[13.5px]" style={{ color: K.muted }}>No goals in {pf}.</p>
                )}
              </section>
            ) : (
              <section id="runners" className="min-w-0 scroll-mt-6"><RunnersSection feed={feed} items={items} serving={serving} /></section>
            )}
            {tab === "goals" ? (
              <MinamiPanel key="goals" about={goalId ? "about this goal" : "about your goals"}
                scopes={[{ kind: "goal", id: goalId ?? "*" }, { kind: "module", id: "goals" }, { kind: "module", id: "goals:new" }]}
                // A goal on screen → a chat with that goal's whole context (lib/autopilot-ask.ts); none → the goals module (§31).
                start={goalId ? { url: "/api/autopilot/ask", body: { kind: "goal", id: goalId }, field: "question" } : { url: "/api/modules", body: { op: "chat", id: "goals" }, field: "ask" }}
                placeholder={goalId ? "Ask about this goal…" : "Ask about your goals…"} />
            ) : (
              <MinamiPanel key="runners" about="about your runners"
                scopes={[{ kind: "runner", id: "*" }, { kind: "module", id: "runners" }]}
                start={{ url: "/api/modules", body: { op: "chat", id: "runners" }, field: "ask" }}
                placeholder="Ask about your runners — what failed, what runs tonight…" />
            )}
          </div>
        )}
      </div>
      )}
    </Ground>
    </AsksProvider>
  );
}
