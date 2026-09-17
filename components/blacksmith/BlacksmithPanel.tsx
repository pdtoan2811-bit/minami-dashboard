"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, CircleDot, ExternalLink, Hammer, Play } from "lucide-react";
import { startBlacksmith, useBlacksmith } from "@/lib/blacksmith/use-blacksmith";
import type { SmithEvidence } from "@/lib/use-agent";

// The factory strip that sits above a Blacksmith-mode chat.
//
// It exists to answer ONE question the chat itself cannot: is the factory moving? The pane below it
// reports the operator session — the Claude that is driving — and that session can be perfectly idle
// while seven tasks sit in worktrees, or perfectly busy while the factory has not recorded an event
// in an hour. Those are different questions and they used to share one indicator, which is how you
// end up staring at a pane wondering which of the two you are looking at.
//
// Everything here is read-only. Nothing in this component can write to the factory; the chat does
// that, through the real `smith` CLI, where the gates can see it. The one button that DOES something
// — `start`, when the factory UI isn't answering — starts `smith ui serve`, which is itself a
// read-only projector over the event log; it changes whether this strip can see, not what the
// factory holds. See serveBlacksmithUi() in lib/blacksmith/client.ts.

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

/** What the pane knows about ITS OWN operator session — the second question the strip answers, and
 *  the one that used to have no answer at all: the factory can be moving while this pane's session
 *  never got the contract, or got it and never used it. `picked` is the pill (localStorage), `born`
 *  is what the server said the live session started with (null until one exists), `smith` is the
 *  server's evidence — see SmithEvidence in lib/agent/manager.ts. */
export type SmithSession = { picked: boolean; born: boolean | null; smith: SmithEvidence | null; busy: boolean };

const AMBER = "#f0a868";

/** One line about this pane's session, worst news first. Rendered whether or not the factory is up:
 *  "the factory is down" and "this session never got the contract" are independent facts and the
 *  second is the one the pill's colour was silently lying about. */
function SessionRow({ session }: { session: SmithSession }) {
  const { picked, born, smith, busy } = session;
  let tint = "#9ca3af";
  let icon: "warn" | "dot" | "none" = "none";
  let text: string;
  let title: string;
  if (born == null) {
    text = picked ? "operator contract · applies when this chat starts" : "operator contract · off";
    title = "No live session yet. The pill's choice rides in with the first message.";
  } else if (picked !== born) {
    // The model picker's "staged" state. A dot rather than a warning: nothing is wrong, the next
    // send resolves it, and a warning here would train the eye to ignore the real one below.
    tint = "var(--sakura)"; icon = "dot";
    text = picked ? "operator contract · staged — lands on your next message" : "operator contract · leaving on your next message";
    title = "The pill and the live session disagree. Switching restarts the session and resumes this conversation from disk, so nothing is lost — it just hasn't happened yet.";
  } else if (!born) {
    text = "operator contract · off";
    title = "This session was started without Blacksmith mode.";
  } else if (smith && !smith.ready) {
    tint = AMBER; icon = "warn";
    text = `not in effect — ${smith.issue}`;
    title = "The pill is on and the prompt is in, but the server measured that the factory can't be reached from this session. The mode changes nothing until this is fixed; ordinary work is unaffected.";
  } else if (smith && smith.offRole > 0 && smith.offRole >= smith.agents) {
    // Louder than a blind turn and shown even mid-turn: this is factory-shaped work (the session is
    // calling smith around it) that the gates cannot attribute, and every such agent used to run on
    // the dashboard's Opus pin. Only when off-template dispatches are at least half the total —
    // one `Explore` for a read is not a pattern.
    tint = AMBER; icon = "warn";
    text = `${smith.offRole} agent${smith.offRole === 1 ? "" : "s"} dispatched off-template (general-purpose, not a role)${smith.agents ? ` · ${smith.agents} by role` : ""}`;
    title = "Agent calls whose subagent_type was not one of the loaded role templates. A general-purpose agent has no declared model, so it inherits this session's — the Opus pin — and the factory's gates can't attribute its work. Dispatch as Agent(subagent_type: \"coder\" | \"reviewer\" | …) so the template's tier and identity ride with it.";
  } else if (smith?.blindTurn && !busy) {
    tint = AMBER; icon = "warn";
    text = `last turn did work without touching the factory — ${smith.touches ? `${smith.touches} smith call${smith.touches === 1 ? "" : "s"} earlier in this session` : "no smith calls in this session yet"}`;
    title = "The turn that just finished ran commands, edited files or spawned agents, and none of it went through `smith`, `/bs`, a role agent, or the clone. That is the shape of 'Blacksmith is ticked but the work ignored it' — if the turn was meant to drive the factory, say so in the next message.";
  } else if (smith && smith.touches === 0) {
    text = "operator contract · in — no factory calls yet";
    title = `The session has the contract and the roles (${smith.roles.length}) loaded. Nothing has reached the factory yet, which is fine for a turn that only reads or answers.`;
  } else if (smith) {
    tint = "#6cc4a1"; icon = "dot";
    const age = smith.lastAt ? Math.max(0, Date.now() - smith.lastAt) : null;
    text = `in effect · ${smith.touches} factory call${smith.touches === 1 ? "" : "s"}${smith.agents ? ` · ${smith.agents} dispatched` : ""}${smith.offRole ? ` · ${smith.offRole} off-template` : ""} · last ${fmtAge(age)}`;
    title = `Tool calls from this session that reached the factory: smith commands, /bs, role-agent dispatches, reads and writes inside the clone. ${smith.agents} of them spawned a worker from a role template.`;
  } else {
    text = "operator contract · in";
    title = "The session was born with Blacksmith mode. Evidence arrives with its first turn.";
  }
  return (
    <div className="flex items-center gap-1.5 border-t px-2.5 py-1 text-[10px]" style={{ borderColor: SMITH_TINT + "25", color: tint }} title={title}>
      {icon === "warn" ? <AlertTriangle className="h-3 w-3 shrink-0" /> : <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: icon === "dot" ? "currentColor" : "transparent" }} />}
      <span className="min-w-0 truncate">this pane · {text}</span>
    </div>
  );
}

