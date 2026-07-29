"use client";

// The Flow panel — the plan you're already looking at, opened up.
//
// ── What v1 got wrong, and why this is a rewrite rather than a fix ────────────────────────────────
// v1 was a React Flow canvas behind a per-project *view mode*, chosen from a hover-revealed gear on a
// bento tile. Three things followed from that, and all three were the same mistake wearing different
// clothes:
//
//   · **It was attached to the wrong noun.** A flow is a property of a TURN, not of a project. Asking
//     "is this a flow project?" from the grid, before opening anything, is a question nobody has. That
//     is why the button was impossible to find — not because it was small, but because no one goes
//     looking for it there. Here the entry point is the plan strip in the chat: the thing the flow is
//     *about*, at the moment you're curious about it.
//   · **It replaced the transcript instead of expanding it.** Flow-or-chat is a false choice; the
//     answer to "what did it just do" usually lives in both.
//   · **A canvas cannot do the interaction that was wanted.** "Expand a step and push the others
//     away" is layout. React Flow nodes are absolutely positioned, so v1 had to fan children off to
//     the RIGHT — its own comment said a parent's height "would push the whole spine apart". Plus a
//     minimap and zoom controls, which are for exploring an unknown topology. A plan is a list. It has
//     no topology to explore. In DOM, expand-and-push is free, and grouping is markup rather than a
//     layout algorithm.
//
// ── Semantic grouping ────────────────────────────────────────────────────────────────────────────
// A twelve-step plan drawn as twelve equal rows is a wall. Grouped by STATUS it's three lines, because
// that is the reviewer's actual question — what is it doing, what has it finished, what is coming.
// Only `running` is open by default; the others are one click. Inside a step the tool calls are
// grouped the same way, by what they DID (read / changed / ran / looked at) rather than by tool name.
//
// The controls are the point of the whole thing: while the brake is armed, the server parks the next
// tool call (setHold in lib/agent/manager.ts) and the held step gets Approve · Steer · Abort.

import { useMemo, useState } from "react";
import {
  Check, ChevronRight, CircleDot, Clock, FileDiff, Hand, ListChecks, Pause, Play, Search,
  SquareTerminal, Users, X, Sparkles,
} from "lucide-react";
import { type FlowStep, type FlowTool, type FlowTurn } from "@/lib/flow-model";
import { activityLabel, type PermissionPrompt } from "@/lib/use-agent";

const HELD = "#c47f18";
const RUNNING = "var(--sakura)";

/** Tools, grouped by what they did to the world. The user reviews outcomes, not tool names. */
const BUCKETS = [
  { id: "changed", label: "changed", Icon: FileDiff, tint: "#c47f18", match: (n: string) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(n) },
  { id: "ran", label: "ran", Icon: SquareTerminal, tint: "#1f8a5c", match: (n: string) => /^(Bash|BashOutput|KillShell)$/.test(n) },
  { id: "read", label: "read", Icon: Search, tint: "#0f7f9c", match: (n: string) => /^(Read|Glob|Grep|WebFetch|WebSearch|NotebookRead)$/.test(n) },
  { id: "other", label: "other", Icon: CircleDot, tint: "#6d5ae0", match: () => true },
] as const;

const bucketOf = (name: string) => BUCKETS.find((b) => b.match(name)) || BUCKETS[BUCKETS.length - 1];

