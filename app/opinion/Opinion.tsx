"use client";
// Opinion Reveal (§38): pick any recent AI story and rant about it like texting a friend (pitch opinion-interview V2,
// picked 2026-10-29). Two views on one page: the TOPICS (every recent daily story, newest first, open any time — "I can
// randomly visit and pick topic") and the CHAT for one of them (?t=<id>). In the chat Minami texts the news and a
// question; Thomas fires off as many short messages as he likes; when he goes quiet Minami asks the follow-up; "Done
// ranting" wraps his messages into the take (his words joined, nothing added: lib/opinion.ts joinTake). Every message
// is written as he sends it, so a closed tab loses nothing. Saturday noon the takes waiting become the weekly video.
//
// Minami's side is deliberately scripted, not a model: a reply that offered opinions back would leak into what he
// says. The friend feel comes from the rhythm (short bubbles, a typing beat, one reaction), not generated chatter.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Msg, Story, Week } from "@/lib/opinion";
import { K, mix, Ground, TopBar } from "../today/ui";

const AMBER = "#f0a868";
const QUIET_MS = 6000; // how long he can pause after Q1 before Minami asks the follow-up
const NUDGE = ["haha go on.", "ok spicy.", "fair.", "lol okay.", "say more."];
const OPEN = ["ok, {tag} 👀", "{tag}. this one's good", "{tag} 🍿", "ok so, {tag}"];

type Line = { from: "m" | "t"; text: string; react?: string; guess?: boolean; card?: Story; key: string };
type View = "all" | "new" | "yours";

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) >>> 0;
const lockLabel = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** A friend reacts to the line that deserves it — once per story, never on every message. */
function reactionFor(msgs: Msg[]): number {
  const i = msgs.findIndex((m) => !m.guess && /\?\?|!!|\blol\b|haha|come on|wtf|😂/i.test(m.text));
  return i >= 0 ? i : msgs.findIndex((m) => !m.guess && /!$/.test(m.text.trim()));
}

function thread(s: Story): Line[] {
  const n = hash(s.id);
  const out: Line[] = [{ from: "m", text: OPEN[n % OPEN.length].replace("{tag}", s.tag.toLowerCase()), key: "o" },
    { from: "m", text: s.news, key: "n" }, { from: "m", text: "", card: s, key: "c" }, { from: "m", text: s.q[0], key: "q1" }];
  const r = reactionFor(s.messages);
  const mine = (q: 1 | 2) => s.messages.forEach((m, i) => { if (m.q === q) out.push({ from: "t", text: m.text, guess: m.guess,
    react: i === r ? (/!$/.test(m.text) && !/\?\?/.test(m.text) ? "🔥" : "😂") : undefined, key: `t${i}` }); });
  mine(1);
  if (s.asked2) { out.push({ from: "m", text: `${NUDGE[n % NUDGE.length]} ${s.q[1]}`, key: "q2" }); mine(2); }
  return out;
}

