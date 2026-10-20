"use client";
// /autopilot (§30): the goals (§29) and the automations (§27) on one page, goals first. A goal is the outcome;
// the automations are the runners that produce it — on two pages, "is this goal moving?" and "did its job run
// last night?" were answered a tab apart. Here each goal lists the runners working on it, and the runners list
// puts those first and the rest under Housekeeping.
//
// Both feeds are fetched here, not inside their sections, so the goal ↔ runner match and the shell's project
// filter are computed once over the same data the sections draw.
import { useEffect, useMemo, useRef } from "react";
import type { Goal } from "@/lib/goals";
import type { Automation } from "@/lib/automations";
import { matchesProject, projectKey, useProjectFilter } from "@/lib/project-filter";
import { Ground, TopBar, K } from "../today/ui";
import { GoalsSection, useGoals } from "./GoalsSection";
import { RunnersSection, useAutomations } from "./RunnersSection";
import { PhoneAutopilot } from "./PhoneAutopilot";
import { useCompact } from "@/lib/use-media";

// The vault's goal runner measures and acts on every goal, whatever project the goal belongs to (lib/goals.ts).
const GOAL_RUNNER = "com.thomas.goal-runner";

// A runner serves a goal when it is the goal runner, or when it is filed under the goal's project. Goals name
// their project by vault note ("ecvision"), automations by display name ("Video Studio"); projectKey folds both,
// and matchesProject's one-way prefix lets an "ecvision" goal claim the "ecvisionContent" jobs, not the reverse.
const serves = (a: Automation, g: Goal) => a.id === GOAL_RUNNER || (!!projectKey(g.note) && !!projectKey(a.project) && matchesProject(g.note, a.project));

export function Autopilot() {
  const [pf] = useProjectFilter();
  const compact = useCompact();
  const g = useGoals();
  const feed = useAutomations();

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

  return (
    <Ground>
      <TopBar title="Autopilot" />
      {/* Wider than the runners below: the goals are a list beside a run ledger (§29), the runners one column. */}
      {/* On a phone the stacked cards made an 8,918px page; the phone gets its own view (PhoneAutopilot.tsx). */}
      {compact ? <PhoneAutopilot goals={goals} runners={items} feed={feed} /> : (
      <div className="mx-auto max-w-[1160px] px-5 pb-28 pt-2 sm:pb-16">
        {pf && (
          <p className="mb-4 text-[12.5px]" style={{ fontFamily: "var(--today-mono)", color: K.faint }}>
            Filtered to {pf} · {hidden} hidden
          </p>
        )}
        <section id="goals" className="scroll-mt-6">
          <h2 className="text-[22px] font-semibold tracking-tight">Goals</h2>
          <p className="mt-1 text-[14px]" style={{ color: K.muted }}>Targets an agent works on every morning at 06:45. Your part lands on Today.</p>
          <GoalsSection goals={goals} total={g.goals?.length ?? 0} err={g.err} busy={g.busy} runNow={g.runNow} runnersFor={runnersFor} />
          {goals && g.goals && g.goals.length > 0 && goals.length === 0 && (
            <p className="mt-4 text-[13.5px]" style={{ color: K.muted }}>No goals in {pf}.</p>
          )}
        </section>
        <section id="runners" className="mx-auto mt-14 max-w-[860px] scroll-mt-6">
          <RunnersSection feed={feed} items={items} serving={serving} />
        </section>
      </div>
      )}
    </Ground>
  );
}
