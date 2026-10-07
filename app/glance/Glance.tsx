"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { onPageVisible, pageHidden } from "@/lib/page-visible";
import { useBuildRefresh } from "@/lib/use-build-refresh";
import { COVER_QUERY, useCoverScreen } from "@/lib/use-cover";
import { reportViewport } from "@/lib/viewport-report";
import { ProjectIcon } from "@/components/ProjectIcon";
import ChatName from "@/components/ChatName";

// /glance — the Galaxy Z Flip 7 Flex Window (~360×400 CSS px, read at arm's length). §23.
//
// Round 10 (2026-10-06, after using it on the real Flip: "confusing, can't read what's happening,
// progress and switch chat … I have to scroll to see the button in the left down corner"). Measured on
// the device (~/.minami/viewports.jsonl): the cover gives the app a 541×473 CSS window on a 362×400
// screen — Samsung runs cover apps in a bigger virtual window and SCALES IT DOWN ~0.67×, into the
// area above the lenses (541×473 has the aspect of 362×316). So every size here rendered at two-thirds,
// and the lens band below was reserved twice (the OS had already kept the app out of it).
// - `useCoverZoom` undoes the scale-down: the page lays out in true cover px and CSS `zoom` scales it
//   back up to fill the window. 15px here is 15px on the glass.
// - No lens band: the OS owns that; the bottom row is ours, full width.
// - The screen answers three things, in order: WHICH chat (title + its state in words), WHAT it's doing
//   now (the plan step or the activity, in words — never "run: cat > …"), HOW FAR (step n of m and the
//   bar). Switching is ‹ › at the bottom with the count between them; tap the count for the list.
// The round-9 notes below still hold except where they mention the lens band or "no progress bars".
//
// Round 11 ("I can't read full"): researched against watchOS/Wear OS reading guidance, Samsung's One
// UI cover direction and a Pinterest board (~/ecvision/pitches/minami-phone/refs/picks). Two rules:
// the FIRST screen must answer which / what / how far with no scroll (it does), and LONG TEXT GETS ITS
// OWN SCROLLING VIEW one tap away, never a line-clamp. Tap the card (or "Read all ›") → the reader: the
// full reply (or the full question — the feed cuts it at 200 chars) at 16/24, ~40 chars a line, with what
// You last said above it and Reply below. Body text is 16px everywhere (watch-reading floor).
//
// Round 12 — THE THREAD (his pick from the cover-reading pitch, "V2 with keyboard input"). The cover is
// a watch-style messenger, because a conversation is the one reading pattern everyone already knows:
// - chats are FACES across the top (project icon + state mark, current one ringed); tap one to switch.
// - the chat is BUBBLES: your last message small on the right, Claude's reply in full as one 16/23
//   bubble per paragraph, scrollable, newest at the bottom. No status card, no "Read all" — reading IS
//   the screen.
// - work is ONE live bubble: the step in words, the segments, "Step n of m · about Nm left".
// - Claude's options become reply chips; an approval shows as a bubble with "Open on main screen".
// - a text field is always at the bottom (keyboard input on the cover). Keyboard up: the faces and chips
//   step aside, the thread keeps the last bubble in view above the field.
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
type Progress = { done: number; total: number; now?: string; etaAt?: number; lastDoneAt?: number };
type Tile = {
  phase: string; label: string; busy: boolean; cwd: string; turnStartedAt: number | null; mode?: string; progress?: Progress;
  need?: Need; needs?: number; ended?: { at: number; ok: boolean; text?: string; error?: string }; hold?: boolean;
};
type Activity = Record<string, Tile>;
type State = "you" | "work" | "held" | "fail" | "done";
type Chat = { id: string; t: Tile; state: State; title: string; project: string; since: number };
type Draft = { pick: number | null; text: string };

const POLL_MS = 5000;
const TITLE_REFRESH_MS = 30_000;
const DONE_WINDOW_MS = 30 * 60_000; // finished (ok or not) within the last half hour still counts as focus
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
 *  a list row has room for one line, and the full text is one tap away on the main screen. */