export function Opinion() {
  const [stories, setStories] = useState<Story[] | null>(null);
  const [week, setWeek] = useState<Week | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [view, setView] = useState<View>("all");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/opinion", { cache: "no-store" }).then((r) => r.json());
      if (r.error) setErr(r.error); else { setStories(r.stories); setWeek(r.week); setErr(null); }
    } catch { setErr("Couldn't reach the dashboard."); }
  }, []);
  useEffect(() => { load(); }, [load]);
  // ?t=<id> is the open chat, so the phone's back gesture returns to the topics
  useEffect(() => {
    const sync = () => setOpen(new URLSearchParams(location.search).get("t"));
    sync(); window.addEventListener("popstate", sync); return () => window.removeEventListener("popstate", sync);
  }, []);
  const go = (id: string | null) => {
    history.pushState(null, "", id ? `?t=${encodeURIComponent(id)}` : location.pathname);
    setOpen(id);
    if (!id) load(); // back on the list: fresh counts (a lead moved, a take confirmed)
  };

  const post = useCallback(async (body: Record<string, unknown>) => {
    try {
      const r = await fetch("/api/opinion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
      if (r.error) { setErr(r.error); return; }
      setErr(null);
      setStories((xs) => xs && xs.map((x) => x.id === r.story.id ? r.story : body.op === "lead" && body.on && !x.usedIn ? { ...x, lead: false } : x));
      if (body.op === "confirm" || body.op === "reopen" || body.op === "skip") load();
    } catch { setErr("Not saved — couldn't reach the dashboard."); }
  }, [load]);

  const story = stories?.find((s) => s.id === open) ?? null;
  const nextOpen = stories?.find((s) => s.id !== open && !s.confirmed && !s.skipped && week && s.day >= week.fresh)?.id ?? null;

  return (
    <Ground>
      <TopBar title={story ? <button onClick={() => go(null)} className="flex items-center gap-2"><span style={{ color: K.muted }}>←</span> Opinion Reveal</button> : "Opinion Reveal"}
        right={week && <span style={{ color: week.waiting >= week.minTakes ? K.accentBright : AMBER, fontWeight: 700 }}>
          {week.waiting}/{week.minTakes} takes · video {lockLabel(week.nextLock)}</span>} />
      {!stories ? null : story ? (
        <Chat key={story.id} s={story} setLocal={(f) => setStories((xs) => xs && xs.map((x) => x.id === story.id ? f(x) : x))}
          post={post} onNext={() => go(nextOpen)} hasNext={!!nextOpen} err={err} />
      ) : (
        <Topics stories={stories} week={week} view={view} setView={setView} onOpen={go} err={err} />
      )}
    </Ground>
  );
}

