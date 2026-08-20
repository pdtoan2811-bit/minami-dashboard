"use client";
// THE CONTROL DOCK — what anh can click while the call is running.
//
// UI copy is ENGLISH; the spoken command templates are shown in BOTH languages, because the parser
// accepts either and anh code-switches mid-sentence. The chrome he reads and the words he says are
// two different audiences.
//
// Rebuilt after anh's verdict on the first version: "not a great UI UX, especially with handling data
// and nodes, which need accuracy and confirmation and redo". That was right. Version one fired every
// mutation the instant it was clicked, showed a toast, and offered a single blunt "undo last". For
// text on a screen a customer is watching, that is not enough — a rename rewrote cards with no way to
// see what it would touch, and there was no way back once undo had been used.
//
// Three things changed, one per use case anh gave:
//
//   1. COMMANDS CARRY THEIR SPOKEN FORM. Every command shows the Vietnamese sentence that triggers it
//      by voice. Anh asked to "send actual text command or templates for me to speak on" — so the
//      dock teaches the phrasing rather than hiding it. Click ▸ to run it now, or read it and say it.
//
//   2. THÊM THẺ TAKES BOTH INPUTS AT ONCE. Voice is the default because it is faster and anh is
//      talking anyway; the text field sits right beside it, live, for the times the ear is the thing
//      failing. Neither is a mode you have to switch into.
//
//   3. SỬA TÊN PREVIEWS BEFORE IT COMMITS. The server dry-runs the rename and returns exactly which
//      cards change and how. The rename is case-insensitive and matches inside words, so "AI" can
//      quietly rewrite the middle of another word — a preview turns that from an accident into a
//      decision.
//
// Undo AND redo, because undo without redo is its own trap: anh undoes to check something, and the
// card is gone for good.
//
// Still hidden until the pointer nears the bottom — this tab is screen-shared, so permanent chrome is
// chrome for the whole room.

import { useEffect, useRef, useState } from "react";

type Panel = null | "add" | "rename" | "say" | "voice" | "ear" | "react";

type Preview = { matches: number; cards: Array<{ id: string; before: string; after: string }> } | null;

const KINDS = [
  { kind: "note", label: "Note", icon: IconNote },
  { kind: "decision", label: "Decision", icon: IconCheck },
  { kind: "action", label: "Action", icon: IconArrow },
  { kind: "question", label: "Question", icon: IconAsk },
] as const;

/** The spoken form of every command, so the dock doubles as the phrasebook. Anh should never have to
 *  remember wording — the thing he clicks tells him what to say next time. */
const SAY = [
  { say: "Minami, new topic: …", vi: "Minami, chủ đề mới: …", does: "Start a new topic on the board" },
  { say: "Minami, note that …", vi: "Minami, ghi lại: …", does: "Capture a note word for word" },
  { say: "Minami, decision …", vi: "Minami, chốt: …", does: "Record a decision" },
  { say: "Minami, action …", vi: "Minami, việc cần làm: …", does: "Record something to do" },
  { say: "Minami, question …", vi: "Minami, câu hỏi: …", does: "Record an open question" },
  { say: "Minami, not X but Y", vi: "Minami, không phải X mà là Y", does: "Fix a misheard name" },
  { say: "Minami, undo", vi: "Minami, bỏ cái vừa rồi", does: "Remove the last card" },
  { say: "Minami, tidy", vi: "Minami, dọn lại", does: "Group and clean up the board" },
];

/** THE EARS, and what each is actually for.
 *
 *  These are two different acoustic problems, not two settings:
 *
 *  ENGLISH-ONLY — the easy case. Almost anything transcribes clean read English; the differentiators
 *  are latency and price. gpt-4o-mini-transcribe was measured correct on this voice at $0.084/hr.
 *
 *  VIETNAMESE + ENGLISH TERMS — the hard case, and the one every model tested so far has failed in a
 *  different way. Measured on anh's own recordings:
 *    qwen3-asr-flash   fluent Vietnamese, DESTROYS terminology — "second brain" → "single brand",
 *                      "CLAUDE.md" → "cloud md" — and emitted Chinese/Japanese on 7 lines of 203
 *    blaze            flawless Vietnamese on synthetic speech, hallucination loops on the real voice
 *    whisper-large-v3 corrupted the Vietnamese itself ("không trần" for "không chuẩn")
 *    chirp-3          invented product names; TRANSLATES instead of transcribing without a language pin
 *
 *  ⚠️ NOTHING HERE IS A WINNER YET on the hard case. The list exists so anh can switch WHILE the
 *  failure is happening instead of discovering it in the archive — that is the honest state of it. */
