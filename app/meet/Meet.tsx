"use client";

// Phone as Minami's ear (§17b). Three jobs, in priority order:
//
//   1. PROVE IT IS WORKING. The canvas pipeline cannot tell "nothing worth saying" from "I have
//      stopped working" — both are a 200 and an empty board (CLAUDE.md, the live canvas). So the top
//      of this screen is not the board, it is a five-stage strip that names the FIRST stage that
//      stopped: mic → the box receiving → transcript → judge → board, each with its own age.
//   2. Capture: the mic, resampled to 16 kHz s16le and shipped every 0.5s. All speech detection
//      happens on the box, in the same chunker the Recall receiver uses (lib/meet-mic.ts).
//   3. Show what landed: the transcript as heard and the cards as they arrive.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KIND_ICON, KIND_LABEL, type Graph, type GNode } from "@/lib/canvas-graph";

type Trace = { at: number; kind: string; text: string; ms?: number };
type Stats = {
  id: string; title: string; startedAt: number; framesIn: number; audioMsIn: number;
  lastFrameAt: number | null; level: number; chunksOut: number; lastChunkAt: number | null;
  lastChunkMs: number; inflight: number; lastResult: { at: number; status: number; note: string } | null;
  errors: { at: number; text: string }[]; ended: boolean;
  source: Source; file: FileState | null; keep: boolean; summary: Summary | null; audioSaved: string | null;
};
/** `recvAt` is the phone's clock when the poll landed — see the skew note in the strip. */
type Status = { now: number; recvAt: number; stats: Stats | null; trace: Trace[]; ingestReady: boolean };
type Summary = { utterances?: number; cards?: number; topics?: number; minutes?: number; cost?: number; archived?: string | null };
type FileState = { name: string; totalMs: number | null; doneMs: number; speed: number; finished: boolean };
type Source = "mic" | "file";
type Phase = "idle" | "starting" | "live" | "ending" | "ended";
type Light = "ok" | "wait" | "bad" | "off";

const RATE = 16_000;
const FRAME_S = 0.5;
/** 15s of audio waiting to upload. Past this the network is not coming back soon enough for the
 *  words to matter on a live board, and an unbounded queue would OOM a phone tab in a long meeting. */
const MAX_BACKLOG = 30;

/** The AudioWorklet, inline so there is no extra file to serve. It only copies the input out; the
 *  main thread does the rest, because worklet → main messages at 128-sample quanta are cheap and
 *  keeping the resampler in one place keeps it debuggable. */
const TAP = `class T extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('minami-tap',T)`;

/** Box-filter decimation to 16 kHz. Averaging over each output sample's window is a crude low-pass,
 *  which is enough for speech going to an STT model and much better than picking every Nth sample
 *  (that aliases a 48 kHz mic's hiss straight into the speech band). */