// ── the topics ──────────────────────────────────────────────────────────────────────────────────────────────────
function Topics({ stories, week, view, setView, onOpen, err }: { stories: Story[]; week: Week | null; view: View; setView: (v: View) => void; onOpen: (id: string) => void; err: string | null }) {
  const shown = stories.filter((s) => view === "all" ? true : view === "new" ? !s.confirmed && !s.messages.length && !s.skipped : s.confirmed || s.messages.length > 0);
  const days = useMemo(() => {
    const m = new Map<string, Story[]>();
    for (const s of shown) m.set(s.day, [...(m.get(s.day) ?? []), s]);
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [shown]);
  const need = week ? Math.max(0, week.minTakes - week.waiting) : 0;
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 pb-16 sm:px-0">
      {week && (
        <div className="mb-4 rounded-[18px] px-4 py-3.5" style={{ background: mix(need ? AMBER : K.accentBright, 8), border: `1px solid ${mix(need ? AMBER : K.accentBright, 35)}` }}>
          <div className="text-[15px] font-semibold">{need ? `${need} more take${need > 1 ? "s" : ""} and Sunday gets an opinion video` : `${week.waiting} takes waiting · Sunday's video is on`}</div>
          <div className="mt-0.5 text-[13px]" style={{ color: K.muted }}>Pick any story, rant, hit Done. It locks {lockLabel(week.nextLock)}; takes you give after that go into the next one.</div>
        </div>
      )}
      <div className="mb-3 flex gap-1.5">
        {(["all", "new", "yours"] as View[]).map((v) => (
          <button key={v} onClick={() => setView(v)} className="h-[32px] rounded-full px-3.5 text-[13px] font-semibold"
            style={{ background: view === v ? K.accent : "transparent", color: view === v ? "#fff" : K.muted, border: `1px solid ${view === v ? "transparent" : K.line}` }}>
            {v === "all" ? "All" : v === "new" ? "Not answered" : "Yours"}</button>
        ))}
      </div>
      {!stories.length && <p className="mt-10 text-center text-[15px]" style={{ color: K.muted }}>No topics yet — they come from the daily videos, refreshed every morning.</p>}
      {days.map(([day, xs]) => (
        <section key={day} className="mb-5">
          <div className="mb-2 px-1 text-[11px] tracking-[0.08em]" style={{ fontFamily: "var(--today-mono)", color: K.faint }}>
            {new Date(day + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" }).toUpperCase()}
            {week && day < week.fresh ? " · too old for this week's video" : ""}</div>
          <div className="flex flex-col gap-2">
            {xs.map((s) => (
              <button key={s.id} onClick={() => onOpen(s.id)} className="flex items-start gap-3 rounded-[16px] px-4 py-3 text-left transition-transform hover:-translate-y-px"
                style={{ background: K.paper, border: `1px solid ${s.lead && !s.usedIn ? mix(AMBER, 55) : s.confirmed ? mix(K.accentBright, 35) : K.line}`, opacity: s.skipped ? 0.5 : 1 }}>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-2 text-[12px]" style={{ color: K.faint }}>
                    <span className="rounded-full px-2 py-0.5 font-semibold" style={{ background: mix("#fff", 7), color: K.muted }}>{s.tag}</span>
                  </div>
                  <div className="text-[15.5px] font-semibold leading-snug">{s.headline}</div>
                  {s.confirmed && s.take && <div className="mt-1.5 line-clamp-2 text-[13.5px] italic leading-snug" style={{ color: K.muted }}>&ldquo;{s.take}&rdquo;</div>}
                </div>
                <Status s={s} />
              </button>
            ))}
          </div>
        </section>
      ))}
      {err && <p className="mt-3 text-[12.5px]" style={{ color: AMBER }}>{err}</p>}
    </div>
  );
}

function Status({ s }: { s: Story }) {
  const [label, c] = s.usedIn ? [`in ${s.usedIn}`, K.faint] : s.lead && s.confirmed ? ["★ lead", AMBER] : s.confirmed ? ["✓ your take", K.accentBright]
    : s.skipped ? ["skipped", K.faint] : s.messages.length ? ["started", AMBER] : ["", ""];
  return label ? <span className="mt-0.5 flex-none whitespace-nowrap text-[12px] font-semibold" style={{ color: c }}>{label}</span> : <span className="mt-0.5 flex-none text-[16px]" style={{ color: K.faint }}>›</span>;
}

// ── the chat ────────────────────────────────────────────────────────────────────────────────────────────────────
function Chat({ s, setLocal, post, onNext, hasNext, err }: {
  s: Story; setLocal: (f: (x: Story) => Story) => void; post: (b: Record<string, unknown>) => Promise<void>;
  onNext: () => void; hasNext: boolean; err: string | null;
}) {
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const [editing, setEditing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastAct = useRef(Date.now());
  const lines = useMemo(() => thread(s), [s]);
  const q = s.asked2 ? 2 : 1;

  useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight; }, [lines.length, typing, s.take]);

  // The follow-up: once he has said something to Q1 and gone quiet, Minami types for a beat, then asks Q2.
  useEffect(() => {
    if (s.asked2 || s.take || !s.messages.some((m) => m.q === 1)) return;
    const t = setInterval(() => {
      if (Date.now() - lastAct.current < QUIET_MS || document.hidden) return;
      clearInterval(t);
      setTyping(true);
      setTimeout(() => { setTyping(false); setLocal((x) => ({ ...x, asked2: true })); post({ op: "ask2", story: s.id }); }, 1100);
    }, 500);
    return () => clearInterval(t);
  }, [s, post, setLocal]);

  const send = (text = draft, guess = false) => {
    if (!text.trim()) return;
    lastAct.current = Date.now();
    setLocal((x) => ({ ...x, skipped: false, messages: [...x.messages, { text: text.trim(), at: new Date().toISOString(), q, ...(guess ? { guess } : {}) }] }));
    if (!guess) setDraft("");
    post({ op: "say", story: s.id, text, q, guess });
    input.current?.focus();
  };

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col overflow-hidden sm:rounded-[24px]"
      // The shell's own bars (--shell-top / --shell-bottom: the phone's tab bar) come off the height too, or the composer
      // sits under the tab bar on a phone.
      style={{ height: "calc(100dvh - var(--shell-top, 0px) - var(--shell-bottom, 0px) - 92px)", maxHeight: 900, background: mix(K.bg, 92), border: `1px solid ${K.line}` }}>
      <div className="flex flex-none items-center gap-3 px-4 py-3 sm:px-5" style={{ borderBottom: `1px solid ${K.line}` }}>
        <span className="grid h-9 w-9 flex-none place-items-center rounded-full font-bold" style={{ background: `linear-gradient(135deg, ${K.accentBright}, ${K.cat6})` }}>M</span>
        <div className="min-w-0 flex-1">
          <div className="text-[15.5px] font-semibold">Minami</div>
          <div className="truncate text-[12px]" style={{ color: K.faint }}>{s.tag} · {s.dayLabel}</div>
        </div>
      </div>

      <div ref={box} className="flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto px-4 py-4 sm:px-5" style={{ scrollbarWidth: "none" }}>
        {lines.map((l, i) => {
          if (l.card) return (
            <div key={l.key} className="mb-1.5 max-w-[86%] self-start rounded-[16px] px-3.5 py-3 sm:max-w-[78%]" style={{ background: K.paper, border: `1px solid ${K.line}` }}>
              <div className="mb-1.5 flex items-center gap-2 text-[12px]" style={{ color: K.faint }}>
                <span className="rounded-full px-2 py-0.5 font-semibold" style={{ background: mix("#fff", 7), color: K.muted }}>{l.card.tag}</span>{l.card.dayLabel}
              </div>
              <div className="text-[15.5px] font-semibold leading-snug">{l.card.headline}</div>
              <div className="mt-1 text-[13.5px] leading-relaxed" style={{ color: K.muted }}>{l.card.fact}</div>
            </div>
          );
          const tail = lines[i + 1]?.from !== l.from || !!lines[i + 1]?.card;
          const me = l.from === "t";
          return (
            <div key={l.key} className={`relative max-w-[84%] px-3.5 py-2 text-[15.5px] leading-[1.4] sm:max-w-[72%] ${me ? "self-end" : "self-start"} ${tail ? "mb-2.5" : ""}`}
              // One shorthand, never shorthand + a corner: when the next bubble arrives the tail moves, and React
              // removing a lone corner property beside the shorthand left the old corner square.
              style={{ borderRadius: !tail ? 20 : me ? "20px 20px 6px 20px" : "20px 20px 20px 6px",
                background: me ? K.accent : "#232832", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {l.text}
              {l.guess && <span className="ml-1.5 text-[11px]" style={{ color: "rgba(255,255,255,.65)" }}>· my guess</span>}
              {l.react && <span className="absolute -bottom-2.5 -left-3 rounded-full px-1 text-[14px]" style={{ background: "#232832", border: `2px solid ${K.bg}` }}>{l.react}</span>}
            </div>
          );
        })}
        {typing && <div className="mb-2 self-start rounded-[20px] px-4 py-2.5 text-[18px] leading-none tracking-[3px]" style={{ background: "#232832", color: K.faint }}>•••</div>}
        {!s.take && !s.skipped && s.messages.length > 0 && (
          <div className="-mt-1 self-end text-[12px]" style={{ color: K.faint }}>{s.messages.length} message{s.messages.length > 1 ? "s" : ""} · keep going, or wrap it up</div>
        )}
        {s.skipped && <div className="mt-2 self-center text-[13px]" style={{ color: K.faint }}>skipped · <button className="underline" onClick={() => post({ op: "skip", story: s.id, on: false })}>bring it back</button></div>}
        {s.take && (<>
          <div className="mb-2.5 self-start rounded-[20px] px-3.5 py-2 text-[15.5px]" style={{ background: "#232832", borderRadius: "20px 20px 20px 6px" }}>
            {s.usedIn ? `this one went into the ${s.usedIn} video ✓` : s.confirmed ? "got it ✓" : "love it. here's your take, your words, nothing added:"}
          </div>
          <div className="mt-1 self-stretch rounded-[18px] px-4 py-4" style={{ background: mix(K.accentBright, 8), border: `1px solid ${mix(K.accentBright, 35)}` }}>
            <div className="text-[12px]" style={{ color: K.faint }}>Your take · {s.tag}{s.lead ? " · ★ leads the video" : ""}</div>
            {editing ? (
              <EditTake initial={s.take} onSave={(t) => { setEditing(false); post({ op: "edit", story: s.id, take: t }); }} onCancel={() => setEditing(false)} />
            ) : <div className="mt-1.5 text-[17px] font-semibold leading-[1.45]">{s.take}</div>}
            {!editing && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {!s.confirmed && <Pill on onClick={() => post({ op: "confirm", story: s.id })}>Sounds like me</Pill>}
                {!s.usedIn && <Pill onClick={() => setEditing(true)}>Edit</Pill>}
                {!s.confirmed && <Pill onClick={() => post({ op: "reopen", story: s.id })}>Keep ranting</Pill>}
                {s.usedIn && <Pill onClick={() => post({ op: "reopen", story: s.id })}>New take</Pill>}
                {!s.usedIn && <Pill amber on={s.lead} onClick={() => post({ op: "lead", story: s.id, on: !s.lead })}>★ {s.lead ? "Leads the video" : "Lead the video"}</Pill>}
                <span className="flex-1" />
                {s.confirmed && <Pill solid onClick={onNext}>{hasNext ? "Next topic →" : "Back to topics"}</Pill>}
              </div>
            )}
          </div>
        </>)}
      </div>

      {!s.take && !s.skipped && (
        <div className="flex-none px-3 pb-3 pt-2.5 sm:px-4" style={{ borderTop: `1px solid ${K.line}` }}>
          <div className="mb-2.5 flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
            <span className="text-[12px]" style={{ color: K.faint }}>stuck?</span>
            <button onClick={() => send(s.guess, true)} className="min-w-0 truncate rounded-full px-3 py-1 text-[12.5px]" style={{ border: `1px solid ${K.line}`, color: K.muted }}>my guess: &ldquo;{s.guess}&rdquo;</button>
            <button onClick={() => post({ op: "skip", story: s.id, on: true }).then(onNext)} className="flex-none rounded-full px-3 py-1 text-[12.5px]" style={{ border: `1px solid ${K.line}`, color: K.muted }}>skip this one</button>
          </div>
          <div className="flex items-end gap-2">
            <textarea ref={input} rows={1} value={draft} placeholder="rant away…" title="Enter sends — keep sending, then Done ranting" autoFocus
              onChange={(e) => { setDraft(e.target.value); lastAct.current = Date.now(); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
              className="min-h-[42px] min-w-0 flex-1 resize-none rounded-[21px] px-4 py-[10px] text-[15px] leading-[1.4] outline-none"
              style={{ background: "#1b1f27", border: `1px solid ${K.line}`, color: K.ink, maxHeight: 140 }} />
            <button aria-label="Send" onClick={() => send()} className="grid h-[42px] w-[42px] flex-none place-items-center rounded-full text-[18px] font-bold" style={{ background: K.accent }}>↑</button>
            <button disabled={!s.messages.length} onClick={() => post({ op: "wrap", story: s.id })}
              className="h-[42px] flex-none whitespace-nowrap rounded-full px-3.5 text-[14px] font-bold disabled:opacity-40 sm:px-4"
              style={{ background: AMBER, color: "#14171d" }}>Done ranting ✓</button>
          </div>
        </div>
      )}
      {err && <div className="flex-none px-4 py-2 text-[12.5px]" style={{ color: AMBER, borderTop: `1px solid ${K.line}` }}>{err}</div>}
    </div>
  );
}

function Pill({ children, on, amber, solid, onClick }: { children: React.ReactNode; on?: boolean; amber?: boolean; solid?: boolean; onClick: () => void }) {
  const bg = solid ? K.accent : on ? (amber ? AMBER : K.accent) : "transparent";
  return (
    <button onClick={onClick} className="h-[34px] whitespace-nowrap rounded-full px-3.5 text-[13.5px] font-semibold"
      style={{ background: bg, color: on && amber ? "#14171d" : on || solid ? "#fff" : amber ? "#f0c49b" : K.muted,
        border: `1px solid ${on || solid ? "transparent" : amber ? mix(AMBER, 45) : K.line}` }}>{children}</button>
  );
}

function EditTake({ initial, onSave, onCancel }: { initial: string; onSave: (t: string) => void; onCancel: () => void }) {
  const [t, setT] = useState(initial);
  return (
    <div className="mt-2">
      <textarea value={t} onChange={(e) => setT(e.target.value)} rows={3} autoFocus className="w-full resize-y rounded-[12px] px-3 py-2 text-[16px] leading-[1.45] outline-none"
        style={{ background: "rgba(0,0,0,.3)", border: `1px solid ${K.line2}`, color: K.ink }} />
      <div className="mt-2 flex gap-2"><Pill solid onClick={() => onSave(t)}>Save</Pill><Pill onClick={onCancel}>Cancel</Pill></div>
    </div>
  );
}