function StepBody({ step }: { step: FlowStep }) {
  const groups = useMemo(() => {
    const m = new Map<string, FlowTool[]>();
    for (const t of step.tools) {
      const b = bucketOf(t.name).id;
      m.set(b, [...(m.get(b) || []), t]);
    }
    return BUCKETS.map((b) => ({ ...b, tools: m.get(b.id) || [] })).filter((b) => b.tools.length);
  }, [step.tools]);

  return (
    <div className="space-y-2 pb-1 pl-6 pr-1 pt-1.5">
      {step.thinking && (
        <div className="border-l border-[#6d5ae0]/40 pl-2.5">
          <p className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-[.12em] text-[#8b7ae8]">
            <Sparkles className="h-2.5 w-2.5" />why
          </p>
          <p className="mt-0.5 line-clamp-4 whitespace-pre-line text-[11px] leading-relaxed text-neutral-400">{step.thinking}</p>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.id}>
          <p className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-[.12em]" style={{ color: g.tint }}>
            <g.Icon className="h-2.5 w-2.5" />{g.label} · {g.tools.length}
          </p>
          <ul className="mt-0.5 space-y-0.5">
            {g.tools.map((t, i) => {
              const ok = t.done === false ? null : t.ok !== false;
              return (
                <li key={t.id || i} className="flex items-center gap-1.5 text-[11px]">
                  <span className="min-w-0 flex-1 truncate font-mono text-neutral-400">{activityLabel(t.name, t.input)}</span>
                  <span className="shrink-0 text-[9px] tabular-nums" style={{ color: ok === null ? "#6b7280" : ok ? "#1f8a5c" : "#c4486a" }}>
                    {ok === null ? "running…" : `${ok ? "✓" : "✗"}${t.ms ? ` ${(t.ms / 1000).toFixed(1)}s` : ""}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {step.files.length > 0 && (
        <div>
          <p className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-[.12em] text-[#c47f18]">
            <FileDiff className="h-2.5 w-2.5" />files · {step.files.length}
          </p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-neutral-400">
            {step.files.slice(0, 4).map((f) => f.split("/").slice(-1)[0]).join(" · ")}
            {step.files.length > 4 ? ` +${step.files.length - 4}` : ""}
          </p>
        </div>
      )}

      {step.agents.map((a, i) => (
        <div key={i}>
          <p className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-[.12em] text-[#1f8a5c]">
            <Users className="h-2.5 w-2.5" />{a.agent}
          </p>
          <p className="mt-0.5 line-clamp-2 text-[11px] text-neutral-400">{a.description}</p>
        </div>
      ))}

      {!step.thinking && !groups.length && !step.files.length && !step.agents.length && (
        <p className="text-[11px] text-neutral-600">Nothing recorded for this step yet.</p>
      )}
    </div>
  );
}

function StepRow({ step, held, open, onToggle }: { step: FlowStep; held: boolean; open: boolean; onToggle: () => void }) {
  const tint = held ? HELD : step.status === "in_progress" ? RUNNING : step.status === "completed" ? "#1f8a5c" : "#4e5665";
  return (
    // Expand in place. The row grows and everything below it moves down — the bento's own motion,
    // which is the whole reason this is DOM and not a canvas.
    <li className={`overflow-hidden rounded-lg border transition-[background-color,border-color] ${
      held ? "border-[#c47f18]/60 bg-[#c47f18]/[0.07]" : open ? "border-white/15 bg-white/[0.03]" : "border-transparent hover:bg-white/[0.02]"}`}>
      <button onClick={onToggle} className="flex w-full items-start gap-1.5 px-1.5 py-1 text-left">
        <ChevronRight className={`mt-[3px] h-3 w-3 shrink-0 text-neutral-600 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tint }} />
        <span className="min-w-0 flex-1">
          <span className={`block text-xs leading-snug ${step.status === "completed" ? "text-neutral-500" : "text-neutral-200"}`}>{step.title}</span>
          {!open && (step.tools.length > 0 || step.files.length > 0) && (
            <span className="mt-0.5 block text-[10px] text-neutral-600">
              {step.tools.length > 0 && `${step.tools.length} action${step.tools.length === 1 ? "" : "s"}`}
              {step.tools.length > 0 && step.files.length > 0 && " · "}
              {step.files.length > 0 && `${step.files.length} file${step.files.length === 1 ? "" : "s"}`}
            </span>
          )}
        </span>
      </button>
      {open && <StepBody step={step} />}
    </li>
  );
}

export function FlowPanel({
  turn, busy, hold, pending, stopping, onSetHold, onRespond, onStop, onClose,
}: {
  /** The current turn, already folded by buildFlow — see the note on FlowStrip for why it's lifted. */
  turn: FlowTurn | undefined;
  busy: boolean;
  hold: boolean;
  pending: PermissionPrompt;
  stopping: boolean;
  onSetHold: (on: boolean) => void;
  onRespond: (decision: "allow" | "deny", message?: string) => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const [showDone, setShowDone] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [steer, setSteer] = useState("");

  const steps = turn?.steps ?? [];
  const running = steps.filter((s) => s.status === "in_progress");
  const done = steps.filter((s) => s.status === "completed");
  const next = steps.filter((s) => s.status === "pending");
  // The held step is whichever is running — the model has no id for a parked tool call.
  const heldKey = pending?.held ? (running[0] || steps[steps.length - 1])?.key ?? null : null;

  const toggle = (k: string) => setOpenKeys((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const isOpen = (s: FlowStep) => openKeys.has(s.key) || s.key === heldKey || (s.status === "in_progress" && !openKeys.size);

  const Group = ({ label, items, expanded, onExpand, tint }: {
    label: string; items: FlowStep[]; expanded: boolean; onExpand: () => void; tint: string;
  }) => {
    if (!items.length) return null;
    return (
      <div>
        <button onClick={onExpand} className="flex w-full items-center gap-1.5 px-1 py-1 text-left">
          <ChevronRight className={`h-3 w-3 shrink-0 text-neutral-600 transition-transform ${expanded ? "rotate-90" : ""}`} />
          <span className="text-[10px] font-medium uppercase tracking-[.1em]" style={{ color: tint }}>{label}</span>
          <span className="text-[10px] tabular-nums text-neutral-600">{items.length}</span>
        </button>
        {expanded && <ul className="space-y-0.5 pl-1">{items.map((s) => <StepRow key={s.key} step={s} held={s.key === heldKey} open={isOpen(s)} onToggle={() => toggle(s.key)} />)}</ul>}
      </div>
    );
  };

  return (
    <div className="mb-2 rounded-xl border border-white/10 bg-white/[0.02]">
      <div className="flex items-center gap-1.5 border-b border-white/[0.07] px-2.5 py-1.5">
        <ListChecks className="h-3 w-3 shrink-0 text-neutral-500" strokeWidth={2.5} />
        <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
          plan · {done.length}/{steps.length}
        </span>
        {turn && !turn.planned && <span className="rounded bg-white/5 px-1 py-0.5 text-[9px] text-neutral-600">grouped for you</span>}
        <span className="flex-1" />
        {/* The brake. Named for what it does to the session, not the state it holds. */}
        <button onClick={() => onSetHold(!hold)}
          title={hold ? "Release — stop parking tool calls" : "Pause after the current step"}
          className={`flex items-center gap-1 rounded-lg border px-1.5 py-0.5 text-[10px] transition-colors ${
            hold ? "border-[#c47f18]/60 bg-[#c47f18]/15 text-[#c47f18]" : "border-white/15 text-neutral-400 hover:text-neutral-200"}`}>
          {hold ? <><Play className="h-2.5 w-2.5" />release</> : <><Pause className="h-2.5 w-2.5" />pause</>}
        </button>
        <button onClick={onClose} title="Collapse" className="rounded-lg p-1 text-neutral-500 transition-colors hover:bg-white/10 hover:text-neutral-200">
          <X className="h-3 w-3" />
        </button>
      </div>

      {pending?.held && (
        // Front and centre, above everything: this is the moment the whole feature exists for.
        <div className="border-b border-[#c47f18]/25 bg-[#c47f18]/[0.07] px-2.5 py-2">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-[#c47f18]">
            <Hand className="h-3 w-3" />Stopped before <span className="font-mono">{pending.toolName}</span>
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-neutral-400">{activityLabel(pending.toolName, pending.input)}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <button onClick={() => onRespond("allow")} className="rounded-lg bg-[#1f8a5c] px-2 py-0.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90">Approve</button>
            <input value={steer} onChange={(e) => setSteer(e.target.value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && steer.trim()) { onRespond("deny", steer.trim()); setSteer(""); } }}
              placeholder="or tell it what to do instead…"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-2 py-0.5 text-[11px] outline-none placeholder:text-neutral-600 focus:border-[#c47f18]/60" />
            <button onClick={onStop} disabled={stopping} className="rounded-lg border border-white/15 px-2 py-0.5 text-[11px] text-neutral-300 transition-colors hover:bg-white/10 disabled:opacity-40">
              {stopping ? "stopping…" : "Abort"}
            </button>
          </div>
        </div>
      )}

      <div className="max-h-[46vh] space-y-0.5 overflow-y-auto px-1.5 py-1.5">
        {!steps.length ? (
          <p className="px-1 py-2 text-[11px] text-neutral-600">{busy ? "Waiting for the first step…" : "No plan for this turn yet."}</p>
        ) : (
          <>
            {/* Running first and always open — it's the answer to "what is it doing", which is the
                question that brought you here. Done and queued collapse to one line each, which is
                what turns a twelve-row wall back into something you can read. */}
            <Group label="running" items={running} expanded onExpand={() => {}} tint="var(--sakura)" />
            <Group label="up next" items={next} expanded={showNext} onExpand={() => setShowNext((v) => !v)} tint="#6b7280" />
            <Group label="done" items={done} expanded={showDone} onExpand={() => setShowDone((v) => !v)} tint="#1f8a5c" />
          </>
        )}
      </div>
    </div>
  );
}

/** The collapsed state: the strip above the composer that is the way in.
 *
 *  It reads the folded turn, not raw `TodoWrite` input, and that is the whole point of this revision.
 *  lib/flow-model.ts deliberately understands THREE plan tools — TodoWrite, TaskCreate, TaskUpdate —
 *  because Claude reaches for TaskCreate on its own; and where there is no plan at all it synthesizes
 *  steps from the tool calls. The strip used to look only at TodoWrite, so a turn tracked with
 *  TaskCreate built a perfectly good flow with **no door to it**, and an unplanned turn had none
 *  either. Same class of bug as v1's hidden gear: the feature existed and could not be reached.
 *
 *  It also stays put while a turn is running but has produced no steps yet, so the control lives in
 *  one place your eye can learn rather than appearing and vanishing mid-turn.
 */
export function FlowStrip({ turn, busy, onOpen }: { turn: FlowTurn | undefined; busy: boolean; onOpen: () => void }) {
  const steps = turn?.steps ?? [];
  if (!steps.length && !busy) return null;

  const done = steps.filter((s) => s.status === "completed").length;
  const now = steps.find((s) => s.status === "in_progress");
  const planned = !!turn?.planned;
  const actions = steps.reduce((n, s) => n + s.tools.length, 0);

  // Says what it actually is. "plan · 3/12" is a claim about a plan Claude wrote; for a turn we
  // grouped ourselves, claiming a plan would be a small lie told every time.
  const label = !steps.length ? "flow" : planned ? `plan · ${done}/${steps.length}` : `flow · ${steps.length} step${steps.length === 1 ? "" : "s"}`;
  const detail = now ? now.title
    : !steps.length ? "starting…"
    : planned && done === steps.length ? "all steps done"
    : actions ? `${actions} action${actions === 1 ? "" : "s"}` : "";

  return (
    <button onClick={onOpen}
      title="Open the flow — review each step, pause and steer"
      className="mb-2 flex w-full items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-left transition-colors hover:border-white/25 hover:bg-white/[0.04]">
      <ListChecks className="h-3 w-3 shrink-0 text-neutral-500" strokeWidth={2.5} />
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-neutral-500">{label}</span>
      <span className={`min-w-0 flex-1 truncate text-xs ${now ? "text-[var(--sakura)]" : "text-neutral-500"}`}>{detail}</span>
      {/* The affordance has to be visible at rest. v1's control only appeared on hover, on a tile, in
          another view — which is the whole reason nobody could find it. */}
      <span className="flex shrink-0 items-center gap-0.5 rounded-md border border-white/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-neutral-500">
        flow <ChevronRight className="h-2.5 w-2.5" />
      </span>
    </button>
  );
}
