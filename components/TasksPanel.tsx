"use client";
// The tasks panel — every subagent and backgrounded command a session has, as cards, docked beside
// the chat in the same slot the browser and file panels share.
//
// Modelled on Claude Desktop's "Background tasks" panel, because that panel answers the question the
// inline AgentBoard could not: not "is something running" but "WHICH things, on WHAT model, spending
// HOW MUCH, doing WHAT right now, and what did the ones that finished actually do". The board is a
// glance; this is the ledger. Both stay — the board lives in the transcript where the eye already is,
// and this is where you go when the board's one line isn't enough.
//
// Two things here are new to the dashboard, not just re-laid-out:
//   · a per-task ■ — the SDK's stopTask(), which ends one agent and leaves the turn running. The
//     pane's Stop button interrupts the whole query and kills every task with it.
//   · "View transcript" — reads the subagent's OWN transcript from the `subagents/` sidecar, live or
//     finished. Until 2026-09-14 the read pipeline never opened that directory, so a fan-out's work
//     was invisible after the turn ended except for the Task tool's capped result.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronRight, ListChecks, PanelBottom, PanelRight, Square, SquareTerminal, Trash2, Workflow, X } from "lucide-react";
import Markdown from "@/components/Markdown";
import { activityLabel } from "@/lib/agent/labels";
import type { FinishedTask, LiveTask, TaskKind } from "@/lib/agent/labels";
import type { Turn } from "@/lib/claude-sessions";

const fmtElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
/** "claude-sonnet-5" → "Sonnet 5". The catalog label where the id is in it; a readable guess otherwise,
 *  because a subagent can be on a model the picker doesn't offer. */
const fmtModel = (id?: string) => {
  if (!id) return null;
  const m = id.match(/claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/);
  if (!m) return id;
  const fam = m[1][0].toUpperCase() + m[1].slice(1);
  return `${fam} ${m[2]}${m[3] ? "." + m[3] : ""}`;
};

const KIND: Record<TaskKind, { label: string; Icon: typeof Bot; tint: string }> = {
  agent: { label: "Agent", Icon: Bot, tint: "#b98cff" },
  bash: { label: "Bash", Icon: SquareTerminal, tint: "#e8859b" },
  workflow: { label: "Workflow", Icon: Workflow, tint: "#6cc4a1" },
  mcp: { label: "MCP", Icon: ListChecks, tint: "#5ec8f8" },
  other: { label: "Task", Icon: ListChecks, tint: "#9ca3af" },
};
const STATUS: Record<FinishedTask["status"], { glyph: string; tint: string; word: string }> = {
  completed: { glyph: "✓", tint: "#4ade80", word: "completed" },
  failed: { glyph: "✗", tint: "#ef7c7c", word: "failed" },
  stopped: { glyph: "⏹", tint: "#9ca3af", word: "stopped" },
};

