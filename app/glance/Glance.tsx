"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { onPageVisible, pageHidden } from "@/lib/page-visible";
import { useBuildRefresh } from "@/lib/use-build-refresh";

// /glance — the Galaxy Z Flip 7 Flex Window (~360×400 CSS px, read at arm's length). §23.
//
// Round 9 ("Cover · around the lenses", pitch V2). Three rules shape everything below:
//
// 1. The screen is drawn AROUND its two camera lenses. They sit in the bottom-right corner, so a
//    ~170×96 band there renders nothing and takes no tap (LENS_BAND / LENS_W). The bottom-left of that
//    band is the one spare spot on the screen, and the chat switcher lives there; the answer field sits
//    just above it. Round 8 put a dock across the bottom and half of it was under glass.
// 2. Lean: three type sizes only — the question 19/25 semibold, options/answer 15/21, meta 12–13 grey.
//    No boxes, no chip rows, no progress bars (the list says the step in words).
// 3. One accent, var(--sakura), and it means "you": your pick, your answer, the chat you're on. State
//    marks are neutral SHAPES (filled dot = needs you, turning thin ring = working, ✓ = done), and red
//    is reserved for a failure — the one thing allowed to interrupt. Round 8 had green, amber, red and
//    pink on one 360px screen and nothing stood out.
//
// What it still does NOT do is as deliberate as what it does: no approve buttons. A 360×400 screen
// can't show enough of a command to approve it safely, and a half-read "Bash · rm -rf /Users/thom…"
// with an Allow button under it is worse than no button. So a permission / plan / held step shows its
// summary and a link to the main screen. What IS safe blind is answering Claude's own question (the
// options are Claude's, not a command), replying to a chat that's waiting on you, and pause.

type Need = { id: string; kind: "question" | "plan" | "held" | "permission"; tool: string; summary: string; options?: string[]; expiresAt?: number; since?: number };
type Tile = {
  phase: string; label: string; busy: boolean; cwd: string; turnStartedAt: number | null; mode?: string;
  need?: Need; needs?: number; ended?: { at: number; ok: boolean; text?: string; error?: string }; hold?: boolean;
};
type Activity = Record<string, Tile>;
type State = "you" | "work" | "held" | "fail" | "done";
type Chat = { id: string; t: Tile; state: State; title: string; project: string; since: number };
type Draft = { pick: number | null; text: string };

const POLL_MS = 5000;
const DONE_WINDOW_MS = 30 * 60_000; // finished (ok or not) within the last half hour still counts as focus
const RESUME_CONFIRM_MS = 4000;
const LENS_BAND = 96; // height of the bottom band the lenses sit in
const LENS_W = 170; // width of its right-hand part that belongs to the lenses
const MAX_OPTIONS = 3; // what fits between the question and the field at 15/21 without scrolling
const MARKS = 5;
const SWIPE_PX = 28;

