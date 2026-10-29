"use client";
// Opinion Reveal (§38): the weekly interview as "ranting to a friend" (pitch opinion-interview V2, picked 2026-10-29).
// Minami texts like a friend — the news, then a question — and Thomas fires off as many short messages as he likes.
// When he goes quiet after the first question, Minami follows up with the second; "Done ranting" wraps his messages
// into the take (his words joined, nothing added: lib/opinion.ts joinTake). Everything is written to Video Studio's
// interview.json as he types, so a closed tab loses nothing.
//
// Minami's side is deliberately scripted, not a model: the questions were drafted on Friday, and a reply that
// invented an opinion back at him would leak into what he says. The friend feel comes from the rhythm (short
// bubbles, a typing beat, a reaction), not from generated chatter.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Interview, Msg, Story } from "@/lib/opinion";
import { K, mix, Ground, TopBar } from "../today/ui";

const AMBER = "#f0a868";
const QUIET_MS = 6000; // how long he can pause after Q1 before Minami asks the follow-up
const NUDGE = ["haha go on.", "ok spicy.", "fair.", "lol okay.", "say more."];
const OPEN = ["ok story {n} 👀", "next one. story {n}", "story {n}, this one's good", "story {n} 🍿", "last-ish. story {n}"];

type Line = { from: "m" | "t"; text: string; react?: string; guess?: boolean; card?: Story; key: string };

function left(closes: string) {
  const ms = Date.parse(closes) - Date.now();
  if (ms <= 0) return "closed";
  const h = Math.floor(ms / 36e5);
  return h >= 1 ? `${h} h left` : `${Math.max(1, Math.round(ms / 6e4))} min left`;
}

/** A friend reacts to the line that deserves it — once per story, never on every message. */
function reactionFor(msgs: Msg[]): number {
  const i = msgs.findIndex((m) => !m.guess && /\?\?|!!|\blol\b|haha|come on|wtf|😂/i.test(m.text));
  return i >= 0 ? i : msgs.findIndex((m) => !m.guess && /!$/.test(m.text.trim()));
}

function thread(s: Story, n: number, total: number): Line[] {
  const out: Line[] = [];
  const opener = n === 0 ? `hey! ${total} stories from this week. rant time 😤` : OPEN[n % OPEN.length].replace("{n}", String(n + 1));
  out.push({ from: "m", text: opener, key: "o" }, { from: "m", text: s.news, key: "n" }, { from: "m", text: "", card: s, key: "c" },
    { from: "m", text: s.q[0], key: "q1" });
  const r = reactionFor(s.messages);
  const mine = (q: 1 | 2) => s.messages.map((m, i) => ({ m, i })).filter(({ m }) => m.q === q)
    .forEach(({ m, i }) => out.push({ from: "t", text: m.text, guess: m.guess, react: i === r ? (/!$/.test(m.text) && !/\?\?/.test(m.text) ? "🔥" : "😂") : undefined, key: `t${i}` }));
  mine(1);
  if (s.asked2) { out.push({ from: "m", text: `${NUDGE[n % NUDGE.length]} ${s.q[1]}`, key: "q2" }); mine(2); }
  return out;
}

