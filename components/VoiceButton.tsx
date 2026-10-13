"use client";

// 🎤 in the composer row: record a voice note, get its text in the message box (§3, §23).
//
// Not the keyboard's voice typing: that transcribes word by word as you speak, mangles mixed
// Vietnamese/English, and loses everything if the keyboard closes. This records the whole thought,
// then transcribes it once with the meeting ear (/api/agent/transcribe), which is tuned on exactly
// that mix. The text lands at the caret for him to read and fix; nothing is sent by itself.

import { useEffect, useRef, useState } from "react";
import { startCapture } from "@/lib/pcm-client";

type Cap = Awaited<ReturnType<typeof startCapture>>;

export function VoiceButton({ onText, disabled }: { onText: (t: string) => void; disabled?: boolean }) {
  const [phase, setPhase] = useState<"idle" | "rec" | "busy">("idle");
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const cap = useRef<Cap | null>(null);
  const lastLevel = useRef(0);

  // The timer and meter tick from the capture itself, four times a second — not on every audio
  // quantum, which would re-render the composer row ~375 times a second.
  useEffect(() => {
    if (phase !== "rec") return;
    const t = setInterval(() => { setSecs(Math.floor(cap.current?.seconds() ?? 0)); setLevel(lastLevel.current); lastLevel.current = 0; }, 250);
    return () => clearInterval(t);
  }, [phase]);
  // Leaving the pane mid-note must not leave the mic on.
  useEffect(() => () => cap.current?.cancel(), []);
  useEffect(() => { if (!err) return; const t = setTimeout(() => setErr(null), 6000); return () => clearTimeout(t); }, [err]);

  const start = async () => {
    setErr(null);
    try {
      cap.current = await startCapture((p) => { if (p > lastLevel.current) lastLevel.current = p; });
      setSecs(0);
      setPhase("rec");
    } catch (e) {
      setErr(e instanceof Error && /denied|NotAllowed/i.test(e.message + e.name) ? "Microphone blocked — allow it for this site" : e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    const c = cap.current; cap.current = null;
    if (!c) return;
    setPhase("busy");
    try {
      const wav = await c.stop();
      const r = await fetch("/api/agent/transcribe", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
      const j = (await r.json()) as { ok: boolean; text?: string; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (j.text) onText(j.text);
      else setErr("Didn't catch any speech");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
    }
  };

  const cancel = () => { cap.current?.cancel(); cap.current = null; setPhase("idle"); };
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

  return (
    <div className="relative shrink-0 self-end">
      {phase === "rec" ? (
        <div className="flex items-center gap-1.5 rounded-full border border-rose-400/40 bg-rose-500/15 py-0.5 pl-2 pr-0.5">
          <span className="h-2 w-2 animate-pulse rounded-full bg-rose-400" />
          <span className="font-mono text-[11px] tabular-nums text-rose-100">{clock}</span>
          {/* Square-root scale: speech sits at 0.05–0.2 linear, which reads as "not hearing me". */}
          <span className="h-1.5 w-8 overflow-hidden rounded-full bg-white/10"><span className="block h-full bg-rose-300 transition-[width] duration-200" style={{ width: `${Math.min(100, Math.sqrt(level) * 100)}%` }} /></span>
          <button onClick={cancel} title="Discard this note" aria-label="Discard"
            className="rounded-full px-1.5 py-1 text-[11px] text-rose-200/70 hover:text-white pointer-coarse:min-h-9 pointer-coarse:min-w-9">✕</button>
          <button onClick={stop} title="Stop and transcribe" aria-label="Stop and transcribe"
            className="rounded-full bg-rose-500 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-400 pointer-coarse:min-h-9">■</button>
        </div>
      ) : (
        <button onClick={start} disabled={disabled || phase === "busy"}
          title={phase === "busy" ? "Transcribing…" : "Voice note — record, then the text goes in the box (Vietnamese or English)"}
          aria-label="Record a voice note"
          className="rounded-md px-1 py-1 text-neutral-500 transition-colors hover:text-neutral-200 disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:px-2">
          {phase === "busy" ? <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-500 border-t-transparent align-middle" /> : "🎤"}
        </button>
      )}
      {err && <div className="absolute bottom-full left-0 z-20 mb-1 w-60 rounded-lg border border-rose-500/30 bg-neutral-900 px-2 py-1.5 text-[11px] leading-snug text-rose-200 shadow-xl">{err}</div>}
    </div>
  );
}
