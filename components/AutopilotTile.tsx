"use client";
// The Autopilot tile — the answer to "did something just happen without me asking?"
//
// Autopilot could already merge, resolve and deploy on its own, and it recorded every one of those in
// the event log. But the only surfaces for it were a Settings panel you had to go looking for and a
// bell that mixes it in with everything else. So the feature's whole promise — *you don't have to ask
// for this any more* — was invisible from the screen the user actually lives on. Work landing silently
// is indistinguishable from work not happening; for a non-technical user it's worse, because the one
// thing they can't do is go and check git.
//
// Hence a tile, in the grid, next to the projects. Not a status line in a corner: it sits where the
// user's attention already is, and it is sized and shaped like the other things they click.
//
// It answers four questions, in this order, because that's the order they get asked:
//   1. Is this on?              — the state pill, and a switch right here if it isn't
//   2. Is it doing something?   — merging / resolving / deploying, live
//   3. What did it just do?     — the last completed action, in plain words, with a time
//   4. Does it need me?         — blocked work, in amber, never hidden behind a click
//
// Everything else (the full log of what it has done) is one click away rather than on the tile,
// because a tile that tries to be a feed stops being scannable.
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, GitMerge, Loader2, Rocket, TriangleAlert, X } from "lucide-react";
import type { MinamiEvent } from "@/lib/use-events";

type Cfg = { enabled: boolean; merge: boolean; deploy: boolean; resolve: boolean; settleMs: number; everyMs: number };
type Task = { name: string; ahead: string; dirty: boolean; live: boolean | null; lastCommitTs: number };
type Status = {
  config: Cfg;
  inMainCheckout: boolean;
  base: { branch: string; dirty: boolean; merging: boolean } | null;
  tasks: Task[];
  blocked: Record<string, string>;
  claim: { task: string; startedAt: number } | null;
  deploying: boolean;
  lastTickAt: number;
};

const ago = (ts: number) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/** The event log speaks in engineer ("Autopilot merged idle-unpin"). The tile speaks in outcomes. */
function plain(ev: MinamiEvent): { icon: typeof Check; tint: string; text: string } {
  const t = ev.title;
  const task = t.match(/—\s*(.+)$/)?.[1] || t.replace(/^Autopilot merged\s*/i, "");
  if (/resolved a conflict and merged/i.test(t)) return { icon: GitMerge, tint: "#4ade80", text: `Sorted out an overlap in ${task} and combined it in` };
  if (/^Autopilot merged/i.test(t)) return { icon: GitMerge, tint: "#4ade80", text: `Combined ${task} into the main copy` };
  if (/is resolving a conflict/i.test(t)) return { icon: Loader2, tint: "#f0a868", text: `Sorting out an overlap in ${task}` };
  if (/^Needs you/i.test(t)) return { icon: TriangleAlert, tint: "#f0a868", text: `${task} needs you — it overlaps with other work` };
  if (/recovered a half-finished merge/i.test(t)) return { icon: TriangleAlert, tint: "#f0a868", text: `Rolled back an unfinished merge in ${task}` };
  if (ev.kind === "deploy") return { icon: Rocket, tint: "#6c9cf5", text: ev.level === "success" ? "Put the latest version live" : t };
  return { icon: ev.level === "error" ? TriangleAlert : Check, tint: ev.level === "error" ? "#ef7c7c" : "#9ca3af", text: t };
}