function gist(s: string, words = 8): string {
  const w = s.replace(/\s+/g, " ").trim().split(" ");
  return w.length <= words ? w.join(" ") : w.slice(0, words).join(" ") + "…";
}

/** The cover's scale-down, undone. Samsung lays a cover app out in a window wider than the screen
 *  (541 CSS px on the Flip 7's 362) and shrinks it to fit; `innerWidth / screen.width` is that factor.
 *  1 everywhere else, including a desktop browser opening /glance on purpose. */
function useCoverZoom(): { k: number; w: number; h: number; top: number } {
  // Sized to the VISUAL viewport — the part actually on the glass — not the layout window. On the real
  // Flip the field at the bottom sat off-screen "like I scrolled to the bottom": the window is taller
  // than what the cover shows (and the keyboard shrinks the visual viewport, not always the window), so
  // a page sized to 100dvh put its last row out of sight. Pinned with position:fixed at the visual
  // viewport's own offset, so the page itself can never be scrolled away either.
  const [v, setV] = useState({ k: 1, w: 0, h: 0, top: 0 });
  useEffect(() => {
    const vv = window.visualViewport;
    const on = () => {
      const r = window.innerWidth / Math.max(1, window.screen.width);
      const k = window.screen.width <= 480 && r > 1.1 ? Math.round(r * 1000) / 1000 : 1;
      setV({ k, w: vv?.width ?? window.innerWidth, h: vv?.height ?? window.innerHeight, top: vv?.offsetTop ?? 0 });
    };
    on();
    window.addEventListener("resize", on);
    vv?.addEventListener("resize", on);
    vv?.addEventListener("scroll", on);
    return () => { window.removeEventListener("resize", on); vv?.removeEventListener("resize", on); vv?.removeEventListener("scroll", on); };
  }, []);
  return v;
}

/** What a chat is doing, in words a glance can take. The plan step wins (it's the model's own
 *  sentence for the work); otherwise the live activity, minus anything that reads like a terminal. */
function nowLine(t: Tile): string {
  if (t.progress?.now) return t.progress.now;
  const l = (t.label || t.phase || "").trim();
  if (/^run: /.test(l)) return "Running a command";
  if (/^subagent: /.test(l)) return "Helper agent: " + l.slice(10).replace(/\s+\S{1,7}$/, "…");
  if (!l || l === "thinking" || l === "idle") return "Thinking";
  return l.charAt(0).toUpperCase() + l.slice(1);
}
/** A reply's opening, as prose: the cover has no markdown renderer, and "**It's merged**" in raw
 *  asterisks is noise on a 362px screen. */
const plain = (t: string) => t.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]+/g, "").replace(/^\s*[-•]\s+/gm, "").replace(/\s+/g, " ").trim();
/** The reader's version: markdown marks off, but line breaks and list bullets kept, since a list read
 *  as one run-on line is the thing the reader exists to fix. Code blocks become a marker; reading code on
 *  a 362px screen is the main screen's job. */
