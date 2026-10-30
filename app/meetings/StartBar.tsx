"use client";
// START A MEETING FROM THE LIBRARY, ON THE LAPTOP MIC (pitch meeting-start, round 3 V2, picked 2026-10-30).
//
// The phone page (/meet) already ran the whole pipeline from any mic, the Mac's included, but it was
// phone-styled and in no nav, so starting a meeting at the desk meant knowing a URL. This bar is that
// pipeline's desk door: name it, Start, and the bar becomes the live strip in place. Same endpoints
// as the phone (/api/meet/mic, /api/meet/status), same audio helpers (lib/meet-audio.ts).
//
// Deliberately smaller than /meet: no wake lock, no backgrounded-tab detection, no recording upload.
// A desktop background tab keeps capturing, which is the case Android needed all that for. What it
// does keep is the one rule of the live canvas: say plainly when audio is NOT arriving, because an
// empty board looks the same whether nothing was worth a card or the pipe is dead.
//
// ⚠️ THE MEETING LIVES IN THIS PAGE. Leaving /meetings stops the mic (the pick accepted that). So
// unmounting mid-meeting ENDS it on the box rather than leaving it open with no audio, and a tab
// close asks first.

import { useCallback, useEffect, useRef, useState } from "react";
import { FRAME_S, MAX_BACKLOG, TAP, boardUrl, newId, toPcm16 } from "@/lib/meet-audio";

type Phase = "idle" | "starting" | "live" | "ending" | "ended";
type Summary = { minutes?: number; cards?: number; archived?: string | null };
type Stats = { lastFrameAt: number | null; lastResult: { status: number; note: string } | null; startedAt: number };
type Status = { now: number; stats: Stats | null; ingestReady: boolean };

const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