function toPcm16(input: Float32Array, rate: number): Int16Array {
  const ratio = rate / RATE;
  const n = Math.floor(input.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    const v = Math.max(-1, Math.min(1, sum / (b - a)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

const ago = (ms: number | null | undefined) =>
  ms == null ? "—" : ms < 1500 ? "now" : ms < 60_000 ? `${Math.round(ms / 1000)}s ago` : `${Math.floor(ms / 60_000)}m ago`;

const newId = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `phone-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${Math.random().toString(36).slice(2, 6)}`;
};

/** "[gemini-…] [gain x1.8] ?: words" → "words". The trace line is written for the debug panel. */
/** The full canvas, memes and all, in present mode (no operator panel) and pinned to one meeting. */
const boardUrl = (id: string) => `/canvas?present=1&meeting=${encodeURIComponent(id)}`;
const SPEEDS = [1, 2, 4, 8];

const spoken = (t: string) => t.replace(/^(\s*\[[^\]]*\])+\s*/, "").replace(/^\?:\s*/, "");

export function Meet() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [id, setId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [level, setLevel] = useState(0);
  const [upload, setUpload] = useState({ sent: 0, failed: 0, dropped: 0, backlog: 0, lastErr: "" });
  const [hidden, setHidden] = useState(false);
  const [wake, setWake] = useState<"on" | "off" | "unsupported">("off");
  const [, tick] = useState(0);
  const [source, setSource] = useState<Source>("mic");
  const [keep, setKeep] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [speed, setSpeed] = useState(4);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  /** Open the board in a second window on THIS device at Start — the laptop-on-the-table case. */
  const [present, setPresent] = useState(false);
  /** Touch device. Only there does leaving the page stop the mic; a desktop background tab keeps
   *  capturing, which is exactly what the laptop-plus-board setup relies on. */
  const [touch, setTouch] = useState(true);
  const [host, setHost] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => { setTouch(window.matchMedia("(pointer: coarse)").matches); setHost(window.location.host); }, []);

  const audio = useRef<{ stream: MediaStream; ctx: AudioContext; node: AudioWorkletNode } | null>(null);
  const queue = useRef<Int16Array[]>([]);
  const live = useRef(false);
  const lastLoudAt = useRef<number>(0);
  const trackState = useRef<"live" | "muted" | "ended">("live");
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);
  const idRef = useRef<string | null>(null);
  const openArgs = useRef({ title: "", context: "", keep: false });

  // A clock for the "Ns ago" labels. 1s is the resolution they print at.
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  // ── keep the screen on, and say so when it is not ────────────────────────────────────────────
  // Android Chrome suspends a backgrounded tab's audio capture within seconds; the mic keeps its
  // indicator lit while delivering silence. So leaving this screen is the most likely way a phone
  // meeting dies, and it has to be stated on screen rather than discovered in the archive.
  const lockScreen = useCallback(async () => {
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (!wl) { setWake("unsupported"); return; }
    try { wakeLock.current = await wl.request("screen"); setWake("on"); } catch { setWake("off"); }
  }, []);
  useEffect(() => {
    const on = () => {
      setHidden(document.hidden);
      // A wake lock is released whenever the page is hidden; take it again on return.
      if (!document.hidden && live.current) void lockScreen();
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [lockScreen]);

  const open = useCallback(async (mid: string) => {
    const r = await fetch(`/api/meet/mic?id=${encodeURIComponent(mid)}&event=start`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(openArgs.current),
    });
    if (!r.ok) throw new Error(`the box refused to open the meeting (HTTP ${r.status})`);
  }, []);

  // ── upload loop: one frame in flight at a time, in order ─────────────────────────────────────
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
        if (r.status === 409) {
          // The box lost the meeting — almost always a server restart (deploy). Re-open under the same
          // id and resend; the board restarts, but the words keep flowing instead of vanishing.
          await open(mid);
          setUpload((u) => ({ ...u, lastErr: "box restarted — meeting re-opened" }));
          continue;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        queue.current.shift();
        backoff = 500;
        setUpload((u) => ({ ...u, sent: u.sent + 1, backlog: queue.current.length }));
      } catch (e) {
        setUpload((u) => ({ ...u, failed: u.failed + 1, backlog: queue.current.length, lastErr: e instanceof Error ? e.message : String(e) }));
        await new Promise((ok) => setTimeout(ok, backoff));
        backoff = Math.min(backoff * 2, 4000);
      }
    }
  }, [open]);

  const start = useCallback(async () => {
    setError(null);
    setSummary(null);
    setPhase("starting");
    // Opened NOW, inside the tap, and pointed at the board once the id exists: a window.open after
    // the awaits below is no longer a user gesture and the popup blocker eats it.
    const board = present ? window.open("about:blank", "minami-board") : null;
    const mid = newId();
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("this page has no microphone access — open it over https (the tailnet URL), not http://<ip>");
      }
      // Echo cancellation and AGC on: a phone flat on a table is far from most speakers, and the
      // box's chunker decides speech relative to a decaying peak, so steadier levels cut cleaner.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([TAP], { type: "text/javascript" })));
      const node = new AudioWorkletNode(ctx, "minami-tap");
      const src = ctx.createMediaStreamSource(stream);
      src.connect(node);
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
            if (peak > 0.02) lastLoudAt.current = Date.now();
            queue.current.push(toPcm16(acc, ctx.sampleRate));
            if (queue.current.length > MAX_BACKLOG) {
              queue.current.shift();
              setUpload((u) => ({ ...u, dropped: u.dropped + 1 }));
            }
            acc = new Float32Array(per); fill = 0;
          }
        }
      };
      const track = stream.getAudioTracks()[0];
      trackState.current = "live";
      track.onmute = () => { trackState.current = "muted"; };
      track.onunmute = () => { trackState.current = "live"; };
      track.onended = () => { trackState.current = "ended"; };
      audio.current = { stream, ctx, node };

      openArgs.current = { title: title.trim(), context: context.trim(), keep };
      idRef.current = mid;
      setId(mid);
      setGraph(null);
      setStatus(null);
      await open(mid);
      if (board) board.location.href = boardUrl(mid);
      lastLoudAt.current = Date.now();
      queue.current = [];
      setUpload({ sent: 0, failed: 0, dropped: 0, backlog: 0, lastErr: "" });
      live.current = true;
      setPhase("live");
      void lockScreen();
      void pump();
    } catch (e) {
      audio.current?.stream.getTracks().forEach((t) => t.stop());
      void audio.current?.ctx.close();
      audio.current = null;
      board?.close();
      setPhase("idle");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [title, context, keep, present, open, pump, lockScreen]);

  // ── a recording: upload it, and the Mac plays it through the pipeline on its own ──────────────
  const startRecording = useCallback(async () => {
    if (!file) { setError("pick a recording first"); return; }
    setError(null);
    setSummary(null);
    setPhase("starting");
    const board = present ? window.open("about:blank", "minami-board") : null;
    const mid = newId();
    idRef.current = mid;
    setId(mid);
    setGraph(null);
    setStatus(null);
    try {
      const q = new URLSearchParams({
        id: mid, name: file.name, speed: String(speed), keep: keep ? "1" : "0",
        title: title.trim() || file.name.replace(/\.[^.]+$/, ""),
      });
      // XHR rather than fetch for one reason: upload progress. A 40 MB recording over the tailnet
      // takes long enough that a spinner with no number reads as hung.
      await new Promise<void>((ok, fail) => {
        const x = new XMLHttpRequest();
        x.open("POST", `/api/meet/recording?${q}`);
        x.upload.onprogress = (e) => { if (e.lengthComputable) setUploadPct(e.loaded / e.total); };
        x.onload = () => {
          if (x.status < 300) return ok();
          let msg = `HTTP ${x.status}`;
          try { msg = (JSON.parse(x.responseText) as { error?: string }).error || msg; } catch { /* keep status */ }
          fail(new Error(msg));
        };
        x.onerror = () => fail(new Error("upload failed — can the phone reach the Mac?"));
        x.send(file);
      });
      if (board) board.location.href = boardUrl(mid);
      setPhase("live");
    } catch (e) {
      board?.close();
      setPhase("idle");
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploadPct(null);
    }
  }, [file, speed, keep, title, present]);

  const stop = useCallback(async () => {
    setPhase("ending");
    live.current = false;
    audio.current?.stream.getTracks().forEach((t) => t.stop());
    void audio.current?.ctx.close();
    audio.current = null;
    void wakeLock.current?.release().catch(() => {});
    wakeLock.current = null;
    setWake("off");
    // Let the last half-second of audio go up before asking the box to close.
    const until = Date.now() + 5000;
    while (queue.current.length && Date.now() < until) await new Promise((ok) => setTimeout(ok, 150));
    try {
      const r = await fetch(`/api/meet/mic?id=${encodeURIComponent(idRef.current!)}&event=end`, { method: "POST" });
      const j = await r.json();
      setSummary((j.summary as Summary) ?? null);
      // The ended board is published once, as the meeting closes; read it rather than trust the
      // stream to have delivered that last frame before we stop looking.
      const g = await (await fetch(`/api/canvas?meeting=${encodeURIComponent(idRef.current!)}`, { cache: "no-store" })).json();
      if (g?.meetingId === idRef.current) setGraph(g as Graph);
    } catch (e) {
      setError(`ending failed — ${e instanceof Error ? e.message : String(e)}`);
    }
    setPhase("ended");
  }, []);

  // ── status poll: the box's own view of every stage ───────────────────────────────────────────
  useEffect(() => {
    if (!id || phase === "idle") return;
    let gone = false;
    const run = async () => {
      try {
        const r = await fetch(`/api/meet/status?id=${encodeURIComponent(id)}`, { cache: "no-store" });
        if (!gone && r.ok) setStatus({ ...((await r.json()) as Status), recvAt: Date.now() });
      } catch { /* the strip shows staleness itself */ }
    };
    void run();
    const t = setInterval(run, 1500);
    return () => { gone = true; clearInterval(t); };
  }, [id, phase]);

  // A recording ends itself on the Mac when the file runs out. The phone learns it from the poll,
  // which is also how a phone that walked away and came back finds out how it went.
  useEffect(() => {
    const s = status?.stats;
    if (!s?.ended) return;
    // `ended` goes true on the Mac BEFORE the archive and the audio are written, so the summary lands
    // a few polls later. Keep taking it until it does — stopping at the first `ended` left the phone
    // on "Meeting ended." with no outcome at all.
    if (phase === "ended" && !summary && s.summary) { setSummary(s.summary); return; }
    if (phase !== "live") return;
    live.current = false;
    setSummary(s.summary);
    setPhase("ended");
    void fetch(`/api/canvas?meeting=${encodeURIComponent(s.id)}`, { cache: "no-store" })
      .then((r) => r.json()).then((g: Graph) => { if (g?.meetingId === s.id) setGraph(g); }).catch(() => {});
  }, [status, phase, summary]);

  // ── the board for this meeting only ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/canvas?stream=1&meeting=${encodeURIComponent(id)}`);
    es.onmessage = (ev) => {
      try {
        const g = JSON.parse(ev.data) as Graph;
        // Pinned by query, but checked again: a frame for another meeting must never render here.
        if (!g.meetingId || g.meetingId === id) setGraph(g);
      } catch { /* keep the last good frame */ }
    };
    return () => es.close();
  }, [id]);

  // Stop capturing if the page goes away mid-meeting.
  useEffect(() => () => { live.current = false; audio.current?.stream.getTracks().forEach((t) => t.stop()); }, []);

  // ── derive the strip ─────────────────────────────────────────────────────────────────────────
  const strip = useMemo(() => {
    const s = status?.stats ?? null;
    // Server ages are measured on the server's clock against the server's `now`, then aged locally by
    // however long ago that poll landed — a phone and a Mac disagree about the time by seconds.
    const skew = status ? status.recvAt - status.now : 0;
    const age = (at: number | null | undefined) => (at == null || !status ? null : Date.now() - skew - at);
    const lastOf = (k: string) => [...(status?.trace ?? [])].reverse().find((e) => e.kind === k);
    const hear = lastOf("hear"), judge = lastOf("judge"), paint = lastOf("paint"), err = lastOf("error");
    const cards = (graph?.nodes ?? []).filter((n) => n.kind !== "topic" && !n.placeholder).length;
    const sinceStart = s ? age(s.startedAt) ?? 0 : 0;
    const running = phase === "live";

    const f = s?.file ?? null;
    const isFile = (s?.source ?? source) === "file";
    const mic: { light: Light; text: string } = isFile
      ? (!running ? { light: "off", text: f?.finished ? "played to the end" : "off" }
        : !f ? { light: "wait", text: "opening the file…" }
        : { light: "ok", text: `${clock(f.doneMs)}${f.totalMs ? ` / ${clock(f.totalMs)}` : ""} · ${f.speed}×` })
      : !running ? { light: "off", text: "off" }
      : trackState.current === "ended" ? { light: "bad", text: "mic ended — another app took it" }
      : trackState.current === "muted" ? { light: "bad", text: "mic muted by the system" }
      : hidden && touch ? { light: "bad", text: "screen left — Android pauses the mic" }
      : Date.now() - lastLoudAt.current > 10_000 ? { light: "wait", text: `quiet ${ago(Date.now() - lastLoudAt.current).replace(" ago", "")}` }
      : { light: "ok", text: "hearing sound" };

    const sendAge = age(s?.lastFrameAt);
    const box: { light: Light; text: string } = !running ? { light: "off", text: "—" }
      : !status?.ingestReady ? { light: "bad", text: "ingest token not set on the box" }
      : sendAge == null ? (sinceStart > 5000 ? { light: "bad", text: "no audio has reached the box" } : { light: "wait", text: "connecting" })
      : sendAge > 4000 && isFile ? { light: "bad", text: `the Mac stopped feeding the file — ${ago(sendAge).replace(" ago", "")}` }
      : sendAge > 4000 ? { light: "bad", text: `phone can't reach the Mac — ${ago(sendAge).replace(" ago", "")}${upload.backlog ? `, ${upload.backlog} frames waiting` : ""}` }
      : { light: "ok", text: `${Math.round((s?.audioMsIn ?? 0) / 1000)}s ${isFile ? "fed" : "received"}` };

    const res = s?.lastResult;
    const ear: { light: Light; text: string } = !running && !hear ? { light: "off", text: "—" }
      : res && res.status >= 400 ? { light: "bad", text: res.note }
      : res && res.status === 0 ? { light: "bad", text: res.note }
      : hear ? { light: "ok", text: `${ago(age(hear.at))}${hear.ms ? ` · ${(hear.ms / 1000).toFixed(1)}s` : ""}` }
      : (s?.chunksOut ?? 0) > 0 ? { light: "wait", text: res?.note ?? "transcribing…" }
      : { light: "wait", text: "waiting for a pause in speech" };

    const judgeBad = err && (!judge || err.at > judge.at);
    const think: { light: Light; text: string } = !hear && !judge ? { light: running ? "wait" : "off", text: running ? "after the first line" : "—" }
      : judgeBad ? { light: "bad", text: err!.text }
      : judge ? { light: "ok", text: judge.text.replace(/ on the board$/, "") }
      : { light: "wait", text: "judging…" };

    const board: { light: Light; text: string } = cards > 0 ? { light: "ok", text: `${cards} card${cards === 1 ? "" : "s"}${paint ? ` · ${ago(age(paint.at))}` : ""}` }
      : hear ? { light: "wait", text: "nothing card-worthy yet" }
      : { light: running ? "wait" : "off", text: "empty" };

    const stages = [
      { key: isFile ? "File" : "Mic", ...mic }, { key: "Box", ...box }, { key: "Heard", ...ear }, { key: "Judged", ...think }, { key: "Board", ...board },
    ];
    const bad = stages.find((x) => x.light === "bad");
    const verdict: { light: Light; text: string } =
      phase === "ended" ? { light: "off", text: "Meeting ended." }
      : phase === "ending" ? { light: "wait", text: "Wrapping up — sending the last words…" }
      : !running ? { light: "off", text: "Not listening." }
      : bad ? { light: "bad", text: `${bad.key}: ${bad.text}` }
      : isFile && stages.every((x) => x.light === "ok") ? { light: "ok", text: `Playing the recording — ${cards} card${cards === 1 ? "" : "s"} up. You can lock the phone; the Mac finishes it.` }
      : isFile ? { light: "ok", text: "Playing the recording — the first line appears at the first pause." }
      : stages.every((x) => x.light === "ok") ? { light: "ok", text: `Working — Minami is hearing you and has ${cards} card${cards === 1 ? "" : "s"} up.` }
      : hear ? { light: "ok", text: "Working — hearing you, waiting for something card-worthy." }
      : mic.light === "wait" ? { light: "wait", text: "Listening — say something; nothing loud enough yet." }
      : { light: "wait", text: "Listening — the first line appears after you pause." };
    return { stages, verdict, cards };
  }, [status, graph, phase, hidden, touch, source, upload.backlog]);

  const heard = (status?.trace ?? []).filter((e) => e.kind === "hear").slice(-4).reverse();

  const cards = useMemo(() => {
    const nodes = graph?.nodes ?? [];
    const topic = new Map(nodes.filter((n) => n.kind === "topic").map((n) => [n.id, n.label]));
    return nodes.filter((n) => n.kind !== "topic").slice().reverse().map((n) => ({ n, topic: n.parent ? topic.get(n.parent) : undefined }));
  }, [graph]);

  const errors = status?.stats?.errors ?? [];

  return (
    <main onClick={() => { if (live.current && wake === "off") void lockScreen(); }} className="mx-auto flex min-h-[100dvh] max-w-xl flex-col gap-3 px-4 pb-10 pt-[max(env(safe-area-inset-top),12px)] text-white/90">
      <header className="flex items-center justify-between">
        <Link href="/" className="rounded-lg px-2 py-1 text-sm text-white/50 active:bg-white/10">← Bento</Link>
        <h1 className="text-[15px] font-semibold tracking-tight">Minami Meet</h1>
        <Link href="/meetings" className="rounded-lg px-2 py-1 text-sm text-white/50 active:bg-white/10">Past</Link>
      </header>

      {/* Verdict — the one line to read at a glance. */}
      <div role="status" aria-live="polite" className={`flex items-start gap-2.5 rounded-2xl border px-4 py-3 text-[15px] leading-snug ${TONE[strip.verdict.light]}`}>
        <Dot light={strip.verdict.light} big />
        <span>{strip.verdict.text}</span>
      </div>

      {/* The outcome first: after End, "did it save?" is the question, not "start another". */}
      {summary && (
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-[14px]">
          <div className="mb-1 font-medium">Saved</div>
          <div className="text-white/60">
            {summary.minutes?.toFixed?.(1) ?? "?"} min · {summary.utterances ?? 0} utterances · {summary.cards ?? 0} cards · {summary.topics ?? 0} topics
            {typeof summary.cost === "number" ? ` · $${summary.cost.toFixed(3)}` : ""}
          </div>
          {summary.archived ? <Link href="/meetings" className="mt-2 inline-block text-emerald-300 underline-offset-2 active:underline">Open in past meetings →</Link>
            : <div className="mt-2 text-amber-300/80">Not archived — nothing was captured.</div>}
          {status?.stats?.keep && (
            <div className="mt-1 text-[12.5px] text-white/45">
              {status.stats.audioSaved ? "🎧 Audio saved with the notes." : status.stats.summary ? "Audio was not saved — see Box errors." : "Saving the audio…"}
            </div>
          )}
        </section>
      )}

      {(phase === "idle" || phase === "ended") && (
        <section className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
          <div role="tablist" className="grid grid-cols-2 gap-1 rounded-xl bg-black/30 p-1">
            {([["mic", "🎙 Live in the room"], ["file", "📼 A recording"]] as const).map(([k, label]) => (
              <button key={k} role="tab" aria-selected={source === k} onClick={() => setSource(k)}
                className={`rounded-lg py-2 text-[14px] ${source === k ? "bg-white/15 text-white" : "text-white/50"}`}>{label}</button>
            ))}
          </div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What's this meeting? (optional)"
            className="rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-[15px] outline-none focus:border-white/30" />
          {source === "mic" ? (
            <textarea value={context} onChange={(e) => setContext(e.target.value)} rows={2} placeholder="Who's in it, what you want out of it (optional) — helps topics and names"
              className="resize-none rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-[14px] outline-none focus:border-white/30" />
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-white/20 bg-black/30 px-3 py-3 text-[14px]">
                <span className="text-xl">📁</span>
                <span className={`min-w-0 flex-1 truncate ${file ? "text-white" : "text-white/45"}`}>
                  {file ? `${file.name} · ${(file.size / 1048576).toFixed(1)} MB` : "Choose an audio or video file"}
                </span>
                <input type="file" accept="audio/*,video/*,.m4a,.mp3,.wav,.aac,.ogg,.opus,.webm,.mp4,.amr" className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
              <div className="flex items-center gap-2 text-[13px] text-white/55">
                <span className="w-12 shrink-0">Speed</span>
                <div className="grid flex-1 grid-cols-4 gap-1 rounded-xl bg-black/30 p-1">
                  {SPEEDS.map((x) => (
                    <button key={x} onClick={() => setSpeed(x)}
                      className={`rounded-lg py-1.5 ${speed === x ? "bg-white/15 text-white" : "text-white/50"}`}>{x === 1 ? "1× live" : `${x}×`}</button>
                  ))}
                </div>
              </div>
            </>
          )}
          <label className="flex items-center gap-2.5 px-1 py-1 text-[13.5px] text-white/70">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} className="h-4 w-4 accent-emerald-500" />
            Save the audio with the notes
          </label>
          {!touch && (
            <label className="flex items-center gap-2.5 px-1 pb-1 text-[13.5px] text-white/70">
              <input type="checkbox" checked={present} onChange={(e) => setPresent(e.target.checked)} className="h-4 w-4 accent-emerald-500" />
              Also open the board on this screen (memes included)
            </label>
          )}
          <button onClick={source === "mic" ? start : startRecording} disabled={source === "file" && !file}
            className="mt-1 rounded-2xl bg-emerald-500 py-4 text-[17px] font-semibold text-black active:bg-emerald-400 disabled:opacity-40">
            {source === "mic" ? "🎙 Start listening" : `▶ Play recording${speed > 1 ? ` at ${speed}×` : ""}`}
          </button>
          <p className="text-[12px] leading-relaxed text-white/40">
            {source === "mic"
              ? "This device's mic streams to your Mac; everything else happens there. Keep this screen open while it listens."
              : "The file uploads to your Mac, which plays it through Minami. The board and memes build as it plays, then it's saved like any meeting. You can lock the phone once it's uploaded."}
          </p>
          <p className="text-[12px] leading-relaxed text-white/40">
            Room TV or laptop: open <span className="font-mono text-white/60">{host}/meet/screen</span> before you start. The board appears on it by itself.
          </p>
        </section>
      )}

      {phase === "starting" && (
        <div className="rounded-2xl border border-white/10 p-4 text-center text-white/60">
          {uploadPct !== null ? (
            <>
              <div>Uploading… {Math.round(uploadPct * 100)}%</div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full bg-emerald-400" style={{ width: `${uploadPct * 100}%` }} /></div>
            </>
          ) : source === "file" ? "Uploading…" : "Asking for the mic…"}
        </div>
      )}

      {(phase === "live" || phase === "ending") && (
        <section className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-3">
          <div className="flex items-center gap-3">
            {status?.stats?.source === "file" && status.stats.file?.totalMs
              ? <Progress frac={status.stats.file.doneMs / status.stats.file.totalMs} />
              : <Meter level={level} />}
            <span className="w-14 text-right font-mono text-[13px] tabular-nums text-white/60">
              {status?.stats ? clock(Date.now() - (status.recvAt - status.now) - status.stats.startedAt) : "0:00"}
            </span>
          </div>
          <button onClick={stop} disabled={phase === "ending"}
            className="rounded-2xl bg-rose-500 py-4 text-[17px] font-semibold text-white active:bg-rose-400 disabled:opacity-50">
            {phase === "ending" ? "Ending…" : status?.stats?.source === "file" ? "■ Stop here and save" : "■ End meeting"}
          </button>
          {wake !== "on" && phase === "live" && status?.stats?.source !== "file" && (
            <p className="text-[12px] text-amber-300/80">
              {wake === "unsupported" ? "This browser can't keep the screen on — turn screen timeout up while listening." : "Screen may sleep — tap anywhere to keep it awake."}
            </p>
          )}
        </section>
      )}

      {error && <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-[14px] text-rose-200">{error}</div>}

      {/* The room's view: the full canvas with memes, on whatever screen everyone is looking at. */}
      {id && (phase === "live" || phase === "ending" || phase === "ended") && (
        <section className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-3 text-[13px]">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-white/80">Room screen</span>
            <button onClick={() => window.open(boardUrl(id), "minami-board")}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-white/85 active:bg-white/20">Open the board here ↗</button>
          </div>
          <div className="flex items-center gap-2 text-white/50">
            <span className="min-w-0 flex-1">On the TV or laptop: <span className="font-mono text-white/70">{host}/meet/screen</span></span>
            <button onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}/meet/screen`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
              className="shrink-0 rounded-lg px-2 py-1 text-white/60 active:bg-white/10">{copied ? "Copied" : "Copy"}</button>
          </div>
        </section>
      )}

      {/* The strip: the first non-green stage is where it broke. */}
      {phase !== "idle" && (
        <section className="overflow-hidden rounded-2xl border border-white/10">
          {strip.stages.map((st, i) => (
            <div key={st.key} className={`flex items-center gap-3 px-4 py-2.5 ${i ? "border-t border-white/[0.06]" : ""}`}>
              <Dot light={st.light} />
              <span className="w-16 shrink-0 text-[13px] font-medium text-white/70">{st.key}</span>
              <span className={`min-w-0 flex-1 truncate text-right text-[13px] ${st.light === "bad" ? "text-rose-300" : "text-white/50"}`}>{st.text}</span>
            </div>
          ))}
          <div className="border-t border-white/[0.06] px-4 py-2 font-mono text-[11px] text-white/35">
            {status?.stats?.source === "file" ? "from a file" : <>sent {upload.sent}</>}{status?.stats?.source === "file" ? "" : ` · retries ${upload.failed}`}{upload.dropped ? ` · dropped ${upload.dropped}` : ""}
            {status?.stats ? ` · utterances ${status.stats.chunksOut}` : ""}
            {upload.lastErr ? ` · ${upload.lastErr}` : ""}
          </div>
        </section>
      )}

      {cards.length > 0 && (
        <section>
          <h2 className="mb-1.5 px-1 text-[12px] font-medium uppercase tracking-wider text-white/40">Board · {strip.cards}</h2>
          <ul className="flex flex-col gap-1.5">
            {cards.map(({ n, topic }) => <Card key={n.id} n={n} topic={topic} />)}
          </ul>
        </section>
      )}

      {heard.length > 0 && (
        <section>
          <h2 className="mb-1.5 px-1 text-[12px] font-medium uppercase tracking-wider text-white/40">Heard</h2>
          <ul className="flex flex-col gap-1.5">
            {heard.map((h) => (
              <li key={h.at} className="rounded-xl bg-white/[0.04] px-3 py-2 text-[14px] leading-snug text-white/80">
                {spoken(h.text)}
                <span className="ml-2 text-[11px] text-white/30">{new Date(h.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {errors.length > 0 && (
        <details className="rounded-2xl border border-white/10 px-4 py-2 text-[12px] text-white/50">
          <summary>Box errors ({errors.length})</summary>
          <ul className="mt-1 flex flex-col gap-1 font-mono">{errors.slice().reverse().map((e) => <li key={e.at}>{new Date(e.at).toLocaleTimeString()} {e.text}</li>)}</ul>
        </details>
      )}
    </main>
  );
}

const TONE: Record<Light, string> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
  wait: "border-amber-400/30 bg-amber-400/10 text-amber-100",
  bad: "border-rose-500/40 bg-rose-500/15 text-rose-100",
  off: "border-white/10 bg-white/[0.03] text-white/60",
};

function Dot({ light, big }: { light: Light; big?: boolean }) {
  const c = { ok: "bg-emerald-400", wait: "bg-amber-400", bad: "bg-rose-500", off: "bg-white/20" }[light];
  return <span aria-label={light} className={`mt-[3px] inline-block shrink-0 rounded-full ${big ? "h-3 w-3" : "h-2.5 w-2.5"} ${c} ${light === "ok" && big ? "animate-pulse" : ""}`} />;
}

/** How far through a recording the Mac has fed. */
function Progress({ frac }: { frac: number }) {
  return (
    <div className="h-3 flex-1 overflow-hidden rounded-full bg-white/10" aria-label="recording progress">
      <div className="h-full rounded-full bg-sky-400 transition-[width] duration-500" style={{ width: `${Math.min(100, frac * 100)}%` }} />
    </div>
  );
}

/** Peak, on a square-root scale: speech at a metre sits around 0.05–0.2 linear, which would be a
 *  sliver on a linear bar and read as "barely hearing me". */
function Meter({ level }: { level: number }) {
  const pct = Math.min(100, Math.sqrt(level) * 100);
  return (
    <div className="h-3 flex-1 overflow-hidden rounded-full bg-white/10" aria-label="mic level">
      <div className={`h-full rounded-full transition-[width] duration-150 ${level > 0.02 ? "bg-emerald-400" : "bg-white/25"}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function Card({ n, topic }: { n: GNode; topic?: string }) {
  return (
    <li className={`rounded-xl border border-white/[0.07] bg-white/[0.04] px-3 py-2 ${n.placeholder ? "opacity-50" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="mt-[1px] w-4 shrink-0 text-center text-white/50" title={KIND_LABEL[n.kind]}>{KIND_ICON[n.kind]}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] leading-snug">{n.label}</div>
          {n.detail && <div className="mt-0.5 text-[12.5px] leading-snug text-white/50">{n.detail}</div>}
          <div className="mt-1 text-[11px] text-white/30">
            {KIND_LABEL[n.kind]}{topic && topic !== "Meeting" ? ` · ${topic}` : ""}{n.placeholder ? " · warm-up guess" : ""}
          </div>
        </div>
      </div>
    </li>
  );
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