const readable = (t: string) => t.replace(/```[\s\S]*?```/g, "[code — open on the main screen]").replace(/\*\*|__|`/g, "")
  .replace(/^#+\s*/gm, "").replace(/^\s*[-*]\s+/gm, "• ").replace(/[ \t]+/g, " ").trim();
const STATE_WORD: Record<State, string> = { you: "Needs you", work: "Working", held: "Paused", fail: "Failed", done: "Done" };

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
  // Came here by the main page's cover redirect (`?auto=1`)? Then unfolding the phone goes back to the
  // board. Opened on purpose, it stays.
  const cover = useCoverScreen();
  useEffect(() => { reportViewport("/glance"); }, []);
  // The cover never scrolls as a page — only the thread inside it does. A scrollable document is what
  // let the field slide off the bottom of the glass.
  useEffect(() => {
    const els = [document.documentElement, document.body];
    const prev = els.map((e) => e.style.overflow);
    els.forEach((e) => { e.style.overflow = "hidden"; });
    return () => els.forEach((e, i) => { e.style.overflow = prev[i]; });
  }, []);
  // Asks matchMedia itself rather than trusting `cover`: during hydration the hook returns its SERVER
  // value (false), and acting on that bounced every cover visit straight back to / — a redirect loop.
  useEffect(() => {
    if (!cover && !window.matchMedia(COVER_QUERY).matches && new URLSearchParams(location.search).has("auto")) location.replace("/");
  }, [cover]);
  const [act, setAct] = useState<Activity | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const [view, setView] = useState<"cover" | "list">("cover");
  const [thread, setThread] = useState<{ key: string; text: string; you: string; question?: string } | null>(null);
  // null = "follow the chat that needs you most". Set only by a deliberate swipe or list tap, so a new
  // need arriving doesn't yank the screen out from under a half-typed answer.
  const [curId, setCurId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [typing, setTyping] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);
  // A need predating the `since` field (a server older than this page) has no age of its own; fall
  // back to when this page first saw it, which is a lower bound rather than a fabrication.
  const firstSeen = useRef<Map<string, number>>(new Map());
  const asked = useRef<Set<string>>(new Set());
  const swipeX = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
  // Asked once per id, titles never moved while the cover stayed open — and the title is the one
  // thing on this screen saying which chat you're in. The rolling title (§5h) changes every few asks,
  // so every id is re-asked each TITLE_REFRESH_MS; new ids are still asked at once.
  const titlesAt = useRef(0);
  useEffect(() => {
    if (!act) return;
    const due = Date.now() - titlesAt.current > TITLE_REFRESH_MS;
    const missing = due ? Object.keys(act) : Object.keys(act).filter((id) => !asked.current.has(id));
    if (!missing.length) return;
    if (due) titlesAt.current = Date.now();
    missing.forEach((id) => asked.current.add(id));
    fetch(`/api/bento/sessions?ids=${missing.map(encodeURIComponent).join(",")}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { sessions?: { id: string; title?: string; task?: string; now?: string }[] }) => {
        const add: Record<string, string> = {};
        // now || task || title — the board's titleOf, so a chat reads the same on both screens.
        for (const s of d.sessions || []) { const t = s.now || s.task || s.title; if (t) add[s.id] = t; }
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

  const { k, w: vw, h: vh, top: vtop } = useCoverZoom();
  // Lay out in true cover px; zoom scales it back up to fill the VISIBLE viewport (useCoverZoom).
  // Before the first measurement (vh 0) fall back to the old dvh sizing for one frame.
  const frame = vh
    ? ({ zoom: k, position: "fixed", left: 0, top: vtop / k, width: vw / k, height: vh / k } as const)
    : ({ zoom: k, width: `calc(100vw / ${k})`, height: `calc(100dvh / ${k})` } as const);

  // The conversation for the chat on screen: its latest reply in full and what you last said
  // (/api/glance/last). Re-fetched when the chat changes or a new turn ends — not on every poll.
  const threadKey = cur ? `${cur.id}:${cur.t.ended?.at ?? 0}:${need?.id ?? ""}` : "";
  const threadBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!cur) return;
    let live = true;
    fetch(`/api/glance/last?id=${encodeURIComponent(cur.id)}${need ? `&need=${encodeURIComponent(need.id)}` : ""}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (live) setThread({ key: threadKey, text: d.text || "", you: d.you || "", question: d.question }); })
      .catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey]);
  // Newest at the bottom, like every messenger: land on the end of the conversation.
  // Scroll the THREAD to its end — never scrollIntoView, which also scrolls every ancestor up to the
  // page and was what pushed the field off the bottom of the cover.
  useEffect(() => { const b = threadBox.current; if (b) b.scrollTop = b.scrollHeight; }, [thread?.key, typing, vh]);

  if (view === "list") {
    return (
      <main style={frame} className="flex flex-col overflow-hidden bg-neutral-950 px-4 pb-2 pt-3 text-neutral-100">
        <div className="flex shrink-0 items-center gap-2" aria-live="polite">
          <button type="button" onClick={() => setView("cover")} className="-ml-2 flex h-10 items-center px-2 text-[15px] text-neutral-300">‹ Back</button>
          <span className="text-[13px] text-neutral-500">{focus.length} chats</span>{offline}
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {focus.map((c) => {
            const line = c.state === "you" ? gist(c.t.need!.summary)
              : c.state === "fail" ? (c.t.ended?.error ? gist(c.t.ended.error) : "failed")
              : c.state === "done" ? `done · ${age(now - c.since)}`
              : c.t.progress ? `${gist(nowLine(c.t), 6)} · ${Math.min(c.t.progress.done + 1, c.t.progress.total)}/${c.t.progress.total}`
              : gist(nowLine(c.t), 6);
            return (
              <li key={c.id} className="flex items-center border-t border-white/10">
                <button type="button" onClick={() => { goTo(c); setView("cover"); }} className="flex min-h-[48px] min-w-0 flex-1 items-center gap-3 py-1.5 text-left">
                  <span className="flex w-3 justify-center"><Mark s={c.state} /></span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[15px] leading-[20px] ${c.id === cur?.id ? "font-semibold" : ""} ${c.state === "done" ? "text-neutral-400" : ""}`}><ChatName project={c.project} title={c.title} /></span>
                    <span className={`block truncate text-[13px] leading-[18px] ${c.state === "fail" ? "text-rose-400" : "text-neutral-500"}`}>{line}</span>
                  </span>
                </button>
                <a href={openHref(c.id)} aria-label="Open on main screen" className="flex h-11 w-9 shrink-0 items-center justify-end text-[16px] text-neutral-500">›</a>
              </li>
            );
          })}
          {!focus.length && <li className="border-t border-white/10 py-3 text-[15px] text-neutral-500">{stale ? "Not updating" : act ? "All quiet" : "Loading…"}</li>}
        </ul>
        <div className="flex shrink-0 items-center justify-between border-t border-white/10 pt-1.5">
          <button type="button" onClick={onPause} disabled={busyAction || (!anyHeld && !busyIds.length)} className="py-2 text-[13px] text-neutral-400 disabled:opacity-40">{pauseLabel}</button>
          <a href="/" className="py-2 text-[13px] text-neutral-400">Full app ›</a>
        </div>
      </main>
    );
  }

  const pg = cur?.state === "work" || cur?.state === "held" ? cur.t.progress : undefined;
  const fresh = thread && thread.key === threadKey ? thread : null;
  const paras = (fresh?.text || cur?.t.ended?.text || "").split(/\n{2,}/).map(readable).filter(Boolean);
  const FACES = 6;

  const bubble = (t: ReactNode, key: string | number, tone?: "you" | "fail") => (
    <div key={key} className={`flex ${tone === "you" ? "justify-end" : ""}`}>
      <p className={`max-w-[88%] whitespace-pre-line rounded-2xl px-3 py-2 ${tone === "you" ? "bg-white/[0.08] text-[13px] leading-[18px] text-neutral-400" : `bg-white/[0.045] text-[16px] leading-[23px] ${tone === "fail" ? "text-rose-300" : "text-neutral-100"}`}`}>{t}</p>
    </div>
  );

  return (
    <main style={frame} className="flex flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      {/* FACES — the chats. Tap to switch; the list (and Pause all) is behind the last button. Hidden
          with the keyboard up: you can't switch mid-sentence, and the thread needs the room. */}
      {!typing && (
        <div className="flex shrink-0 items-center gap-2 overflow-x-auto px-3 pb-1 pt-2.5" aria-live="polite">
          {focus.slice(0, FACES).map((c) => (
            <button key={c.id} type="button" onClick={() => goTo(c)} aria-label={`${c.title} — ${STATE_WORD[c.state]}`}
              className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${c.id === cur?.id ? "bg-[var(--sakura)]/15 ring-2 ring-[var(--sakura)]" : "bg-white/[0.06]"}`}>
              <ProjectIcon name={c.project} size={24} />
              <span className="absolute -bottom-0.5 -right-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-neutral-950"><Mark s={c.state} /></span>
            </button>
          ))}
          <button type="button" onClick={() => setView("list")} aria-label="All chats"
            className="flex h-10 min-w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.04] px-2.5 text-[13px] tabular-nums text-neutral-400">
            {focus.length > FACES ? `+${focus.length - FACES}` : "☰"}
          </button>
          {offline}
        </div>
      )}
      {/* WHERE YOU ARE — the header (§5h, 2026-10-07). It used to be one 13px grey line under faces
          that only showed project icons, so two chats in one repo looked identical and "which chat is
          this, how far along" took reading the bubbles. Now: "Project: title" at reading size, then
          state · progress · n of m, with ‹ › (and a swipe on the header) to step through the chats. */}
      {(() => {
        const step = (d: number) => goTo(focus[(curIdx + d + focus.length) % focus.length]);
        const pgH = cur && (cur.state === "work" || cur.state === "held") ? cur.t.progress : undefined;
        const leftH = pgH?.etaAt ? Math.max(1, Math.round((pgH.etaAt - now) / 60000)) : null;
        const status = !cur ? "" : cur.state === "work" || cur.state === "held"
          ? (pgH && pgH.total > 0 ? `step ${Math.min(pgH.done + 1, pgH.total)} of ${pgH.total}${leftH ? ` · ~${leftH}m left` : ""}` : `for ${age(now - cur.since)}`)
          // age() says "now" under a minute, which read as "now ago" / "waiting now" in this sentence.
          : cur.state === "you" ? (age(now - cur.since) === "now" ? "just asked" : `waiting ${age(now - cur.since)}`)
          : cur.state === "done" ? (age(now - cur.since) === "now" ? "just now" : `${age(now - cur.since)} ago`) : "";
        return (
          <div className="flex shrink-0 items-center gap-0.5 px-1 pt-1"
            onTouchStart={(e) => { swipeX.current = e.touches[0].clientX; }}
            onTouchEnd={(e) => { const x = swipeX.current; swipeX.current = null; if (x == null || focus.length < 2) return; const dx = e.changedTouches[0].clientX - x; if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1); }}>
            {focus.length > 1 && <button type="button" aria-label="Previous chat" onClick={() => step(-1)} className="flex h-11 w-7 shrink-0 items-center justify-center text-[20px] text-neutral-500">‹</button>}
            <div className="min-w-0 flex-1 px-1">
              {cur ? (
                <>
                  <p className="line-clamp-2 text-[16px] font-semibold leading-[20px] text-neutral-50"><ChatName project={cur.project} title={cur.title} /></p>
                  <p className="truncate text-[13px] leading-[18px] text-neutral-400">
                    <span className={cur.state === "fail" ? "text-rose-400" : cur.state === "you" ? "text-[#f0a868]" : cur.state === "work" ? "text-neutral-200" : ""}>{STATE_WORD[cur.state]}</span>
                    {status && ` · ${status}`}
                    {focus.length > 1 && <span className="tabular-nums text-neutral-500"> · {curIdx + 1}/{focus.length}</span>}
                  </p>
                </>
              ) : <p className="py-2 text-[15px] text-neutral-400">{stale ? "Not updating" : act ? "Nothing needs you" : "Loading…"}</p>}
            </div>
            {focus.length > 1 && <button type="button" aria-label="Next chat" onClick={() => step(1)} className="flex h-11 w-7 shrink-0 items-center justify-center text-[20px] text-neutral-500">›</button>}
          </div>
        );
      })()}

      {/* THE THREAD — newest at the bottom, scrolls like any messenger. */}
      <div ref={threadBox} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2 pt-1.5">
        <div className="flex min-h-full flex-col justify-end gap-2">
          {cur && fresh?.you && bubble(plain(fresh.you.replace(/<[^>]+>/g, " ")).slice(0, 160), "you", "you")}
          {cur && isQuestion ? (
            bubble(fresh?.question || need!.summary, "q")
          ) : cur && toolStep ? (
            <div className="rounded-2xl bg-white/[0.045] px-3 py-2.5">
              <p className="text-[16px] leading-[22px]">{need!.kind === "plan" ? "A plan is ready for review" : need!.kind === "held" ? "A step is held for review" : need!.kind === "permission" ? "A step is waiting for approval" : "Claude asked something"}</p>
              <p className="mt-1 line-clamp-2 break-all text-[13px] leading-[18px] text-neutral-500">{need!.summary}</p>
              <a href={openHref(cur.id)} className="mt-2 inline-block text-[15px] text-[var(--sakura)]">Open on main screen ›</a>
            </div>
          ) : cur && (cur.state === "work" || cur.state === "held") ? (
            <>
              {paras.slice(-2).map((t, i) => bubble(t, `p${i}`))}
              {/* work = ONE live bubble: what, how far */}
              <div className="rounded-2xl border border-white/10 px-3 py-2.5">
                <p className="flex items-center gap-2 text-[16px] leading-[22px]"><Mark s={cur.state} /><span className="min-w-0 flex-1">{nowLine(cur.t)}</span></p>
                {pg && pg.total > 0 ? (
                  <>
                    <div className="mt-2 flex gap-[3px]">{Array.from({ length: Math.min(pg.total, 12) }).map((_, i) => <span key={i} className={`h-[5px] flex-1 rounded-full ${i < pg.done ? "bg-neutral-200" : i === pg.done ? "bg-neutral-500" : "bg-white/10"}`} />)}</div>
                  </>
                ) : <p className="mt-1 text-[13px] text-neutral-500">for {age(now - cur.since)}</p>}
              </div>
            </>
          ) : cur && cur.state === "fail" ? (
            <>{paras.slice(-2).map((t, i) => bubble(t, `p${i}`))}{bubble(cur.t.ended?.error || "The last turn failed", "err", "fail")}</>
          ) : cur ? (
            paras.length ? paras.map((t, i) => bubble(t, `p${i}`)) : bubble("Done, waiting for your reply", "d")
          ) : null}

        </div>
      </div>

      {/* Claude's options as reply chips — tap one to make it the start of your answer. */}
      {!typing && isQuestion && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-1.5">
          {opts.map((o, i) => {
            const n = i + 1, on = draft.pick === n;
            return (
              <button key={n} type="button" onClick={() => setDraft({ pick: on ? null : n })}
                className={`flex h-10 max-w-[78%] shrink-0 items-center gap-2 rounded-full px-3.5 text-[14px] ${on ? "bg-[var(--sakura)]/20 text-neutral-50 ring-1 ring-[var(--sakura)]" : "bg-white/[0.08] text-neutral-200"}`}>
                <span className={`text-[12px] tabular-nums ${on ? "text-[var(--sakura)]" : "text-neutral-500"}`}>{n}</span><span className="truncate">{o}</span>
              </button>
            );
          })}
        </div>
      )}
      {sendErr && <p className="shrink-0 px-4 pb-1 text-[13px] text-rose-400">{sendErr}</p>}
      {/* KEYBOARD INPUT — always here. Typing into a working chat queues a follow-up (the same as the
          main screen's composer while busy). */}
      {cur && !toolStep && (
        <form onSubmit={(e) => { e.preventDefault(); send(); }} className="mx-3 mb-2 flex shrink-0 items-center gap-2 rounded-full bg-white/[0.08] py-1 pl-4 pr-1">
          {draft.pick && <span className="shrink-0 text-[15px] text-[var(--sakura)]">{draft.pick} —</span>}
          <input
            ref={inputRef}
            value={draft.text}
            onChange={(e) => setDraft({ text: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Backspace" && !draft.text && draft.pick) setDraft({ pick: null }); }}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            enterKeyHint="send"
            placeholder={isQuestion ? (draft.pick ? "add a note, or send" : "pick one, or type") : cur.state === "work" ? "Queue a follow-up" : "Reply"}
            aria-label={isQuestion ? "Your answer" : "Your reply"}
            className="min-w-0 flex-1 bg-transparent py-1.5 text-[16px] leading-[20px] text-neutral-100 caret-[var(--sakura)] outline-none placeholder:text-neutral-500"
          />
          <button type="submit" aria-label="Send" disabled={sending || (!draft.text.trim() && !draft.pick)} onPointerDown={(e) => e.preventDefault()}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--sakura)] text-[15px] text-white disabled:opacity-40">
            {sending ? "…" : "↑"}
          </button>
        </form>
      )}
    </main>
  );
}