export function StartBar({ onSaved }: { onSaved: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [title, setTitle] = useState("");
  const [board, setBoard] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [cards, setCards] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [bot, setBot] = useState<"" | "opening" | "opened" | "failed">("");
  const [, tick] = useState(0);

  const audio = useRef<{ stream: MediaStream; ctx: AudioContext } | null>(null);
  const queue = useRef<Int16Array[]>([]);
  const live = useRef(false);
  const idRef = useRef<string | null>(null);
  const openArgs = useRef({ title: "" });

  const open = useCallback(async (mid: string) => {
    const r = await fetch(`/api/meet/mic?id=${encodeURIComponent(mid)}&event=start`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(openArgs.current),
    });
    if (!r.ok) throw new Error(`the box refused to open the meeting (HTTP ${r.status})`);
  }, []);

  // One frame in flight, in order — the same loop as the phone, including re-opening after a 409
  // (the server restarted under us: a deploy mid-meeting costs the board, not the words).
  const pump = useCallback(async () => {
    let backoff = 500;
    while (live.current || queue.current.length) {
      const frame = queue.current[0];
      if (!frame) { await new Promise((ok) => setTimeout(ok, 100)); continue; }
      const mid = idRef.current!;
      try {
        const r = await fetch(`/api/meet/mic?id=${encodeURIComponent(mid)}`, {
          method: "POST", headers: { "content-type": "application/octet-stream" }, body: frame.buffer as ArrayBuffer,
        });
        if (r.status === 409) { await open(mid); continue; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        queue.current.shift();
        backoff = 500;
      } catch {
        await new Promise((ok) => setTimeout(ok, backoff));
        backoff = Math.min(backoff * 2, 4000);
      }
    }
  }, [open]);

  const release = () => {
    live.current = false;
    audio.current?.stream.getTracks().forEach((t) => t.stop());
    void audio.current?.ctx.close();
    audio.current = null;
  };

  const start = useCallback(async () => {
    setError(null);
    setSummary(null);
    setCards(0);
    setStatus(null);
    setPhase("starting");
    // Opened inside the click: after the awaits below it is no longer a user gesture and the popup
    // blocker eats it.
    const win = board ? window.open("about:blank", "minami-board") : null;
    const mid = newId();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP], { type: "text/javascript" })));
      const node = new AudioWorkletNode(ctx, "minami-tap");
      ctx.createMediaStreamSource(stream).connect(node);
      const per = Math.round(ctx.sampleRate * FRAME_S);
      let acc = new Float32Array(per), fill = 0;
      node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        const chunk = ev.data;
        let off = 0;
        while (off < chunk.length) {
          const take = Math.min(per - fill, chunk.length - off);
          acc.set(chunk.subarray(off, off + take), fill);
          fill += take; off += take;
          if (fill === per) {
            let peak = 0;
            for (let i = 0; i < per; i++) peak = Math.max(peak, Math.abs(acc[i]));
            setLevel(peak);
            queue.current.push(toPcm16(acc, ctx.sampleRate));
            if (queue.current.length > MAX_BACKLOG) queue.current.shift();
            acc = new Float32Array(per); fill = 0;
          }
        }
      };
      audio.current = { stream, ctx };
      openArgs.current = { title: title.trim() };
      idRef.current = mid;
      await open(mid);
      if (win) win.location.href = boardUrl(mid);
      queue.current = [];
      live.current = true;
      setStartedAt(Date.now());
      setPhase("live");
      void pump();
    } catch (e) {
      release();
      win?.close();
      setPhase("idle");
      const msg = e instanceof Error ? e.message : String(e);
      setError(/denied|NotAllowed/i.test(msg) ? "The mic was blocked — allow it for this site in Chrome, then Start again." : msg);
    }
  }, [board, title, open, pump]);

  const stop = useCallback(async () => {
    setPhase("ending");
    release();
    // Let the last half-second go up before asking the box to close.
    const until = Date.now() + 5000;
    while (queue.current.length && Date.now() < until) await new Promise((ok) => setTimeout(ok, 150));
    try {
      const r = await fetch(`/api/meet/mic?id=${encodeURIComponent(idRef.current!)}&event=end`, { method: "POST" });
      setSummary(((await r.json()).summary as Summary) ?? null);
    } catch (e) {
      setError(`ending failed — ${e instanceof Error ? e.message : String(e)}`);
    }
    setPhase("ended");
    onSaved();
  }, [onSaved]);

  // Live: a clock for the timer, the box's view of the pipe, and the card count for this meeting only.
  // Polled rather than streamed — every SSE stream costs one of Chrome's six connections per host.
  useEffect(() => {
    if (phase !== "live") return;
    const mid = idRef.current!;
    let gone = false;
    const run = async () => {
      try {
        const s = await (await fetch(`/api/meet/status?id=${encodeURIComponent(mid)}`, { cache: "no-store" })).json();
        if (!gone) setStatus(s as Status);
        const g = await (await fetch(`/api/canvas?meeting=${encodeURIComponent(mid)}`, { cache: "no-store" })).json();
        if (!gone && g?.meetingId === mid) setCards((g.nodes ?? []).filter((n: { kind: string; placeholder?: boolean }) => n.kind !== "topic" && !n.placeholder).length);
      } catch { /* the strip ages on its own */ }
    };
    void run();
    const poll = setInterval(run, 2000);
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => { gone = true; clearInterval(poll); clearInterval(t); };
  }, [phase]);

  // Leaving the page mid-meeting: end it on the box (keepalive survives the navigation) instead of
  // leaving a meeting open that will never hear another word. A tab close asks first.
  useEffect(() => {
    const ask = (e: BeforeUnloadEvent) => { if (live.current) e.preventDefault(); };
    window.addEventListener("beforeunload", ask);
    return () => {
      window.removeEventListener("beforeunload", ask);
      if (live.current && idRef.current) {
        release();
        void fetch(`/api/meet/mic?id=${encodeURIComponent(idRef.current)}&event=end`, { method: "POST", keepalive: true });
      }
    };
  }, []);

  const sendBot = async () => {
    setBot("opening");
    try { setBot((await fetch("/api/meetings/oncall", { method: "POST" })).ok ? "opened" : "failed"); } catch { setBot("failed"); }
  };

  // The verdict: the first thing that is wrong, else that it works. Same order as /meet's strip.
  const s = status?.stats ?? null;
  const frameAge = s?.lastFrameAt != null && status ? status.now - s.lastFrameAt : null;
  const since = Date.now() - startedAt;
  const verdict: { tone: "ok" | "wait" | "bad"; text: string } =
    status && !status.ingestReady ? { tone: "bad", text: "the ingest token isn't set on the box — nothing will be heard" }
    : frameAge == null ? (since > 6000 ? { tone: "bad", text: "no audio has reached the box" } : { tone: "wait", text: "connecting" })
    : frameAge > 4000 ? { tone: "bad", text: `audio stopped reaching the box ${Math.round(frameAge / 1000)}s ago` }
    : s?.lastResult && (s.lastResult.status >= 400 || s.lastResult.status === 0) ? { tone: "bad", text: s.lastResult.note }
    : cards > 0 ? { tone: "ok", text: `${cards} card${cards === 1 ? "" : "s"}` }
    : { tone: "ok", text: "hearing you — the first card comes after a pause" };
  const DOT = { ok: "bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,.18)]", wait: "bg-amber-400", bad: "bg-rose-500" }[verdict.tone];

  return (
    <div className="mb-5">
      {phase === "live" || phase === "ending" ? (
        <div className="flex items-center gap-3 rounded-2xl border border-neutral-200 bg-white px-4 py-3">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT}`} />
          <span className="shrink-0 text-[14px] font-medium text-neutral-900">{phase === "ending" ? "Saving…" : "Listening"}</span>
          <div className="h-2 w-28 shrink-0 overflow-hidden rounded-full bg-neutral-100">
            <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-150" style={{ width: `${Math.min(100, level * 160)}%` }} />
          </div>
          <span className="shrink-0 font-mono text-[12.5px] tabular-nums text-neutral-500">{clock(since)}</span>
          <span className={`min-w-0 flex-1 truncate text-[13px] ${verdict.tone === "bad" ? "text-rose-600" : "text-neutral-500"}`}>{verdict.text}</span>
          <button onClick={() => idRef.current && window.open(boardUrl(idRef.current), "minami-board")}
            className="shrink-0 rounded-lg border border-neutral-200 px-2.5 py-1 text-[13px] text-neutral-600 hover:border-neutral-400">Board ↗</button>
          <button onClick={stop} disabled={phase === "ending"}
            className="shrink-0 rounded-lg bg-rose-500 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-rose-600 disabled:opacity-50">End</button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void start(); }}
          className="flex flex-wrap items-center gap-2 rounded-2xl border border-neutral-200 bg-white p-2 sm:flex-nowrap">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's this meeting? (optional)"
            className="min-w-0 flex-1 rounded-xl px-2.5 py-2 text-[14.5px] text-neutral-900 placeholder:text-neutral-400 outline-none" />
          <label className="flex shrink-0 items-center gap-1.5 px-1 text-[12.5px] text-neutral-500">
            <input type="checkbox" checked={board} onChange={(e) => setBoard(e.target.checked)} className="h-3.5 w-3.5 accent-emerald-500" />
            board in a 2nd window
          </label>
          <button type="submit" disabled={phase === "starting"}
            className="shrink-0 rounded-xl bg-emerald-500 px-4 py-2 text-[14px] font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50">
            {phase === "starting" ? "Asking for the mic…" : "🎙 Start listening"}
          </button>
        </form>
      )}
      <p className="mt-1.5 px-1 text-[12.5px] text-neutral-500">
        {error ? <span className="text-rose-600">{error} </span> : null}
        {phase === "ended" && summary ? (
          <span className="text-neutral-700">
            Saved · {summary.minutes?.toFixed?.(1) ?? "?"} min · {summary.cards ?? 0} cards{summary.archived ? " — it's at the top of the list." : " — nothing was captured, so nothing was archived."}{" "}
          </span>
        ) : null}
        {phase === "idle" || phase === "ended" ? (
          <>
            Uses this Mac&apos;s mic. Google Meet call instead?{" "}
            <button onClick={sendBot} disabled={bot === "opening"} className="text-blue-600 hover:underline">Send the bot →</button>
            {bot === "opened" ? <span className="text-neutral-400"> On Call opened in Terminal; paste the Meet link there.</span> : null}
            {bot === "failed" ? <span className="text-rose-600"> Couldn&apos;t open On Call; double-click bin/Minami Call.command.</span> : null}
          </>
        ) : null}
      </p>
    </div>
  );
}
