"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { onPageVisible, pageHidden } from "@/lib/page-visible";
import { useBuildRefresh } from "@/lib/use-build-refresh";

// /glance — the Galaxy Z Flip 7 Flex Window (~360×400 CSS px, read at arm's length). §23.
//
// What it is NOT is as deliberate as what it is: no transcript, no composer, no approve buttons. A
// 360×400 screen can't show enough of a command to approve it safely, and a half-read "Bash · rm -rf
// /Users/thom…" with an Allow button under it is worse than no button. The cover screen answers "does
// anything need me, and how long has it waited?", and offers the one action that is safe blind: pause.
// Everything else is a tap through to the main screen.

type Need = { id: string; kind: "question" | "plan" | "held" | "permission"; tool: string; summary: string; expiresAt?: number; since?: number };
type Tile = {
  phase: string; label: string; busy: boolean; cwd: string; turnStartedAt: number | null;
  need?: Need; needs?: number; ended?: { at: number; ok: boolean }; hold?: boolean;
};
type Activity = Record<string, Tile>;

const POLL_MS = 5000;
const DONE_WINDOW_MS = 30 * 60_000; // "done" = finished OK within the last half hour
const MAX_LINES = 3;
const RESUME_CONFIRM_MS = 4000;

/** "6m", "1h", "now" — the wait, at a size and precision you can take in at a glance. */
function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** The decision in a handful of words. need.summary is up to 200 chars ("Bash · git push origin …");
 *  the cover screen has room for one line, and the full text is one tap away on the main screen. */
function gist(s: string, words = 6): string {
  const w = s.replace(/\s+/g, " ").trim().split(" ");
  return w.length <= words ? w.join(" ") : w.slice(0, words).join(" ") + "…";
}

const folderOf = (cwd: string) => cwd.split("/").filter(Boolean).pop() || cwd;

// Status is carried by SHAPE and MOTION, never colour alone — the screen is small, outdoors, and read
// at a glance. Still solid ring = needs you. Dashed ring that turns = running. Two bars = held.
// Under prefers-reduced-motion the dashed ring stops turning, and the dash still tells it apart.
function Glyph({ kind }: { kind: "need" | "run" | "held" | "done" }) {
  const base = "inline-block h-5 w-5 shrink-0 rounded-full";
  if (kind === "need") return <span aria-label="needs you" className={`${base} border-[3px] border-amber-300`} />;
  if (kind === "run") return <span aria-label="running" className={`${base} border-[3px] border-dashed border-sky-300 animate-[spin_2.4s_linear_infinite] motion-reduce:animate-none`} />;
  if (kind === "held") return (
    <span aria-label="paused" className="inline-flex h-5 w-5 shrink-0 items-center justify-center gap-[3px]">
      <span className="h-4 w-[5px] rounded-sm bg-violet-300" /><span className="h-4 w-[5px] rounded-sm bg-violet-300" />
    </span>
  );
  return <span aria-label="done" className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[18px] font-bold leading-none text-emerald-300">✓</span>;
}