export function Opinion() {
  const [iv, setIv] = useState<Interview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [, tick] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastAct = useRef(Date.now());

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/opinion", { cache: "no-store" }).then((r) => r.json());
      if (r.error) setErr(r.error); else { setIv(r.interview); setErr(null); }
    } catch { setErr("Couldn't reach the dashboard."); }
    setLoaded(true);
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 60_000); return () => clearInterval(t); }, []);

  const post = useCallback(async (body: Record<string, unknown>) => {
    if (!iv) return;
    try {
      const r = await fetch("/api/opinion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ week: iv.week, ...body }) }).then((r) => r.json());
      if (r.error) setErr(r.error); else { setIv(r.interview); setErr(null); }
    } catch { setErr("Not saved — couldn't reach the dashboard."); }
  }, [iv]);

  const stories = iv?.stories ?? [];
  const settled = (s: Story) => s.confirmed || s.skipped;
  const firstOpen = stories.findIndex((s) => !settled(s));
  const idx = at ?? (firstOpen < 0 ? stories.length : firstOpen);
  const s = stories[idx] as Story | undefined;
  const open = iv?.status === "open";
  const lines = useMemo(() => (s ? thread(s, idx, stories.length) : []), [s, idx, stories.length]);
  const q = s?.asked2 ? 2 : 1;

  useEffect(() => { const b = box.current; if (b) b.scrollTop = b.scrollHeight; }, [lines.length, typing, s?.take, idx]);

  // The follow-up: once he has said something to Q1 and gone quiet, Minami types for a beat, then asks Q2.
  useEffect(() => {
    if (!open || !s || s.asked2 || s.take || !s.messages.some((m) => m.q === 1)) return;
    const t = setInterval(() => {
      if (Date.now() - lastAct.current < QUIET_MS || document.hidden) return;
      clearInterval(t);
      setTyping(true);
      setTimeout(() => { setTyping(false); post({ op: "ask2", story: s.id }); }, 1100);
    }, 500);
    return () => clearInterval(t);
  }, [open, s, post]);

  const send = (text = draft, guess = false) => {
    if (!s || !text.trim()) return;
    lastAct.current = Date.now();
    setIv((v) => v && { ...v, stories: v.stories.map((x) => x.id === s.id ? { ...x, skipped: false, messages: [...x.messages, { text: text.trim(), at: new Date().toISOString(), q, ...(guess ? { guess } : {}) }] } : x) });
    if (!guess) setDraft("");
    post({ op: "say", story: s.id, text, q, guess });
    input.current?.focus();
  };
  const next = () => { setAt(null); setEditing(null); };

  if (!loaded) return <Ground><TopBar title="Opinion Reveal" /></Ground>;
  if (!iv) return (
    <Ground><TopBar title="Opinion Reveal" />
      <div className="mx-auto mt-16 max-w-[520px] px-6 text-center" style={{ color: K.muted }}>
        <p className="text-[19px] font-semibold" style={{ color: K.ink }}>No interview yet</p>
        <p className="mt-2 text-[15px] leading-relaxed">Friday 14:00 the week&apos;s AI stories land here as a chat. Rant about them; Saturday noon it closes and the night makes the VI and EN opinion video from your words.</p>
        {err && <p className="mt-4 text-[13px]" style={{ color: AMBER }}>{err}</p>}
      </div>
    </Ground>
  );

  const takes = stories.filter((x) => x.confirmed && !x.skipped);
  const done = idx >= stories.length;

  return (
    <Ground>
      <TopBar title="Opinion Reveal" right={<span style={{ color: open ? AMBER : K.faint, fontWeight: 700 }}>{open ? left(iv.closes) : iv.status === "locked" ? "locked · video coming" : "closed · no video this week"}</span>} />
      <div className="mx-auto flex w-full max-w-[760px] flex-col overflow-hidden sm:rounded-[24px]"
        // The shell's own bars (--shell-top / --shell-bottom: the phone's tab bar) come off the height too, or the composer
        // sits under the tab bar on a phone.
        style={{ height: "calc(100dvh - var(--shell-top, 0px) - var(--shell-bottom, 0px) - 92px)", maxHeight: 900, background: mix(K.bg, 92), border: `1px solid ${K.line}` }}>
        {/* header: who you're talking to, how far you are */}
        <div className="flex flex-none items-center gap-3 px-4 py-3 sm:px-5" style={{ borderBottom: `1px solid ${K.line}` }}>
          <span className="grid h-9 w-9 flex-none place-items-center rounded-full font-bold" style={{ background: `linear-gradient(135deg, ${K.accentBright}, ${K.cat6})` }}>M</span>
          <div className="min-w-0 flex-1">
            <div className="text-[15.5px] font-semibold">Minami</div>
            <div className="truncate text-[12px]" style={{ color: K.faint }}>{iv.week} · {iv.range} · {done ? "all done" : `story ${idx + 1} of ${stories.length}`}</div>
          </div>
          <div className="flex gap-1.5">
            {stories.map((x, i) => (
              <button key={x.id} aria-label={`Story ${i + 1}: ${x.tag}`} title={x.tag} onClick={() => { setAt(i); setEditing(null); }}
                className="h-[6px] rounded-full transition-all" style={{ width: i === idx ? 26 : 16,
                  background: i === idx ? "#fff" : x.skipped ? K.line2 : x.confirmed ? (x.lead ? AMBER : K.accentBright) : mix("#fff", 14) }} />
            ))}
          </div>
        </div>

        {/* the thread */}
        <div ref={box} className="flex min-h-0 flex-1 flex-col gap-[3px] overflow-y-auto px-4 py-4 sm:px-5" style={{ scrollbarWidth: "none" }}>
          {done ? <Summary iv={iv} takes={takes} onOpen={(i) => setAt(i)} /> : s && (<>
            {lines.map((l, i) => {
              if (l.card) return (
                <div key={l.key} className="mb-1.5 max-w-[86%] self-start rounded-[16px] px-3.5 py-3 sm:max-w-[78%]" style={{ background: K.paper, border: `1px solid ${K.line}` }}>
                  <div className="mb-1.5 flex items-center gap-2 text-[12px]" style={{ color: K.faint }}>
                    <span className="rounded-full px-2 py-0.5 font-semibold" style={{ background: mix("#fff", 7), color: K.muted }}>{l.card.tag}</span>{l.card.day}
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
            {!s.take && !s.skipped && s.messages.length > 0 && open && (
              <div className="-mt-1 self-end text-[12px]" style={{ color: K.faint }}>{s.messages.length} message{s.messages.length > 1 ? "s" : ""} · keep going, or wrap it up</div>
            )}
            {s.skipped && <div className="mt-2 self-center text-[13px]" style={{ color: K.faint }}>skipped · <button className="underline" onClick={() => post({ op: "skip", story: s.id, on: false })}>bring it back</button></div>}
            {s.take && (<>
              <div className="mb-2.5 self-start rounded-[20px] px-3.5 py-2 text-[15.5px]" style={{ background: "#232832", borderBottomLeftRadius: 6 }}>
                {s.confirmed ? "got it ✓" : "love it. here's your take, your words, nothing added:"}
              </div>
              <div className="mt-1 self-stretch rounded-[18px] px-4 py-4" style={{ background: mix(K.accentBright, 8), border: `1px solid ${mix(K.accentBright, 35)}` }}>
                <div className="text-[12px]" style={{ color: K.faint }}>Your take · {s.tag}{s.lead ? " · ★ leads the video" : ""}</div>
                {editing === s.id ? (
                  <EditTake initial={s.take} onSave={(t) => { setEditing(null); post({ op: "edit", story: s.id, take: t }); }} onCancel={() => setEditing(null)} />
                ) : <div className="mt-1.5 text-[17px] font-semibold leading-[1.45]">{s.take}</div>}
                {open && editing !== s.id && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {/* Pin the story first: once confirmed it is "settled", and the default view jumps to the next
                        open one — which hid "got it ✓" and the ★ before he could lead with this take. */}
                    {!s.confirmed && <Pill on onClick={() => { setAt(idx); post({ op: "confirm", story: s.id }); }}>Sounds like me</Pill>}
                    <Pill onClick={() => setEditing(s.id)}>Edit</Pill>
                    {!s.confirmed && <Pill onClick={() => post({ op: "reopen", story: s.id })}>Keep ranting</Pill>}
                    <Pill amber on={s.lead} onClick={() => post({ op: "lead", story: s.id, on: !s.lead })}>★ {s.lead ? "Leads the video" : "Lead the video"}</Pill>
                    <span className="flex-1" />
                    {s.confirmed && <Pill solid onClick={next}>{firstOpen < 0 ? "Finish →" : "Next story →"}</Pill>}
                  </div>
                )}
              </div>
            </>)}
          </>)}
        </div>

        {/* the dock: suggestions + composer + the finish button */}
        {open && s && !done && !s.take && !s.skipped && (
          <div className="flex-none px-3 pb-3 pt-2.5 sm:px-4" style={{ borderTop: `1px solid ${K.line}` }}>
            <div className="mb-2.5 flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
              <span className="text-[12px]" style={{ color: K.faint }}>stuck?</span>
              <button onClick={() => send(s.guess, true)} className="min-w-0 truncate rounded-full px-3 py-1 text-[12.5px]" style={{ border: `1px solid ${K.line}`, color: K.muted }}>my guess: &ldquo;{s.guess}&rdquo;</button>
              <button onClick={() => post({ op: "skip", story: s.id, on: true }).then(next)} className="flex-none rounded-full px-3 py-1 text-[12.5px]" style={{ border: `1px solid ${K.line}`, color: K.muted }}>skip this one</button>
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
    </Ground>
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

function Summary({ iv, takes, onOpen }: { iv: Interview; takes: Story[]; onOpen: (i: number) => void }) {
  const enough = takes.length >= iv.minTakes;
  return (
    <div className="flex flex-col gap-3">
      <div className="self-start rounded-[20px] px-3.5 py-2 text-[15.5px]" style={{ background: "#232832", borderBottomLeftRadius: 6 }}>
        {enough ? `that's the week 🙌 ${takes.length} takes. the night turns them into the VI + EN video.` : `${takes.length} take${takes.length === 1 ? "" : "s"} so far — ${iv.minTakes} make a video. any of the skipped ones worth a rant?`}
      </div>
      {iv.stories.map((x, i) => (
        <button key={x.id} onClick={() => onOpen(i)} className="rounded-[16px] px-4 py-3 text-left" style={{ background: K.paper, border: `1px solid ${x.lead ? mix(AMBER, 55) : K.line}`, opacity: x.skipped ? 0.55 : 1 }}>
          <div className="text-[12px]" style={{ color: K.faint }}>{x.lead ? "★ " : ""}{x.tag} · {x.skipped ? "skipped" : x.confirmed ? "your take" : "open"}</div>
          {x.take && !x.skipped && <div className="mt-1 text-[15px] font-semibold leading-snug">{x.take}</div>}
        </button>
      ))}
      <div className="text-center text-[12.5px]" style={{ color: K.faint }}>You can change any take until it closes ({new Date(iv.closes).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}).</div>
    </div>
  );
}
