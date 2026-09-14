"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, CircleDot, Hammer } from "lucide-react";
import { useBlacksmith } from "@/lib/blacksmith/use-blacksmith";

// The factory strip that sits above a Blacksmith-mode chat.
//
// It exists to answer ONE question the chat itself cannot: is the factory moving? The pane below it
// reports the operator session — the Claude that is driving — and that session can be perfectly idle
// while seven tasks sit in worktrees, or perfectly busy while the factory has not recorded an event
// in an hour. Those are different questions and they used to share one indicator, which is how you
// end up staring at a pane wondering which of the two you are looking at.
//
// Everything here is read-only. Nothing in this component can write to the factory; the chat does
// that, through the real `smith` CLI, where the gates can see it.

export const SMITH_TINT = "#e06c4f";

/** Ages, in the vocabulary an operator thinks in. Deliberately coarse past a minute: the difference
 *  between 4m and 5m never changes a decision, and a precise number invites reading it as progress. */
function fmtAge(ms: number | null): string {
  if (ms == null) return "never";
  const s = Math.round(ms / 1000);
  if (s < 45) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m ago` : `${Math.floor(h / 24)}d ago`;
}

const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Blacksmith's severity ids are `S1-stop-the-line` … `S4-nit`; show the rank, keep the meaning in the
 *  tooltip. S1/S2 are the ones that block a gate. */
const SEV_TINT: Record<string, string> = { S1: "#ef4444", S2: "#f0a868", S3: "#9ca3af", S4: "#6b7280" };

// How quiet is too quiet. Not a claim that anything is broken — the factory is legitimately idle most
// of the time, because the operator is the scheduler. It flips the headline from "moving" to "quiet"
// so the two states are never rendered identically, which is the whole complaint this answers.
const QUIET_MS = 5 * 60 * 1000;

export function BlacksmithPanel({ compact }: { compact?: boolean }) {
  const s = useBlacksmith();
  const [open, setOpen] = useState(false);
  // Local clock so the "last event 3m ago" line keeps counting between polls instead of sitting on a
  // stale number for five seconds at a time — a frozen age reads exactly like a frozen factory.
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  if (!s) return null;

  // Ages are recomputed against the browser clock rather than trusting the server's snapshot, so they
  // keep counting between polls.
  const quietMs = s.lastEventAt ? Math.max(0, Date.now() - Date.parse(s.lastEventAt)) : null;
  const quiet = quietMs == null || quietMs > QUIET_MS;
  const totalTasks = s.tasks.reduce((a, t) => a + t.count, 0);
  const blocking = s.findings.filter((f) => f.severity.startsWith("S1") || f.severity.startsWith("S2")).reduce((a, f) => a + f.count, 0);

  if (!s.up) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-neutral-900/60 px-2.5 py-1.5 text-[11px] text-neutral-500">
        <Hammer className="h-3.5 w-3.5 shrink-0 text-neutral-600" />
        <span className="min-w-0 truncate">Blacksmith not reachable — {s.reason}</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-neutral-900/60 text-[11px]" style={{ borderColor: SMITH_TINT + "40" }}>
      {/* The headline. One line, and it must never be ambiguous about the only thing it's for. */}
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <Hammer className="h-3.5 w-3.5 shrink-0" style={{ color: SMITH_TINT }} />
        <span className="shrink-0 font-medium" style={{ color: SMITH_TINT }}>Blacksmith</span>
        {/* "moving" vs "quiet" rather than "running" vs "stopped", because the factory emits no
            session-ended event — the age of the last event is the only evidence there is, and the
            wording says exactly that much and no more. */}
        <span className={`flex shrink-0 items-center gap-1 ${quiet ? "text-neutral-500" : "text-green-400"}`}
          title={quiet
            ? `The factory has recorded no event for ${fmtAge(quietMs)}. That is not a fault — Blacksmith has no scheduler and no dispatch driver, so it only moves when an operator moves it. Blacksmith emits no "session ended" event, so event age is the only liveness evidence that exists.`
            : `Last event ${fmtAge(quietMs)} (${s.lastEventType || "unknown"}). Event age is the only liveness signal Blacksmith offers — it has no "session ended" event.`}>
          <CircleDot className={`h-3 w-3 ${quiet ? "" : "animate-pulse"}`} />
          {quiet ? "quiet" : "moving"} · {fmtAge(quietMs)}
        </span>
        {!!s.epicsInFlight.length && <span className="min-w-0 truncate text-neutral-500">{s.epicsInFlight.join(", ")}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {/* A dispatched agent with no terminal event. Split from the live count on purpose — in a
              hand-driven factory an un-closed judge turn looks identical to a working one forever. */}
          {!!s.staleAgents.length && (
            <span className="flex items-center gap-1 text-[#f0a868]"
              title={`${s.staleAgents.length} agent dispatch${s.staleAgents.length === 1 ? " has" : "es have"} no terminal event and ${s.staleAgents.length === 1 ? "is" : "are"} older than 90 minutes. Almost always a \`smith judge report\` that was never run, not an agent still working — Blacksmith counts these as live forever.`}>
              <AlertTriangle className="h-3 w-3" />{s.staleAgents.length} stale
            </span>
          )}
          {!!(s.agents.length - s.staleAgents.length) && <span className="text-neutral-400">{s.agents.length - s.staleAgents.length} dispatched</span>}
          {!!blocking && <span style={{ color: SEV_TINT.S1 }} title="tasks carrying an open S1/S2 finding — these block their gate">{blocking} blocking</span>}
          {open ? <ChevronDown className="h-3 w-3 text-neutral-600" /> : <ChevronRight className="h-3 w-3 text-neutral-600" />}
        </span>
      </button>

      {open && !compact && (
        <div className="space-y-2 border-t px-2.5 py-2" style={{ borderColor: SMITH_TINT + "25" }}>
          {/* Task status histogram — Blacksmith's own closed vocabulary, not re-labelled. */}
          {!!totalTasks && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-neutral-600">tasks</span>
              {s.tasks.map((t) => (
                <span key={t.status} className="rounded border border-white/10 px-1 py-px font-mono text-[9px] text-neutral-400">
                  {t.count} {t.status}
                </span>
              ))}
            </div>
          )}
          {!!s.findings.length && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-neutral-600">open findings</span>
              {s.findings.map((f) => {
                const rank = f.severity.slice(0, 2);
                return (
                  <span key={f.severity} className="rounded border px-1 py-px font-mono text-[9px]" title={f.severity}
                    style={{ borderColor: (SEV_TINT[rank] || "#6b7280") + "55", color: SEV_TINT[rank] || "#6b7280" }}>
                    {f.count} {rank}
                  </span>
                );
              })}
            </div>
          )}
          {/* Per-epic token spend. `budget` is null where no wave has been admitted yet — rendered as
              a bare number rather than "x / 0", which would read as being over budget. */}
          {!!s.tokens.length && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-neutral-600">tokens</span>
              {s.tokens.map((t) => (
                <span key={t.epicId} className="font-mono text-[9px] text-neutral-400" title={t.epicId}>
                  {t.epicId.length > 22 ? t.epicId.slice(0, 21) + "…" : t.epicId} {fmtTokens(t.spent)}{t.budget ? ` / ${fmtTokens(t.budget)}` : ""}
                </span>
              ))}
            </div>
          )}
          {/* Per-session event age. The sessions are epics; this is where "which one has gone quiet"
              gets answered, which the single headline age deliberately does not try to. */}
          {!!s.sessions.length && (
            <div className="space-y-0.5">
              {s.sessions.slice(0, 4).map((sess) => {
                const age = sess.lastEventAt ? Math.max(0, Date.now() - Date.parse(sess.lastEventAt)) : null;
                return (
                  <div key={sess.sessionId} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-neutral-500">{sess.sessionId}</span>
                    <span className="shrink-0 font-mono text-[9px] text-neutral-600">{sess.lastEventType}</span>
                    <span className={`shrink-0 font-mono text-[9px] ${age != null && age < QUIET_MS ? "text-green-500/70" : "text-neutral-600"}`}>{fmtAge(age)}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-2 pt-0.5 text-[9px] text-neutral-600">
            <span>{s.counts.events} events</span>
            {!!s.counts.errors && <span className="text-[#ef7c7c]">{s.counts.errors} errors</span>}
            {!!s.alerts.escalations && <span className="text-[#f0a868]">{s.alerts.escalations} escalations</span>}
            {!!s.alerts.pendingWaivers && <span>{s.alerts.pendingWaivers} waivers pending</span>}
            {!!s.lessonsPending && <span>{s.lessonsPending} lessons pending</span>}
            <a href={s.url} target="_blank" rel="noreferrer" className="ml-auto hover:text-neutral-400">{s.url.replace(/^https?:\/\//, "")} ↗</a>
          </div>
        </div>
      )}
    </div>
  );
}