// Count at 20px, its word at 16px: the number is what's read from arm's length, the word is what makes
// the strip self-explanatory the first time. A zero dims rather than disappears, so the strip keeps its
// shape and "0 need you" is a positive answer, not a missing one.
function Count({ kind, n, word }: { kind: "need" | "run" | "held" | "done"; n: number; word: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${n ? "" : "opacity-50"}`}>
      <Glyph kind={kind} />{n}<span className="text-[16px] font-medium text-neutral-300">{word}</span>
    </span>
  );
}

export function Glance() {
  useBuildRefresh();
  const [act, setAct] = useState<Activity | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  // A need predating the `since` field (a server older than this page) has no age of its own; fall
  // back to when this page first saw it, which is a lower bound rather than a fabrication.
  const firstSeen = useRef<Map<string, number>>(new Map());
  const asked = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/agent/live", { cache: "no-store" });
      const d = await r.json();
      if (!d || typeof d.activity !== "object") throw new Error("bad reply");
      setAct(d.activity);
      setNow(Date.now());
      setLastOk(Date.now());
      setFailed(false);
    } catch {
      // Keep showing the last board, but say it's stale (header). On a cover screen "nothing needs you"
      // and "I stopped updating" otherwise look identical — both are an empty list.
      setFailed(true);
      setNow(Date.now());
    }
  }, []);

  // Poll only while visible: the Flex Window turns off the moment the phone goes in a pocket, and a
  // hidden page polling every 5s all day is the cost lib/page-visible.ts exists to prevent. On return,
  // refresh at once rather than showing a board up to one interval stale.
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!pageHidden()) load(); }, POLL_MS);
    const off = onPageVisible(load);
    return () => { clearInterval(t); off(); };
  }, [load]);

  // Titles: only for ids we haven't asked about. `?ids=` keeps it to a few hundred bytes instead of
  // the whole board's session list (see the route).
  useEffect(() => {
    if (!act) return;
    const missing = Object.keys(act).filter((id) => !asked.current.has(id));
    if (!missing.length) return;
    missing.forEach((id) => asked.current.add(id));
    fetch(`/api/bento/sessions?ids=${missing.map(encodeURIComponent).join(",")}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { sessions?: { id: string; title?: string; task?: string }[] }) => {
        const add: Record<string, string> = {};
        // task || title — the same choice as the board's titleOf, so a chat reads the same on both screens.
        for (const s of d.sessions || []) { const t = s.task || s.title; if (t) add[s.id] = t; }
        if (Object.keys(add).length) setTitles((p) => ({ ...p, ...add }));
      })
      // Retry on a later poll rather than leaving the folder-name fallback up forever.
      .catch(() => missing.forEach((id) => asked.current.delete(id)));
  }, [act]);

  // The resume confirm is a second tap, not a dialog: it lapses on its own so a stray tap days later
  // can't complete it.
  useEffect(() => {
    if (!confirmResume) return;
    const t = setTimeout(() => setConfirmResume(false), RESUME_CONFIRM_MS);
    return () => clearTimeout(t);
  }, [confirmResume]);

  const entries = Object.entries(act || {});
  for (const [, t] of entries) if (t.need && !firstSeen.current.has(t.need.id)) firstSeen.current.set(t.need.id, now);

  const needs = entries.filter(([, t]) => t.need);
  const running = entries.filter(([, t]) => t.busy && !t.need);
  const done = entries.filter(([, t]) => !t.busy && t.ended?.ok && now - t.ended.at < DONE_WINDOW_MS);
  const held = entries.filter(([, t]) => t.hold);
  const anyHeld = held.length > 0;
  const busyIds = entries.filter(([, t]) => t.busy && !t.hold).map(([id]) => id);

  const waitedSince = (n: Need) => n.since ?? firstSeen.current.get(n.id) ?? now;
  // Soonest deadline first — a held step auto-DENIES at expiresAt, so that is the one about to be
  // decided without you. Then the longest wait.
  needs.sort(([, a], [, b]) => {
    const ea = a.need!.expiresAt ?? Infinity, eb = b.need!.expiresAt ?? Infinity;
    if (ea !== eb) return ea - eb;
    return waitedSince(a.need!) - waitedSince(b.need!);
  });
  running.sort(([, a], [, b]) => (b.turnStartedAt ?? 0) - (a.turnStartedAt ?? 0));

  const showingNeeds = needs.length > 0;
  const lines = (showingNeeds ? needs : running).slice(0, MAX_LINES);
  const more = (showingNeeds ? needs.length : running.length) - lines.length;

  // The one action. Pause rides the existing Flow brake (/api/agent/hold), keyed `live:<sessionId>` —
  // the alias the manager stores every initialised session under. It parks the next tool call rather
  // than killing anything, which is why it needs no confirm: nothing is lost, and a resume undoes it.
  // Resume lets work run unattended again, so it takes a second tap.
  const act_ = async (hold: boolean) => {
    const ids = hold ? busyIds : held.map(([id]) => id);
    if (!ids.length) return;
    setBusyAction(true);
    try {
      await Promise.all(ids.map((id) => fetch("/api/agent/hold", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: `live:${id}`, hold }),
      }).catch(() => null)));
    } finally {
      setBusyAction(false);
      setConfirmResume(false);
      load();
    }
  };
  const onMain = () => {
    if (anyHeld) {
      if (!confirmResume) { setConfirmResume(true); return; }
      act_(false);
    } else act_(true);
  };

  const stale = failed || (lastOk !== null && now - lastOk > POLL_MS * 3);
  const mainLabel = anyHeld ? (confirmResume ? "Tap again to resume" : `Resume all (${held.length})`) : "Pause all";
  const mainDisabled = busyAction || (!anyHeld && busyIds.length === 0);

  return (
    <main className="flex h-dvh flex-col gap-2 overflow-hidden bg-neutral-950 px-3 pb-[max(10px,env(safe-area-inset-bottom))] pt-[max(10px,env(safe-area-inset-top))] text-neutral-100">
      {/* Counts. Each one keeps its glyph so the strip still reads in greyscale / sunlight. */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[20px] font-semibold leading-tight tabular-nums" aria-live="polite">
        {act === null && !failed ? <span className="text-neutral-400">Loading…</span> : <>
          <Count kind="need" n={needs.length} word="need you" />
          <Count kind="run" n={running.length} word="running" />
          <Count kind="done" n={done.length} word="done" />
          {/* No "paused" count here: the button already says "Resume all (n)", and a fourth count
              wraps the strip onto a second row that the 400px screen pays for out of the list. */}
        </>}
        {stale && <span className="ml-auto text-[16px] font-medium text-rose-300">{lastOk && now - lastOk >= 60_000 ? `offline · ${age(now - lastOk)}` : "offline"}</span>}
      </header>

      <div className="text-[16px] font-medium uppercase tracking-wide text-neutral-400">
        {/* Never "All quiet" while stale: an empty board from a dead poll would read as a clean bill. */}
        {showingNeeds ? "Needs you" : running.length ? "Running" : stale ? "Not updating" : act ? "All quiet" : ""}
        {/* The overflow rides on the label row rather than taking a row of its own under the list. */}
        {more > 0 && <span className="normal-case tracking-normal"> · +{more} more</span>}
      </div>

      <ul className="flex min-h-0 flex-1 flex-col gap-1.5">
        {lines.map(([id, t]) => {
          const title = titles[id] || folderOf(t.cwd);
          const glyph = t.hold && !t.need ? "held" : t.need ? "need" : "run";
          return (
            <li key={id}>
              {/* The whole line is the link to the main screen — a 48px+ target, where the one-line
                  gist becomes the full question/command you can actually judge. */}
              <a href={`/?open=${encodeURIComponent(id)}`} className="flex min-h-[64px] items-center gap-2.5 rounded-xl bg-white/[0.06] px-3 py-2 active:bg-white/[0.12]">
                <Glyph kind={glyph} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[17px] font-semibold leading-snug">{title}</span>
                  <span className="block truncate text-[16px] leading-snug text-neutral-300">
                    {t.need ? gist(t.need.summary) : t.label || t.phase}
                  </span>
                </span>
                {t.need && <span className="shrink-0 text-[17px] font-semibold tabular-nums text-amber-200">{age(now - waitedSince(t.need))}</span>}
              </a>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={onMain}
        disabled={mainDisabled}
        className={`h-14 shrink-0 rounded-2xl text-[20px] font-bold transition-colors disabled:opacity-40 ${
          anyHeld ? (confirmResume ? "bg-amber-300 text-neutral-950" : "bg-emerald-400/90 text-neutral-950") : "bg-violet-400/90 text-neutral-950"
        }`}
      >
        {busyAction ? "…" : mainLabel}
      </button>
    </main>
  );
}