export function BlacksmithPanel({ compact, session }: { compact?: boolean; session?: SmithSession }) {
  const s = useBlacksmith();
  const [open, setOpen] = useState(false);
  // The start button's own state. `starting` covers the ~1-8s the server waits for the pulse;
  // `startErr` is the route's reason, shown in the strip itself and cleared by the next attempt or
  // by the factory turning up on its own (an operator may have started it from a terminal meanwhile).
  const [starting, setStarting] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);
  const start = async () => {
    if (starting) return;
    setStarting(true); setStartErr(null);
    const r = await startBlacksmith();
    setStarting(false);
    if (!r.up) setStartErr(r.reason || "didn't start");
  };
  // Local clock so the "last event 3m ago" line keeps counting between polls instead of sitting on a
  // stale number for five seconds at a time — a frozen age reads exactly like a frozen factory.
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  // Before the first poll answers, the session row is still worth a line — it doesn't depend on the
  // factory being reachable, and a strip that shows nothing until `:4680` replies hides the fact the
  // pill was lying about for exactly the seconds you're looking at it.
  if (!s) {
    return session ? <div className="rounded-lg border border-white/10 bg-neutral-900/60 text-[11px]"><SessionRow session={session} /></div> : null;
  }

  // Ages are recomputed against the browser clock rather than trusting the server's snapshot, so they
  // keep counting between polls.
  const quietMs = s.lastEventAt ? Math.max(0, Date.now() - Date.parse(s.lastEventAt)) : null;
  const quiet = quietMs == null || quietMs > QUIET_MS;
  const totalTasks = s.tasks.reduce((a, t) => a + t.count, 0);
  const blocking = s.findings.filter((f) => f.severity.startsWith("S1") || f.severity.startsWith("S2")).reduce((a, f) => a + f.count, 0);

  if (!s.up) {
    return (
      <div className="rounded-lg border border-white/10 bg-neutral-900/60 text-[11px] text-neutral-500">
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <Hammer className="h-3.5 w-3.5 shrink-0 text-neutral-600" />
          {/* The reason used to end in "start it with `smith ui serve`" — an instruction to a person
              in a browser with no terminal in reach. The button is that instruction, done. */}
          <span className="min-w-0 truncate" title={startErr || s.reason}>
            {startErr ? <span className="text-[#f0a868]">didn't start — {startErr}</span> : <>Blacksmith not reachable — {s.reason}</>}
          </span>
          <button onClick={start} disabled={starting}
            title={starting ? "Waiting for the factory UI to answer…" : `Run \`smith ui serve\` from the clone (${s.home}) and wait for ${s.url.replace(/^https?:\/\//, "")} to answer`}
            className="ml-auto flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-60"
            style={{ borderColor: SMITH_TINT + "66", color: SMITH_TINT, background: SMITH_TINT + "14" }}>
            <Play className={`h-3 w-3 ${starting ? "animate-pulse" : ""}`} />{starting ? "starting…" : "start"}
          </button>
        </div>
        {session && <SessionRow session={session} />}
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
          {/* The factory's own dashboard, one click from the headline rather than buried in the
              expander's footer. An <a> inside the headline <button>: stopPropagation so opening it
              doesn't also toggle the expander. */}
          <a href={s.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
            title={`Open the Blacksmith dashboard (${s.url}) in a new tab`}
            className="flex items-center gap-0.5 rounded-md border border-white/10 px-1.5 py-px text-[10px] text-neutral-400 transition-colors hover:border-white/20 hover:text-neutral-200">
            <ExternalLink className="h-2.5 w-2.5" />open
          </a>
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
      {/* Always below the factory line, never folded into the expander: the factory moving and this
          pane's session being blind are separate facts, and the second is the one that answers
          "is the mode doing anything". */}
      {session && <SessionRow session={session} />}
    </div>
  );
}