const EARS = [
  { id: "", lang: undefined as string | undefined, label: "Default", note: "whatever .env says" },
  { id: "openai/whisper-large-v3", lang: "", label: "English", note: "English-only. 99 languages, accent-robust — anh's pick for EN calls" },
  { id: "omni:google/gemini-3-flash-preview", lang: undefined, label: "VI + EN terms ★", note: "omni LLM, INSTRUCTED to keep English terms — 8/10 terms vs whisper's 4/10" },
  { id: "omni:openai/gpt-audio-mini", lang: undefined, label: "VI + EN alt", note: "same trick, second opinion when gemini drifts" },
  { id: "qwen/qwen3-asr-flash-2026-02-10", lang: "vi", label: "VI fluent", note: "smoothest Vietnamese, mangles terminology; pin stops CJK drift" },
  { id: "openai/gpt-4o-mini-transcribe", lang: "", label: "Cheap EN", note: "$0.084/hr, measured correct on this voice" },
];

export function CommandDock() {
  const [near, setNear] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [kind, setKind] = useState<string>("note");
  const [text, setText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [universal, setUniversal] = useState(false);
  const [preview, setPreview] = useState<Preview>(null);
  const [flash, setFlash] = useState<{ msg: string; bad?: boolean } | null>(null);
  const [armed, setArmed] = useState(0);
  const [canRedo, setCanRedo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cmdText, setCmdText] = useState("");
  const [ear, setEar] = useState<string>("");
  /** The dictionary as it stands, so a correction is edited rather than guessed at. */
  /** Optimistic, corrected by the server's reply. The board is the source of truth (graph.memes);
   *  this only drives the button's own look. */
  const [memesOn, setMemesOn] = useState(true);
  const [dict, setDict] = useState<{ universal: { from: string; to: string }[]; call: { from: string; to: string }[] } | null>(null);
  const [room, setRoom] = useState(false);
  const [roster, setRoster] = useState<string[]>([]);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onMove = (e: MouseEvent) => setNear(e.clientY > window.innerHeight - 210);
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);
  useEffect(() => { if (panel) first.current?.focus(); }, [panel]);
  useEffect(() => {
    if (!armed) return;
    const t = setInterval(() => setArmed((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => clearInterval(t);
  }, [armed]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2800);
    return () => clearTimeout(t);
  }, [flash]);

  async function call(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch("/api/canvas/control", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        setFlash({ msg: d?.error === "no live meeting" ? "No call is running yet" : `Failed: ${d?.error ?? res.status}`, bad: true });
        return null;
      }
      return d;
    } catch {
      setFlash({ msg: "Could not reach Minami", bad: true });
      return null;
    } finally { setBusy(false); }
  }

  /** Voice: arm the window, then say it. Kept beside the text field rather than behind a toggle —
   *  anh asked for both inputs at once, and a mode switch is the thing that makes people pick one. */
  async function listen(seconds = 15) {
    setArmed(seconds);
    const d = await call({ action: "listen", seconds });
    if (!d) { setArmed(0); return; }
    setFlash({ msg: `Listening — say your command within ${seconds}s` });
  }

  /** Abort has to be as cheap as arming. Without it, clicking Listen and changing your mind means the
   *  next thing said to a CUSTOMER gets parsed as a command and put on the shared board. */
  async function abort() {
    setArmed(0);
    await call({ action: "cancel" });
    setFlash({ msg: "Voice command cancelled" });
  }

  /** Typed commands run the same grammar and the same applier as spoken ones — "new topic: Pricing"
   *  types exactly as it speaks. */
  async function runTyped() {
    if (!cmdText.trim()) return;
    const d = await call({ action: "command", text: cmdText.trim() });
    if (!d) return;
    setFlash({ msg: `Ran: ${d.detail ?? d.ran}` });
    setCmdText("");
  }

  async function addCard() {
    if (!text.trim()) return;
    const d = await call({ action: "card", kind, text: text.trim() });
    if (!d) return;
    setFlash({ msg: `Added: ${text.trim().slice(0, 40)}` });
    setText("");
  }

  /** Loaded when the panel opens, not on mount: it is a real read of a file on every call, and the
   *  dock is mounted for the whole meeting. */
  async function toggleMemes() {
    const d = await call({ action: "memes", on: !memesOn });
    if (!d) return;
    setMemesOn(d.memes !== false);
    setFlash({ msg: d.memes !== false ? "Memes on" : "Memes off — cut scenes stay as emoji" });
  }

  /** ⚠️ ATTACHES TO THE NEWEST CARD, and says which one. The judge marks about one card in six and
   *  is reading text — it cannot hear the room, or know that the thing just agreed took three weeks.
   *  Anh can. Naming the card in the flash is what stops this feeling like it fired into the void. */
  async function react(emoji: string) {
    const d = await call({ action: "react", emoji });
    if (!d) return;
    setFlash({ msg: `${emoji}  ${String(d.card ?? "").slice(0, 44)}` });
    setPanel(null);
  }

  async function loadDict() {
    const d = await call({ action: "dictionary" });
    if (d) setDict({ universal: d.universal ?? [], call: d.call ?? [] });
  }

  async function runPreview() {
    if (!from.trim() || !to.trim()) return;
    const d = await call({ action: "fix", from: from.trim(), to: to.trim(), preview: true });
    if (d) setPreview({ matches: d.matches ?? 0, cards: d.cards ?? [] });
  }

  async function commitRename() {
    const d = await call({ action: "fix", from: from.trim(), to: to.trim(), scope: universal ? "universal" : "call" });
    if (!d) return;
    const n = Array.isArray(d.froms) ? d.froms.length : 1;
    setFlash({ msg: `${n > 1 ? `${n} spellings → ` : ""}${d.to} · ${d.cardsUpdated} card(s)${universal ? " · saved for future calls" : " · this call only"}` });
    setFrom(""); setTo(""); setPreview(null); setPanel(null);
  }

  const shown = near || panel !== null || armed > 0 || flash !== null;

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-2 pb-6 transition-all duration-300"
      style={{ opacity: shown ? 1 : 0, transform: shown ? "none" : "translateY(12px)", pointerEvents: shown ? "auto" : "none" }}
    >
      {flash ? (
        <div
          className="flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] font-medium text-white shadow-lg backdrop-blur"
          style={{ background: flash.bad ? "rgba(190,42,42,0.94)" : "rgba(17,24,39,0.92)" }}
        >
          {flash.bad ? <IconWarn /> : <IconCheck />} {flash.msg}
        </div>
      ) : null}

      {/* ── NÓI GÌ ĐỂ RA LỆNH — the phrasebook ─────────────────────────────────────────────── */}
      {panel === "say" ? (
        <Sheet title="What to say" sub="Read the phrase and say it, or hit ▸ to open the mic now" onClose={() => setPanel(null)}>
          <div className="max-h-[280px] w-[460px] overflow-y-auto pr-1">
            {SAY.map((c) => (
              <div key={c.say} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-neutral-50">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12.5px] text-neutral-800">{c.say}</div>
                  <div className="truncate font-mono text-[12px] text-neutral-500">{c.vi}</div>
                  <div className="truncate text-[12px] text-neutral-400">{c.does}</div>
                </div>
                <button
                  onClick={() => { setPanel("voice"); listen(20); }}
                  title="Open the mic and say this"
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-neutral-600 hover:bg-neutral-200"
                >▸ say it</button>
              </div>
            ))}
          </div>
        </Sheet>
      ) : null}

      {/* ── EAR — which model is listening, switchable mid-call ─────────────────────────────── */}
      {panel === "ear" ? (
        <Sheet title="Which ear is listening" sub="Takes effect on the next chunk · this meeting only" onClose={() => setPanel(null)}>
          <div className="w-[520px]">
            {EARS.map((e) => (
              <button
                key={e.label}
                onClick={async () => {
                  // lang must travel as null, not undefined — JSON.stringify drops undefined keys,
                  // so an undefined lang could never clear a previously pinned one.
                  const d = await call({ action: "ear", model: e.id, lang: e.lang ?? null });
                  if (d) { setEar(e.label); setFlash({ msg: `Ear → ${e.label}${e.lang ? ` (${e.lang})` : ""}` }); }
                }}
                className="flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-neutral-50"
              >
                <span
                  className="mt-0.5 inline-block size-2 shrink-0 rounded-full"
                  style={{ background: ear === e.label ? "#0f9d6e" : "#d4d4d4" }}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-neutral-900">
                    {e.label}{e.lang ? <span className="ml-1.5 font-normal text-neutral-400">{e.lang}</span> : null}
                  </span>
                  <span className="block truncate text-[12px] text-neutral-500">{e.note}</span>
                </span>
              </button>
            ))}
            <div className="mt-2 border-t border-neutral-200 pt-2 text-[11.5px] leading-4 text-neutral-500">
              ★ measured on ONE synthetic clip, not anh's real voice — the same evidence that wrongly
              promoted Blaze. Switch while it is failing rather than finding out from the archive.
            </div>
          </div>
        </Sheet>
      ) : null}

      {/* ── VOICE COMMAND — armed mic, an abort, and a typed field in parallel ──────────────── */}
      {panel === "voice" ? (
        <Sheet title="Voice command" sub="Speak it, or type the same command — either works" onClose={() => { setPanel(null); if (armed) abort(); }}>
          <div className="w-[520px]">
            <div className="flex items-center gap-2">
              {armed > 0 ? (
                <>
                  <span
                    className="flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-semibold text-white"
                    style={{ background: "#b45309" }}
                  >
                    <IconMic /> Listening {armed}s
                  </span>
                  <button
                    onClick={abort}
                    className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[13px] font-semibold text-red-700 hover:bg-red-100"
                  >Cancel</button>
                </>
              ) : (
                <button
                  onClick={() => listen(20)}
                  className="flex items-center gap-1.5 rounded-lg bg-neutral-100 px-3 py-2 text-[13px] font-semibold text-neutral-800 hover:bg-neutral-200"
                >
                  <IconMic /> Start listening
                </button>
              )}
              <span className="text-[12px] text-neutral-400">or</span>
              <input
                ref={first}
                value={cmdText}
                onChange={(e) => setCmdText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") runTyped(); if (e.key === "Escape") { setPanel(null); if (armed) abort(); } }}
                placeholder="type a command — e.g. new topic: Pricing"
                className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[14px] text-neutral-900 placeholder:text-neutral-400 outline-none focus:border-neutral-500"
              />
              <button
                onClick={runTyped}
                disabled={!cmdText.trim() || busy}
                className="shrink-0 rounded-lg px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
                style={{ background: "#111827" }}
              >Run</button>
            </div>
            <div className="mt-2 text-[12px] text-neutral-500">
              new topic: … · note that … · decision … · action … · question … · not X but Y · undo · tidy
            </div>
          </div>
        </Sheet>
      ) : null}

      {/* ── ADD CARD — voice and text side by side ──────────────────────────────────────────── */}
      {panel === "react" ? (
        <Sheet title="Mark this moment" sub="Plays a cut scene on the newest card" onClose={() => setPanel(null)}>
          <div className="grid w-[420px] grid-cols-6 gap-1.5">
            {[["🤝","Agreement"],["💯","Full agreement"],["✅","Settled"],["💡","New idea"],["🔥","Strongest claim"],["😮","That landed"],["👏","Worth marking"],["❓","Left hanging"],["🎉","Milestone"],["🙌","Everyone aligned"],["✨","Worth keeping"]].map(([e, name]) => (
              <button
                key={e}
                onClick={() => react(e)}
                disabled={busy}
                title={name}
                className="grid aspect-square place-items-center rounded-lg border border-neutral-200 bg-white text-[22px] transition-colors hover:border-neutral-400 hover:bg-neutral-50 disabled:opacity-40"
              >{e}</button>
            ))}
          </div>
        </Sheet>
      ) : null}

      {panel === "add" ? (
        <Sheet title="Add a card" sub="Speak it or type it — both work, side by side" onClose={() => { setPanel(null); setText(""); }}>
          <div className="w-[460px]">
            <div className="mb-2 flex gap-1">
              {KINDS.map((k) => {
                const I = k.icon;
                return (
                  <button
                    key={k.kind}
                    onClick={() => setKind(k.kind)}
                    className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors"
                    style={kind === k.kind ? { background: "#111827", color: "#fff" } : { color: "#6b7280" }}
                  >
                    <I /> {k.label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => listen(20)}
                className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors"
                style={armed > 0 ? { background: "#b45309", color: "#fff" } : { background: "#f3f4f6", color: "#374151" }}
                title="Default: speak. Click, then say the card"
              >
                <IconMic /> {armed > 0 ? `Listening ${armed}s` : "Speak"}
              </button>
              <input
                ref={first}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addCard(); if (e.key === "Escape") setPanel(null); }}
                placeholder="…or type the card here and press Enter"
                className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[14px] text-neutral-900 placeholder:text-neutral-400 outline-none focus:border-neutral-500"
              />
              <button
                onClick={addCard}
                disabled={!text.trim() || busy}
                className="shrink-0 rounded-lg px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-40"
                style={{ background: "#111827" }}
              >Add</button>
            </div>
          </div>
        </Sheet>
      ) : null}

      {/* ── SỬA TÊN — preview, then commit ──────────────────────────────────────────────────── */}
      {panel === "rename" ? (
        <Sheet title="Fix a misheard name" sub="List every way it gets misheard, separated by commas" onClose={() => { setPanel(null); setPreview(null); }}>
          <div className="w-[520px]">
            <div className="flex items-center gap-2">
              <input
                ref={first}
                value={from}
                onChange={(e) => { setFrom(e.target.value); setPreview(null); }}
                placeholder="Easy Vision, Easy Vision AI, E C Vision"
                className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[14px] text-neutral-900 placeholder:text-neutral-400 outline-none focus:border-neutral-500"
              />
              <span className="text-neutral-400">→</span>
              <input
                value={to}
                onChange={(e) => { setTo(e.target.value); setPreview(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") runPreview(); if (e.key === "Escape") setPanel(null); }}
                placeholder="Ecvision"
                className="min-w-0 flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[14px] text-neutral-900 placeholder:text-neutral-400 outline-none focus:border-neutral-500"
              />
              <button
                onClick={runPreview}
                disabled={!from.trim() || !to.trim() || busy}
                className="shrink-0 rounded-lg bg-neutral-100 px-3 py-2 text-[13px] font-semibold text-neutral-800 disabled:opacity-40"
              >Preview</button>
            </div>

            {/* ⚠️ SHOW WHAT IS ALREADY TAUGHT. Corrections were added blind, so there was no way to tell
                from inside a call whether a name was already handled — the honest answer to "why is it
                still wrong?" is often "that rule exists and something else is at fault". */}
            {dict && (dict.call.length || dict.universal.length) ? (
              <div className="mt-2.5 max-h-[104px] overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50/70 p-2 font-mono text-[11px] leading-[1.5]">
                {dict.call.map((f) => (
                  <div key={`c-${f.from}`} className="flex gap-1.5">
                    <span className="text-amber-700">this call</span>
                    <span className="text-neutral-500">{f.from}</span>
                    <span className="text-neutral-300">→</span>
                    <span className="text-neutral-800">{f.to}</span>
                  </div>
                ))}
                {dict.universal.slice(0, 40).map((f) => (
                  <div key={`u-${f.from}`} className="flex gap-1.5">
                    <span className="text-neutral-300">always</span>
                    <span className="text-neutral-500">{f.from}</span>
                    <span className="text-neutral-300">→</span>
                    <span className="text-neutral-800">{f.to}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {preview ? (
              <div className="mt-2.5 rounded-lg border border-neutral-200 bg-neutral-50/70 p-2.5">
                {preview.matches === 0 ? (
                  <div className="text-[13px] text-neutral-600">
                    No card contains “{from}” yet. You can still save it so Minami gets it right from now on.
                  </div>
                ) : (
                  <>
                    <div className="mb-1.5 text-[12.5px] font-semibold text-neutral-700">
                      {preview.matches} card(s) will change:
                    </div>
                    {preview.cards.map((c) => (
                      <div key={c.id} className="truncate text-[12.5px] leading-5">
                        <span className="text-neutral-400 line-through">{c.before}</span>
                        <span className="mx-1.5 text-neutral-400">→</span>
                        <span className="font-medium text-neutral-900">{c.after}</span>
                      </div>
                    ))}
                  </>
                )}
                <div className="mt-2.5 flex items-center gap-2 border-t border-neutral-200 pt-2.5">
                  <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-neutral-600">
                    <input type="checkbox" checked={universal} onChange={(e) => setUniversal(e.target.checked)} />
                    Remember for all future calls
                  </label>
                  <span className="flex-1" />
                  <button onClick={() => setPreview(null)} className="rounded-lg px-3 py-1.5 text-[13px] text-neutral-600 hover:bg-neutral-200">Cancel</button>
                  <button
                    onClick={commitRename}
                    disabled={busy}
                    className="rounded-lg px-3 py-1.5 text-[13px] font-semibold text-white disabled:opacity-40"
                    style={{ background: "#111827" }}
                  >Confirm rename</button>
                </div>
              </div>
            ) : null}
          </div>
        </Sheet>
      ) : null}

      {/* ── THE BAR ─────────────────────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-0.5 rounded-2xl border border-neutral-200/70 bg-white/85 p-1 shadow-[0_10px_30px_-16px_rgba(16,24,40,0.4)] backdrop-blur-xl">
        <Btn onClick={() => setPanel(panel === "voice" ? null : "voice")} active={panel === "voice" || armed > 0} accent="#b45309" icon={<IconMic />}>
          {armed > 0 ? `Listening ${armed}s` : "Voice command"}
        </Btn>
        {/* Abort stays reachable from the bar itself, not only from inside the panel — the moment anh
            needs to cancel is the moment he does not want to hunt for where he opened it. */}
        {armed > 0 ? (
          <button
            onClick={abort}
            title="Cancel voice command"
            className="rounded-xl px-2.5 py-1.5 text-[13px] font-semibold text-red-700 hover:bg-red-50"
          >Cancel</button>
        ) : null}
        <Btn onClick={() => setPanel(panel === "say" ? null : "say")} active={panel === "say"} icon={<IconBook />}>What to say</Btn>
        <Sep />
        <Btn onClick={() => setPanel(panel === "ear" ? null : "ear")} active={panel === "ear"} icon={<IconEar />}>
          {ear && ear !== "Default" ? `Ear: ${ear}` : "Ear"}
        </Btn>
        {/* One mic, several people. Off by default because Recall's per-participant streams are
            authoritative when everyone dials in separately — this is for the case where they don't. */}
        <Btn
          onClick={async () => {
            const next = !room;
            const d = await call({ action: "room", room: next });
            if (!d) return;
            setRoom(!!d.room);
            setRoster(d.roster ?? []);
            setFlash({ msg: d.room ? "Room mode on — separating voices on this mic" : "Room mode off" });
          }}
          active={room}
          accent="#6d5ae0"
          icon={<IconRoom />}
        >{room ? (roster.length ? `Room · ${roster.length}` : "Room") : "Room"}</Btn>
        <Sep />
        <Btn onClick={() => setPanel(panel === "react" ? null : "react")} active={panel === "react"} icon={<span className="text-[13px] leading-none">🎉</span>}>React</Btn>
        <Btn onClick={toggleMemes} active={memesOn} icon={<span className="text-[13px] leading-none">{memesOn ? "🖼️" : "🚫"}</span>}>
          {memesOn ? "Memes" : "Memes off"}
        </Btn>
        <Btn onClick={() => setPanel(panel === "add" ? null : "add")} active={panel === "add"} icon={<IconPlus />}>Add card</Btn>
        <Btn
          onClick={() => { const next = panel === "rename" ? null : "rename"; setPanel(next); if (next) void loadDict(); }}
          active={panel === "rename"} icon={<IconEdit />}
        >Fix name</Btn>
        <Sep />
        <Btn onClick={async () => { const d = await call({ action: "undo" }); if (d) { setCanRedo(!!d.canRedo); setFlash({ msg: d.removed ? `Removed: ${String(d.removed).slice(0, 32)}` : "Nothing left to undo" }); } }} icon={<IconUndo />}>Undo</Btn>
        <Btn onClick={async () => { const d = await call({ action: "redo" }); if (d) { setCanRedo(!!d.canRedo); setFlash({ msg: d.restored ? `Restored: ${String(d.restored).slice(0, 32)}` : "Nothing to redo" }); } }} dim={!canRedo} icon={<IconRedo />}>Redo</Btn>
        <Btn onClick={async () => { if (await call({ action: "tidy" })) setFlash({ msg: "Tidying the board…" }); }} icon={<IconTidy />}>Tidy</Btn>
      </div>
    </div>
  );
}

function Sheet({ title, sub, children, onClose }: { title: string; sub: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="rounded-2xl border border-neutral-200/80 bg-white/95 p-3 shadow-[0_14px_40px_-18px_rgba(16,24,40,0.45)] backdrop-blur-xl">
      <div className="mb-2 flex items-start gap-3">
        <div className="flex-1">
          <div className="text-[13.5px] font-semibold tracking-[-0.01em] text-neutral-900">{title}</div>
          <div className="text-[12px] text-neutral-500">{sub}</div>
        </div>
        <button onClick={onClose} className="rounded-md px-1.5 text-[16px] leading-none text-neutral-400 hover:text-neutral-800">×</button>
      </div>
      {children}
    </div>
  );
}

function Btn({ children, onClick, active, accent, icon, dim }: {
  children: React.ReactNode; onClick: () => void; active?: boolean; accent?: string; icon?: React.ReactNode; dim?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[13px] font-medium tracking-[-0.01em] transition-colors"
      style={active ? { background: accent ?? "#111827", color: "#fff" } : { color: dim ? "#9ca3af" : "#4b5563" }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "#f3f4f6"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      {icon}{children}
    </button>
  );
}

const Sep = () => <span className="mx-1 h-4 w-px bg-neutral-200" />;

/* Icons: inline strokes, 14px, currentColor — no icon font, no network, and they inherit the button's
   colour so the active state needs no second rule. */
const sw = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
function IconMic() { return <svg width="14" height="14" viewBox="0 0 24 24" {...sw}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v4" /></svg>; }
function IconBook() { return <svg width="14" height="14" viewBox="0 0 24 24" {...sw}><path d="M4 4h9a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z" /><path d="M20 4h-1a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h2z" /></svg>; }
function IconPlus() { return <svg width="14" height="14" viewBox="0 0 24 24" {...sw}><path d="M12 5v14M5 12h14" /></svg>; }
function IconEdit() { return <svg width="14" height="14" viewBox="0 0 24 24" {...sw}><path d="M4 20h4l10-10-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>; }
function IconUndo() { return <svg width="14" height="14" viewBox="0 0 24 24" {...sw}><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>; }
function IconRedo() { return <svg width="14" height="14" viewBox="0 0 24 24" {...sw}><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 0 0 0 12h3" /></svg>; }
function IconTidy() { return <svg width="14" height="14" viewBox="0 0 24 24" {...sw}><path d="M4 6h16M4 12h10M4 18h7" /></svg>; }
function IconNote() { return <svg width="13" height="13" viewBox="0 0 24 24" {...sw}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>; }
function IconCheck() { return <svg width="13" height="13" viewBox="0 0 24 24" {...sw}><path d="M5 12l4.5 4.5L19 7" /></svg>; }
function IconArrow() { return <svg width="13" height="13" viewBox="0 0 24 24" {...sw}><path d="M5 12h14M13 6l6 6-6 6" /></svg>; }
function IconAsk() { return <svg width="13" height="13" viewBox="0 0 24 24" {...sw}><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 1-1 1.7v.5" /><path d="M12 17.5v.01" /></svg>; }
function IconEar() { return <svg width="14" height="14" viewBox="0 0 24 24" {...sw}><path d="M8 8a4 4 0 1 1 8 0c0 2.5-2 3.2-2.8 4.4-.6.9-.4 2.1-.4 3.1a2.4 2.4 0 0 1-4.8 0" /><path d="M9.5 8.2a2.5 2.5 0 0 1 4.4 1" /></svg>; }
function IconRoom() { return <svg width="14" height="14" viewBox="0 0 24 24" {...sw}><circle cx="9" cy="9" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><circle cx="17" cy="10" r="2.2" /><path d="M15 19a4 4 0 0 1 6.5-3.1" /></svg>; }
function IconWarn() { return <svg width="13" height="13" viewBox="0 0 24 24" {...sw}><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17.5v.01" /></svg>; }