/** "6m", "1h", "now" — the wait, at a size and precision you can take in at a glance. */
function age(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** The decision in a handful of words. need.summary is up to 200 chars ("Bash · git push origin …");
 *  a list row has room for one line, and the full text is one tap away on the main screen. */
function gist(s: string, words = 8): string {
  const w = s.replace(/\s+/g, " ").trim().split(" ");
  return w.length <= words ? w.join(" ") : w.slice(0, words).join(" ") + "…";
}

const folderOf = (cwd: string) => cwd.split("/").filter(Boolean).pop() || cwd;
// A task worktree's folder is "chat-4", which says nothing; the project is the repo it hangs off.
const projectOf = (cwd: string) => folderOf(cwd.split(/\/\.(?:minami-worktrees|claude\/worktrees)\//)[0]);

const stateOf = (t: Tile): State =>
  t.need ? "you" : t.busy ? (t.hold ? "held" : "work") : t.ended && !t.ended.ok ? "fail" : "done";

// Neutral shapes, never colour alone — the screen is small, outdoors, and read at a glance. Under
// prefers-reduced-motion the ring stops turning; its open gap still tells it apart from the dot.
function Mark({ s }: { s: State }) {
  if (s === "you") return <span aria-label="needs you" className="inline-block h-2 w-2 shrink-0 rounded-full bg-neutral-100" />;
  if (s === "work") return <span aria-label="working" className="inline-block h-2.5 w-2.5 shrink-0 animate-[spin_1.6s_linear_infinite] rounded-full border-[1.5px] border-neutral-400 border-t-transparent motion-reduce:animate-none" />;
  if (s === "held") return (
    <span aria-label="paused" className="inline-flex h-2.5 shrink-0 items-center gap-[2px]">
      <span className="h-2.5 w-[2px] bg-neutral-400" /><span className="h-2.5 w-[2px] bg-neutral-400" />
    </span>
  );
  if (s === "fail") return <span aria-label="failed" className="inline-block h-2 w-2 shrink-0 rounded-full bg-rose-400" />;
  return <span aria-label="done" className="shrink-0 text-[10px] leading-none text-neutral-500">✓</span>;
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
  const [view, setView] = useState<"cover" | "list">("cover");
  // null = "follow the chat that needs you most". Set only by a deliberate swipe or list tap, so a new
  // need arriving doesn't yank the screen out from under a half-typed answer.
  const [curId, setCurId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [typing, setTyping] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [kbUp, setKbUp] = useState(false);
  // A need predating the `since` field (a server older than this page) has no age of its own; fall
  // back to when this page first saw it, which is a lower bound rather than a fabrication.
  const firstSeen = useRef<Map<string, number>>(new Map());
  const asked = useRef<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const swipe = useRef<{ x: number; y: number } | null>(null);

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
      // Keep showing the last board, but say it's stale (meta line). On a cover screen "nothing needs
      // you" and "I stopped updating" otherwise look identical — both are an empty screen.
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

  // Is the keyboard actually covering the bottom of the screen? The root layout sets
  // interactive-widget=resizes-content, so dvh already shrinks with it; this only decides whether the
  // field still has to keep clear of the lens band (keyboard down / not yet up) or can sit right on top
  // of the keyboard (which then covers the band anyway). Baseline = the tallest viewport seen.
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!vv) return;
    let tallest = vv.height;
    const on = () => { tallest = Math.max(tallest, vv.height); setKbUp(vv.height < tallest - 80); };
    vv.addEventListener("resize", on);
    return () => vv.removeEventListener("resize", on);
  }, []);

  const entries = Object.entries(act || {});
  for (const [, t] of entries) if (t.need && !firstSeen.current.has(t.need.id)) firstSeen.current.set(t.need.id, now);
  const waitedSince = (n: Need) => n.since ?? firstSeen.current.get(n.id) ?? now;

  const chats: Chat[] = entries.map(([id, t]) => {
    const state = stateOf(t);
    const since = t.need ? waitedSince(t.need) : (state === "work" || state === "held") ? (t.turnStartedAt ?? now) : (t.ended?.at ?? now);
    return { id, t, state, title: titles[id] || folderOf(t.cwd), project: projectOf(t.cwd), since };
  });
  // Focus = what's worth a glance: needs, running, and anything that finished in the last half hour
  // (an idle chat waiting on your reply). Older idle chats are one tap away under "All chats".
  const recent = (c: Chat) => now - c.since < DONE_WINDOW_MS;
  const fail = chats.filter((c) => c.state === "fail" && recent(c)).sort((a, b) => b.since - a.since);
  // Soonest deadline first — a held step auto-DENIES at expiresAt, so that is the one about to be
  // decided without you. Then the longest wait.
  const you = chats.filter((c) => c.state === "you").sort((a, b) => {
    const ea = a.t.need!.expiresAt ?? Infinity, eb = b.t.need!.expiresAt ?? Infinity;
    if (ea !== eb) return ea - eb;
    return a.since - b.since;
  });
  const work = chats.filter((c) => c.state === "work" || c.state === "held").sort((a, b) => b.since - a.since);
  const done = chats.filter((c) => c.state === "done" && recent(c)).sort((a, b) => b.since - a.since);
  // Failed sorts first in the list (the pitch); the COVER still opens on the chat that needs you most.
  const focus = [...fail, ...you, ...work, ...done];
  const cur = focus.find((c) => c.id === curId) ?? you[0] ?? focus[0] ?? null;
  const curIdx = cur ? focus.indexOf(cur) : -1;

  const held = entries.filter(([, t]) => t.hold);
  const anyHeld = held.length > 0;
  const busyIds = entries.filter(([, t]) => t.busy && !t.hold).map(([id]) => id);

  const need = cur?.t.need;
  // Answerable from the cover = Claude's own single question with options. Server-side the manager only
  // attaches `options` to a single, single-select question, which is exactly what /api/glance/answer
  // accepts; anything else (multi-question, multi-select) goes to the main screen's full card.
  const isQuestion = need?.kind === "question" && !!need.options?.length;
  const toolStep = !!need && !isQuestion; // permission / plan / held / a question too big for this screen
  const opts = isQuestion ? need!.options! : [];
  // Drafts are keyed by chat AND prompt, so answering one question doesn't leave its pick sitting on the next.
  const draftKey = cur ? `${cur.id}:${need?.id ?? ""}` : "";
  const draft: Draft = drafts[draftKey] ?? { pick: null, text: "" };
  const setDraft = (d: Partial<Draft>) => setDrafts((p) => ({ ...p, [draftKey]: { ...draft, ...d } }));

  const goTo = (c: Chat | undefined) => { if (!c) return; setCurId(c.id); setSendErr(null); };
  const step = (dir: 1 | -1) => { if (focus.length > 1) goTo(focus[(curIdx + dir + focus.length) % focus.length]); };

  // The pill takes both gestures: a horizontal swipe steps through the focus chats, anything else is a
  // tap that opens the list. touch-action: pan-y on it so the browser hands us the horizontal moves.
  const onPillDown = (e: RPointerEvent) => { swipe.current = { x: e.clientX, y: e.clientY }; };
  const onPillUp = (e: RPointerEvent) => {
    const s = swipe.current; swipe.current = null;
    if (!s) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) setView("list");
  };

  const send = async () => {
    if (!cur || sending) return;
    const text = draft.text.trim();
    const label = isQuestion && draft.pick ? opts[draft.pick - 1] : null;
    // The pick's own label leads, so it still matches one of Claude's options exactly when nothing is
    // added; extra words ride after it the way the main screen's "Other" text does.
    const body = label ? (text ? `${label} — ${text}` : label) : text;
    if (!body) return;
    setSending(true); setSendErr(null);
    try {
      const r = isQuestion
        ? await fetch("/api/glance/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: cur.id, needId: need!.id, answer: body }) })
        // A normal message, keyed `live:<sessionId>` — the alias the manager stores every initialised
        // session under, so this is the same warm session the main screen drives. `mode` is passed back
        // as-is because sendMessage re-applies whatever mode a send carries, and an absent one means the
        // box default — a reply from the cover would otherwise quietly switch the chat's permission mode.
        // `resume` only bites if the session closed between poll and tap, and then continues it.
        : await fetch("/api/agent/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: `live:${cur.id}`, cwd: cur.t.cwd, message: body, mode: cur.t.mode, resume: cur.id }) });
      const d = await r.json().catch(() => null);
      if (!d?.ok) throw new Error(d?.reason || d?.error || "not confirmed");
      setDrafts((p) => { const n = { ...p }; delete n[draftKey]; return n; });
      inputRef.current?.blur();
      load();
    } catch (e) {
      // Keep the draft: a failed send must never cost you what you typed.
      setSendErr(String((e as Error)?.message || e) === "already settled" ? "Already answered elsewhere" : "Didn't send — try again");
    } finally {
      setSending(false);
    }
  };

  // Pause rides the existing Flow brake (/api/agent/hold), keyed `live:<sessionId>`. It parks the next
  // tool call rather than killing anything, which is why it needs no confirm: nothing is lost, and a
  // resume undoes it. Resume lets work run unattended again, so it takes a second tap. Demoted to a
  // quiet text button in the list in round 9: it was the giant primary button, but the cover's most
  // used job turned out to be answering, not braking.
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
  const onPause = () => {
    if (anyHeld) {
      if (!confirmResume) { setConfirmResume(true); return; }
      act_(false);
    } else act_(true);
  };
  const pauseLabel = busyAction ? "…" : anyHeld ? (confirmResume ? "Tap again to resume" : `Resume all (${held.length})`) : `Pause all${busyIds.length ? ` (${busyIds.length})` : ""}`;

  const stale = failed || (lastOk !== null && now - lastOk > POLL_MS * 3);
  const offline = stale && (
    <span className="ml-auto text-[12px] text-rose-400">{lastOk && now - lastOk >= 60_000 ? `offline · ${age(now - lastOk)}` : "offline"}</span>
  );
  const openHref = (id: string) => `/?open=${encodeURIComponent(id)}`;

  // The lens band: the right LENS_W px are the cameras' — an inert spacer, so nothing can be drawn or
  // tapped there — and the left is whatever the frame puts in it.
  const band = (left: ReactNode) => (
    <div className="flex shrink-0 items-center" style={{ height: LENS_BAND }}>
      <div className="flex min-w-0 flex-1 items-center">{left}</div>
      <div aria-hidden className="pointer-events-none shrink-0" style={{ width: LENS_W - 16 }} />
    </div>
  );

  if (view === "list") {
    return (
      <main className="flex h-dvh flex-col overflow-hidden bg-neutral-950 px-4 pt-[max(12px,env(safe-area-inset-top))] text-neutral-100">
        <p className="flex shrink-0 items-center gap-2 text-[12px] text-neutral-500" aria-live="polite">
          Focus · {focus.length}{offline}
          <button type="button" onClick={() => setView("cover")} className={`${stale ? "" : "ml-auto"} -my-2 px-2 py-2 text-[13px] text-neutral-400`}>Close</button>
        </p>
        <ul className="mt-1 min-h-0 flex-1 overflow-y-auto">
          {focus.map((c) => {
            const line = c.state === "you" ? gist(c.t.need!.summary)
              : c.state === "fail" ? (c.t.ended?.error ? gist(c.t.ended.error) : "failed")
              : c.state === "done" ? `done · ${age(now - c.since)}`
              : `${c.t.label || c.t.phase} · ${age(now - c.since)}`;
            return (
              <li key={c.id} className="flex items-center border-t border-white/10">
                <button type="button" onClick={() => { goTo(c); setView("cover"); }} className="flex min-h-[52px] min-w-0 flex-1 items-center gap-3 py-2 text-left">
                  <span className="flex w-3 justify-center"><Mark s={c.state} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`truncate text-[15px] leading-[21px] ${c.state === "done" ? "text-neutral-400" : ""}`}>{c.title}</span>
                      {c.id === cur?.id && <span aria-label="on the cover" className="h-1.5 w-3 shrink-0 rounded-full bg-[var(--sakura)]" />}
                    </span>
                    <span className={`block truncate text-[12px] ${c.state === "fail" ? "text-rose-400" : "text-neutral-500"}`}>{line}</span>
                  </span>
                </button>
                {/* Its own 44px target: the row itself puts the chat on the cover; this opens it on the
                    main screen, where the full question / command can actually be judged. */}
                <a href={openHref(c.id)} aria-label="Open on main screen" className="flex h-11 w-9 shrink-0 items-center justify-end text-[15px] text-neutral-500">›</a>
              </li>
            );
          })}
          {/* Never "All quiet" while stale: an empty list from a dead poll would read as a clean bill. */}
          {!focus.length && <li className="border-t border-white/10 py-3 text-[15px] text-neutral-500">{stale ? "Not updating" : act ? "All quiet" : "Loading…"}</li>}
          <li className="border-t border-white/10 pt-1">
            <button type="button" onClick={onPause} disabled={busyAction || (!anyHeld && !busyIds.length)} className="py-2 text-[13px] text-neutral-400 disabled:opacity-40">
              {pauseLabel}
            </button>
          </li>
        </ul>
        {band(<a href="/" className="rounded-full bg-white/[0.07] px-4 py-2.5 text-[13px] text-neutral-300">All chats · {entries.length} ›</a>)}
      </main>
    );
  }

  // Up to MARKS chats in the pill, in a window that always contains the current one.
  const winStart = Math.max(0, Math.min(curIdx - Math.floor(MARKS / 2), focus.length - MARKS));
  const marks = focus.slice(winStart, winStart + MARKS);
  const showField = !!cur && !toolStep;

  const headline = !cur ? (stale ? "Not updating" : act ? "Nothing needs you" : "Loading…")
    : isQuestion ? need!.summary
    : need?.kind === "plan" ? "A plan is ready for review"
    : need?.kind === "held" ? "A step is held for review"
    : need?.kind === "permission" ? "A step is waiting for approval"
    : need ? need.summary
    : cur.title;

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-neutral-950 px-4 pt-[max(12px,env(safe-area-inset-top))] text-neutral-100">
      {/* Keyboard up drops the meta line, the options and the band: what's left is the question, the
          pick and the field. Every block stays in the same child slot either way, so React keeps the
          <input> mounted and the keyboard doesn't drop as the frame changes around it. */}
      {!typing && (
        <p className="flex shrink-0 items-center gap-2 text-[12px] text-neutral-500" aria-live="polite">
          {cur ? <><Mark s={cur.state} />{cur.project} · {age(now - cur.since)}</> : <span>{focus.length ? "" : "Minami"}</span>}
          {offline}
        </p>
      )}
      <p className={typing ? "shrink-0 truncate text-[14px] font-semibold" : `mt-2 shrink-0 line-clamp-3 text-[19px] font-semibold leading-[25px] ${cur ? "" : "text-neutral-500"}`}>
        {headline}
      </p>
      {typing && draft.pick && (
        // Tapping the pick drops the keyboard, back to the options, to change it.
        <button type="button" onClick={() => inputRef.current?.blur()} className="mt-1 shrink-0 truncate text-left text-[13px] text-neutral-300">
          <span className="text-[var(--sakura)]">{draft.pick}</span> · {opts[draft.pick - 1]} <span className="text-neutral-500">▾</span>
        </button>
      )}
      {!typing && cur && (
        <div className="mt-3 min-h-0 shrink overflow-hidden">
          {isQuestion ? (
            <>
              {opts.slice(0, MAX_OPTIONS).map((o, i) => {
                const n = i + 1, on = draft.pick === n;
                return (
                  <button key={n} type="button" onClick={() => setDraft({ pick: on ? null : n })}
                    className={`flex min-h-[40px] w-full items-center gap-3 border-t border-white/10 py-2 text-left text-[15px] leading-[21px] ${on ? "text-neutral-100" : "text-neutral-300"}`}>
                    <span className={`w-3 text-[13px] tabular-nums ${on ? "text-[var(--sakura)]" : "text-neutral-500"}`}>{n}</span>
                    <span className="min-w-0 flex-1 truncate">{o}</span>
                    {on && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--sakura)]" />}
                  </button>
                );
              })}
              {opts.length > MAX_OPTIONS && <a href={openHref(cur.id)} className="block border-t border-white/10 pt-2 text-[12px] text-neutral-500">+{opts.length - MAX_OPTIONS} more on the main screen ›</a>}
            </>
          ) : toolStep ? (
            <>
              {need!.kind !== "question" && <p className="line-clamp-2 break-all text-[13px] text-neutral-400">{need!.summary}</p>}
              {need!.expiresAt && <p className="mt-1 text-[12px] text-neutral-500">auto-denies in {age(Math.max(0, need!.expiresAt - now))}</p>}
              <a href={openHref(cur.id)} className="mt-3 inline-block text-[15px] leading-[21px] text-neutral-100">Open on main screen ›</a>
            </>
          ) : cur.state === "fail" ? (
            <p className="line-clamp-4 text-[15px] leading-[21px] text-rose-400">{cur.t.ended?.error || "The last turn failed"}</p>
          ) : cur.state === "done" ? (
            <p className="line-clamp-4 text-[15px] leading-[21px] text-neutral-400">{cur.t.ended?.text || "Done — waiting for your reply"}</p>
          ) : (
            <p className="truncate text-[15px] leading-[21px] text-neutral-400">{cur.t.label || cur.t.phase}</p>
          )}
        </div>
      )}
      <div className="min-h-2 flex-1" />
      {sendErr && <p className="mb-1 shrink-0 text-[12px] text-rose-400">{sendErr}</p>}
      {showField && (
        <form onSubmit={(e) => { e.preventDefault(); send(); }} className="flex shrink-0 items-center gap-2 rounded-full bg-white/[0.07] py-1.5 pl-4 pr-1.5">
          {/* The pick shows as "2 —" at the head of the field, in the accent, because it IS the start of
              your answer: send with nothing typed and the option's label goes on its own. Backspace in
              an empty field takes the pick back off. */}
          {draft.pick && <span className="shrink-0 text-[15px] text-[var(--sakura)]">{draft.pick} —</span>}
          <input
            ref={inputRef}
            value={draft.text}
            onChange={(e) => setDraft({ text: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Backspace" && !draft.text && draft.pick) setDraft({ pick: null }); }}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            enterKeyHint="send"
            placeholder={isQuestion ? (draft.pick ? "add a note, or send" : "pick one, or answer") : "Reply"}
            aria-label={isQuestion ? "Your answer" : "Your reply"}
            className="min-w-0 flex-1 bg-transparent text-[15px] leading-[21px] text-neutral-100 caret-[var(--sakura)] outline-none placeholder:text-neutral-500"
          />
          {/* preventDefault on pointer-down keeps the input focused through the tap, so the keyboard
              doesn't drop (and the frame doesn't re-flow) before the click lands. */}
          <button type="submit" aria-label="Send" disabled={sending || (!draft.text.trim() && !draft.pick)} onPointerDown={(e) => e.preventDefault()}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--sakura)] text-[14px] text-white disabled:opacity-40">
            {sending ? "…" : "↑"}
          </button>
        </form>
      )}
      {typing ? (
        // Keyboard up: it covers the lens band, so the field sits right on it. Not up (yet): keep clear.
        <div className="shrink-0" style={{ height: kbUp ? 8 : LENS_BAND }} />
      ) : band(
        <button type="button" onPointerDown={onPillDown} onPointerUp={onPillUp} onPointerCancel={() => { swipe.current = null; }}
          // detail 0 = a keyboard "click" (Enter/Space), which never produces the pointer pair above.
          onClick={(e) => { if (e.detail === 0) setView("list"); }}
          aria-label={focus.length > 1 ? "Switch chat (swipe) or show the list (tap)" : "Show the list"}
          className="flex min-w-0 max-w-full touch-pan-y select-none items-center gap-2.5 rounded-full bg-white/[0.07] px-3.5 py-2.5">
          <span className="min-w-0 max-w-[88px] truncate text-[13px]">{cur ? cur.title : "Chats"}</span>
          {marks.length > 0 && (
            <span className="flex shrink-0 items-center gap-1.5">
              {marks.map((c) => c.id === cur?.id
                ? <span key={c.id} aria-label="this chat" className="h-1.5 w-4 rounded-full bg-[var(--sakura)]" />
                : <Mark key={c.id} s={c.state} />)}
            </span>
          )}
          <span className="shrink-0 text-[13px] text-neutral-500">›</span>
        </button>
      )}
    </main>
  );
}