export default function AutopilotTile({ className = "" }: { className?: string }) {
  const [s, setS] = useState<Status | null>(null);
  const [events, setEvents] = useState<MinamiEvent[]>([]);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Reads the event log itself rather than sharing the bell's `useEvents()`. That hook owns two
  // localStorage cursors and fires the away-tab toasts; a second instance of it would double-notify
  // every deploy. This one is read-only and stateless — the cost is one more poll of a small local
  // file, which is the cheaper of the two mistakes by a wide margin.
  const load = useCallback(async () => {
    try { setS(await (await fetch("/api/autopilot", { cache: "no-store" })).json()); } catch { /* offline is not an error here */ }
    try {
      const d = await (await fetch("/api/events?limit=50", { cache: "no-store" })).json();
      if (Array.isArray(d?.events)) setEvents(d.events);
    } catch { /* same */ }
  }, []);
  useEffect(() => {
    load();
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  }, [load]);

  // Its own work, newest first. Deploys count: "put it live" is half of what was promised, and the
  // user has no way to tell an autopilot deploy from a hand-driven one — nor any reason to care.
  // Actions only. The runner also emits standing-state notices ("waiting — uncommitted changes in the
  // main checkout") once per process start, and with restarts through the day those pile up: a log
  // titled "what it has done" filled with ten copies of what it did NOT do buries the one line the
  // user opened it for. Those still reach the bell, which is the right home for "FYI, blocked".
  const mine = useMemo(
    () => events
      .filter((e) => (e.kind === "autopilot" || e.kind === "deploy") && !/is waiting/i.test(e.title))
      .sort((a, b) => b.ts - a.ts),
    [events],
  );
  const last = mine.find((e) => e.level === "success");

  const on = !!s?.config.enabled;
  const blockedNames = Object.keys(s?.blocked || {});
  const working = !!s?.claim || !!s?.deploying;
  const waiting = (s?.tasks || []).filter((t) => !t.dirty && Number(t.ahead) > 0);

  const toggle = async (v: boolean) => {
    setSaving(true);
    setS((p) => (p ? { ...p, config: { ...p.config, enabled: v } } : p)); // optimistic — a switch must feel instant
    try {
      const d = await (await fetch("/api/autopilot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: v }) })).json();
      if (d?.config) setS((p) => (p ? { ...p, config: d.config } : p));
    } catch { load(); } finally { setSaving(false); }
  };

  // What it is doing, right now, in one line. Ordered by urgency, not by chronology.
  const state = !s ? { dot: "#525252", text: "Checking…" }
    : !s.inMainCheckout ? { dot: "#525252", text: "Standing by — preview workspace" }
    : blockedNames.length ? { dot: "#f0a868", text: `Needs you · ${blockedNames.join(", ")}` }
    : s.deploying ? { dot: "#6c9cf5", text: "Putting it live…" }
    : s.claim ? { dot: "#4ade80", text: `Combining ${s.claim.task}…` }
    : !on ? { dot: "#525252", text: "Off — nothing happens automatically" }
    : waiting.length ? { dot: "#4ade80", text: `${waiting.length} piece${waiting.length === 1 ? "" : "s"} of work ready` }
    : { dot: "#4ade80", text: "Watching for finished work" };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="What Autopilot has been doing"
        // Deliberately NOT a project tile: no 3D icon, no request counts, a flatter surface and a
        // machine glyph. It sits in the same grid because that's where you look, but it must never be
        // mistaken for a folder you can open.
        className={`group relative flex flex-col overflow-hidden rounded-[1.4rem] border p-4 text-left backdrop-blur transition-colors ${className} ${
          blockedNames.length ? "border-[#f0a868]/50 bg-[#f0a868]/[0.06]"
          : on ? "border-[var(--sakura)]/35 bg-[var(--sakura)]/[0.05] hover:border-[var(--sakura)]/60"
          : "border-white/10 bg-white/[0.02] hover:border-white/25"}`}
      >
        <div className="flex items-start justify-between gap-2">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${on ? "border-[var(--sakura)]/40 bg-[var(--sakura)]/15 text-[var(--sakura)]" : "border-white/10 bg-white/5 text-neutral-500"}`}>
            <Bot className="h-4.5 w-4.5" strokeWidth={2} />
          </span>
          {/* The switch lives ON the tile. Making a nervous user hunt through Settings to turn this
              off is exactly the wrong shape for the one control they may need in a hurry. */}
          <span
            role="switch" aria-checked={on} aria-label="Autopilot"
            onClick={(e) => { e.stopPropagation(); if (!saving && s) toggle(!on); }}
            className={`relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${on ? "bg-[var(--sakura)]" : "bg-white/15"} ${saving ? "opacity-50" : ""}`}
          >
            <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${on ? "translate-x-4" : "translate-x-0"}`} />
          </span>
        </div>

        <p className="relative mt-1.5 text-sm font-semibold tracking-tight">Autopilot</p>

        <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-neutral-400">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${working || (on && !blockedNames.length) ? "animate-pulse" : ""}`} style={{ background: state.dot }} />
          <span className="min-w-0 truncate">{state.text}</span>
        </p>

        {/* The payoff line: the most recent thing it did FOR you. Nothing else on this tile earns its
            space as directly — this is the sentence that says the promise was kept. */}
        <div className="relative mt-auto min-w-0">
          {last ? (() => { const p = plain(last); const I = p.icon; return (
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-neutral-500">
              <I className="mt-[1px] h-3 w-3 shrink-0" style={{ color: p.tint }} />
              <span className="min-w-0"><span className="text-neutral-300">{p.text}</span> · {ago(last.ts)}</span>
            </p>
          ); })() : (
            <p className="text-[11px] leading-snug text-neutral-600">
              {on ? "Nothing done yet — it'll show up here." : "Turn it on and finished work gets combined and put live for you."}
            </p>
          )}
        </div>
      </button>

      {open && mounted && createPortal(
        // Portalled to <body>: `fixed inset-0` is only viewport-relative when no ancestor establishes a
        // containing block, and this tile sits inside a `backdrop-blur` wrapper. Same trap the lightbox
        // hit — see docs/KNOWLEDGE.md §5b.
        // `text-neutral-100` is not decoration: the app's text colour is set on the shell div in
        // app/page.tsx, and a portal to <body> inherits from body instead — which has no colour of its
        // own, so every unstyled string in here rendered near-black on a near-black panel. Same shape
        // of trap as the lightbox's `fixed inset-0` containing-block bug (§5b), different property.
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-6 text-neutral-100 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/10 bg-neutral-900/95 shadow-2xl">
            <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-3">
              <Bot className="h-4 w-4 text-[var(--sakura)]" />
              <p className="flex-1 text-sm font-semibold">What Autopilot has done</p>
              <button onClick={() => setOpen(false)} className="rounded-lg p-1 text-neutral-500 transition-colors hover:bg-white/10 hover:text-neutral-200"><X className="h-4 w-4" /></button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {mine.length === 0 ? (
                <p className="py-6 text-center text-xs text-neutral-500">Nothing yet. When Autopilot combines finished work or puts a version live, it appears here.</p>
              ) : (
                <ol className="space-y-2.5">
                  {mine.map((e) => { const p = plain(e); const I = p.icon; return (
                    <li key={e.id} className="flex items-start gap-2.5">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border" style={{ borderColor: p.tint + "55", background: p.tint + "1a" }}>
                        <I className="h-3 w-3" style={{ color: p.tint }} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs text-neutral-200">{p.text}</span>
                        {/* Bodies, but only the ones written for a human. Autopilot's own read like
                            sentences ("Built clean and merged into browser-panel-v2"); a successful
                            deploy's is a verification dump — pids, BUILD_IDs, a table of status codes —
                            which is the exact register this tile exists to keep off the screen. A
                            FAILED deploy's body does explain itself, so that one stays. */}
                        {e.body && (e.kind === "autopilot" || e.level !== "success") && (
                          <span className="mt-0.5 line-clamp-3 block whitespace-pre-wrap text-[11px] leading-relaxed text-neutral-500">{e.body}</span>
                        )}
                      </span>
                      <span className="shrink-0 text-[10px] tabular-nums text-neutral-600">{ago(e.ts)}</span>
                    </li>
                  ); })}
                </ol>
              )}
            </div>

            <div className="shrink-0 border-t border-white/10 px-4 py-2.5 text-[11px] text-neutral-500">
              {on ? `On · checks every ${Math.round((s?.config.everyMs ?? 45_000) / 1000)}s. Fine-tune what it may do in Settings.` : "Off. Flip the switch on the tile, or fine-tune it in Settings."}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