export default function TasksPanel({ running, finished, sessionId, stacked, onStop, onClearFinished, onClose, onToggleLayout }: {
  running: LiveTask[];
  finished: FinishedTask[];
  sessionId: string | null;
  stacked: boolean;
  onStop: (taskId: string) => Promise<{ ok: boolean; reason?: string }>;
  onClearFinished: () => void;
  onClose?: () => void;
  onToggleLayout?: () => void;
}) {
  // One 1s tick for every running card's clock. Only while something is running — an idle panel
  // showing a Finished list does no work.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running.length) return;
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [running.length]);
  const [showFinished, setShowFinished] = useState(false);

  return (
    <div className="@container flex min-h-0 flex-1 flex-col overflow-hidden border-l border-white/10 bg-neutral-900/60">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-2.5 py-1.5">
        <Bot className="h-3.5 w-3.5 shrink-0 text-neutral-500" />
        <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-300">
          Background tasks
          {running.length > 0 && <span className="ml-1.5 text-[9.5px] tabular-nums text-neutral-500">{running.length} running</span>}
        </span>
        {onToggleLayout && <button onClick={onToggleLayout} title={stacked ? "Dock to the side" : "Dock below"}
          className="shrink-0 rounded-md p-1 text-neutral-500 transition-colors hover:text-neutral-200">{stacked ? <PanelRight className="h-3 w-3" /> : <PanelBottom className="h-3 w-3" />}</button>}
        {onClose && <button onClick={onClose} title="Hide the tasks panel"
          className="shrink-0 rounded-md p-1 text-neutral-500 transition-colors hover:text-neutral-200"><X className="h-3 w-3" /></button>}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
        <div className="mb-1.5 px-1 text-[10px] uppercase tracking-[.12em] text-neutral-600">Running</div>
        {running.length === 0
          ? <p className="px-1 pb-3 text-[11px] text-neutral-600">Nothing in the background. Subagents and backgrounded commands appear here while they run.</p>
          : <div className="space-y-1.5">{running.map((t) => <TaskCard key={t.taskId} task={t} sessionId={sessionId} onStop={onStop} />)}</div>}

        {finished.length > 0 && (
          <div className="mt-3">
            <div className="flex items-center px-1">
              <button onClick={() => setShowFinished((v) => !v)} className="flex items-center gap-1 text-[10px] uppercase tracking-[.12em] text-neutral-600 transition-colors hover:text-neutral-400">
                Finished <span className="tabular-nums">{finished.length}</span>
                {showFinished ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              </button>
              <button onClick={onClearFinished} title="Clear the finished list" className="ml-auto rounded-md p-1 text-neutral-600 transition-colors hover:text-neutral-300"><Trash2 className="h-3 w-3" /></button>
            </div>
            {showFinished && <div className="mt-1.5 space-y-1.5">{finished.map((t) => <TaskCard key={t.taskId + t.endedAt} task={t} sessionId={sessionId} />)}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// Not memoized on purpose: the running clock is `Date.now() - since`, driven by the panel's 1s tick,
// and a memo would freeze it — the task prop's identity doesn't change between ticks.
function TaskCard({ task: t, sessionId, onStop }: {
  task: LiveTask | FinishedTask;
  sessionId: string | null;
  onStop?: (taskId: string) => Promise<{ ok: boolean; reason?: string }>;
}) {
  const done = "status" in t ? (t as FinishedTask) : null;
  const kind = KIND[t.kind || "other"];
  // Elapsed: the SDK's own duration once finished; our clock from `since` while running; nothing for
  // an adopted background task whose true start we never saw — a fabricated number would be a lie.
  const elapsed = done ? (done.ms ?? (t.since ? done.endedAt - t.since : undefined)) : (t.since ? Date.now() - t.since : undefined);
  const [stopping, setStopping] = useState(false);
  const [stopErr, setStopErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const canTranscript = t.kind === "agent" && !!sessionId;
  const stop = useCallback(async () => {
    if (!onStop || stopping) return;
    setStopping(true); setStopErr(null);
    const r = await onStop(t.taskId);
    if (!r.ok) { setStopErr(r.reason || "couldn't stop"); setStopping(false); }
    // On success we stay in `stopping` until the card leaves the Running list on its `stopped` notification.
  }, [onStop, stopping, t.taskId]);

  // What it's doing right now: the SDK's summary outranks the last tool, per its own docs.
  const step = t.summary || t.lastTool || null;

  return (
    <div className={`rounded-lg border px-2.5 py-2 ${done ? "border-white/[0.06] opacity-70" : "border-white/10 bg-white/[0.03]"}`}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1.5">
            {done && <span className="shrink-0 text-[11px]" style={{ color: STATUS[done.status].tint }} title={STATUS[done.status].word}>{STATUS[done.status].glyph}</span>}
            <span className="min-w-0 text-[12px] leading-snug text-neutral-200" title={t.description}>{t.description}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px]">
            <span className="flex items-center gap-1" style={{ color: kind.tint }}><kind.Icon className="h-3 w-3" />{kind.label}{t.agent && t.kind === "agent" && t.agent !== "general-purpose" ? ` · ${t.agent}` : ""}</span>
            {elapsed != null && <span className="font-mono tabular-nums text-neutral-500">{fmtElapsed(elapsed)}</span>}
            {t.backgrounded && !done && <span className="text-neutral-600" title="Running in the background — the turn isn't waiting on it">bg</span>}
            {t.depth && t.depth > 1 ? <span className="text-neutral-600" title={`Spawned ${t.depth - 1} level${t.depth > 2 ? "s" : ""} deep`}>↳{t.depth}</span> : null}
          </div>
          {(t.model || t.tokens != null || t.toolUses != null) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-neutral-400">
              {t.model && <span>{fmtModel(t.model)}</span>}
              {t.tokens != null && <span><span className="tabular-nums">{fmtTokens(t.tokens)}</span> <span className="text-neutral-600">tokens</span></span>}
              {t.toolUses != null && <span><span className="tabular-nums">{t.toolUses}</span> <span className="text-neutral-600">tool use{t.toolUses === 1 ? "" : "s"}</span></span>}
            </div>
          )}
          {(step || canTranscript) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px]">
              {step && !done && <span className="min-w-0 truncate text-neutral-400" title={step}>{step}</span>}
              {done?.result && <span className="min-w-0 truncate text-neutral-500" title={done.result}>{done.result}</span>}
              {canTranscript && <button onClick={() => setOpen((v) => !v)} className="shrink-0 text-[#6c9cf5] transition-colors hover:text-[#8fb3ff]">{open ? "Hide transcript" : "View transcript"}</button>}
            </div>
          )}
          {stopErr && <div className="mt-0.5 text-[10px] text-[#ef7c7c]">{stopErr}</div>}
        </div>
        {!done && onStop && (
          <button onClick={stop} disabled={stopping} title={stopping ? "Stopping…" : "Stop this task (the turn keeps running)"}
            className="shrink-0 rounded-md border border-white/10 p-1 text-neutral-500 transition-colors hover:border-[#ef7c7c]/50 hover:text-[#ef7c7c] disabled:opacity-40">
            <Square className={`h-3 w-3 ${stopping ? "animate-pulse" : ""}`} fill="currentColor" />
          </button>
        )}
      </div>
      {open && canTranscript && <SubagentTranscript sessionId={sessionId!} taskId={t.taskId} toolUseId={t.toolUseId} live={!done} />}
    </div>
  );
}

/** The subagent's own transcript, fetched on open and re-fetched every few seconds while it runs.
 *  Compact on purpose — tool calls as one line each, text as markdown — because it sits inside a card
 *  inside a side panel; the point is to see what the agent is doing, not to read it like a chat. */
function SubagentTranscript({ sessionId, taskId, toolUseId, live }: { sessionId: string; taskId: string; toolUseId?: string; live: boolean }) {
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => fetch(`/api/agent/task/transcript?sessionId=${encodeURIComponent(sessionId)}&taskId=${encodeURIComponent(taskId)}${toolUseId ? `&toolUseId=${encodeURIComponent(toolUseId)}` : ""}`)
      .then((r) => r.json())
      .then((d) => { if (!alive) return; if (d?.error) { setErr(d.error); return; } setErr(null); setTurns(d.turns || []); setModel(d.model || null); setTruncated(!!d.truncated); })
      .catch((e) => { if (alive) setErr(String(e?.message || e)); });
    load();
    // Live agents append continuously; 4s keeps the view honest without hammering a file that can be
    // a megabyte and growing.
    const h = live ? setInterval(load, 4000) : null;
    return () => { alive = false; if (h) clearInterval(h); };
  }, [sessionId, taskId, toolUseId, live]);

  const body = useMemo(() => {
    if (err) return <p className="text-[10.5px] text-neutral-500">{err}</p>;
    if (!turns) return <p className="text-[10.5px] text-neutral-600">loading…</p>;
    if (!turns.length) return <p className="text-[10.5px] text-neutral-600">no rows yet</p>;
    return turns.map((t, i) => (
      <div key={i} className={`text-[11px] ${t.role === "user" ? "text-neutral-500" : "text-neutral-300"}`}>
        {i === 0 && t.role === "user"
          // The first user turn is the brief the parent wrote — usually long. Collapsed to one line.
          ? <details><summary className="cursor-pointer text-[10px] uppercase tracking-wide text-neutral-600">brief</summary><div className="mt-1 whitespace-pre-wrap text-[10.5px] text-neutral-400">{t.text}</div></details>
          : t.text.trim() && <Markdown text={t.text} />}
        {t.tools.map((c, j) => (
          <div key={j} className="flex items-center gap-1.5 truncate font-mono text-[10px] text-neutral-500" title={JSON.stringify(c.input).slice(0, 400)}>
            <span className="text-neutral-600">{c.ok === false ? "✗" : "›"}</span><span className="text-neutral-400">{c.name}</span><span className="truncate">{activityLabel(c.name, c.input)}</span>
          </div>
        ))}
      </div>
    ));
  }, [turns, err]);

  return (
    <div className="mt-2 max-h-72 space-y-1.5 overflow-auto rounded-md border border-white/[0.06] bg-black/30 p-2">
      {model && <div className="text-[9.5px] text-neutral-600">{fmtModel(model)}{truncated ? " · showing the first 400 turns" : ""}</div>}
      {body}
    </div>
  );
}
