"use client";
// The meeting canvas — the page Recall.ai streams as Minami's screen share.
//
// Three modes, one route:
//   /canvas              live — renders whatever Graph the producer last POSTed (SSE)
//   /canvas?demo=1       frozen overview, for judging composition
//   /canvas?play=pilot   scripted meeting + operator panel, for judging the CHOREOGRAPHY
//
// Only the first is ever shared. The panel in play mode is explicitly not part of the stream — see
// the note in TranscriptPanel. Light surface by deliberate exception to the app's dark theme: the
// audience is customers, and a dark node graph reads as a developer tool.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_GRAPH, type GNode, type Graph } from "@/lib/canvas-graph";
import { GraphCanvas } from "@/components/canvas/GraphCanvas";
import { CutScene, useCutScenes, type Moment } from "@/components/canvas/CutScene";
import { Presence } from "@/components/canvas/Presence";
import { CommandDock } from "@/components/canvas/CommandDock";
import { DebugPanel } from "@/components/canvas/DebugPanel";
import { TranscriptPanel, type DebugLine, type Report, type Segment } from "@/components/canvas/TranscriptPanel";

/** What the live surface shows before anything has been said.
 *
 *  NOT the demo graph. Seeding with DEMO_GRAPH meant the bot screen-shared a fictional pilot meeting
 *  into a real room until the first SSE frame arrived — and a placeholder that looks exactly like
 *  real output is the worst kind. Empty is honest. */
const BLANK: Graph = { rev: 0, title: "Meeting", status: "live", nodes: [{ id: "root", kind: "topic", label: "Meeting" }], edges: [] };

export default function CanvasPage() {
  const [graph, setGraph] = useState<Graph>(BLANK);
  const [mode, setMode] = useState<"live" | "demo" | "play">("live");
  const rev = useRef(0);
  /** When a frame was last ACCEPTED — not merely received. See the note on the rev guard. */
  const lastAt = useRef(0);
  /** Connection state is tracked in REFS, not state. It was useState written once a second by an
   *  interval and never read in any JSX — a whole-canvas re-render per second, permanently, to update
   *  something invisible. Refs keep the diagnostic without the render. */
  const feed = useRef<"live" | "polling">("live");
  const seeded = useRef(false);
  /** Rendering for the Recall bot's 1280x720 @ 15fps stream rather than for a screen. */
  const [broadcast, setBroadcast] = useState(false);

  useEffect(() => {
    const q = new URL(window.location.href).searchParams;
    if (q.get("broadcast") === "1") {
      setBroadcast(true);
      document.documentElement.classList.add("broadcast");
    }
    // ?present=1 — displayed HERE and shared as a Chrome tab, instead of rendered by the Recall bot.
    // Deliberately adds `broadcast` as well: everything that makes the board readable to someone
    // watching a video stream still applies, only the 720p geometry does not. See GraphCanvas.
    const isPresent = q.get("present") === "1";
    if (isPresent) {
      setBroadcast(true);
      document.documentElement.classList.add("broadcast", "present");
    }
    // ⚠️ PRESENT MODE NEVER OPENS THE OPERATOR VIEW, even if ?live=1 is also on the URL.
    // The operator panel is safe when the BOT renders the page — the bot loads plain ?broadcast=1 and
    // nobody sees the tab. Sharing a tab shares everything in it, so the same panel would put the
    // model pipeline, spend and run controls in front of the room. A URL anh pasted from memory must
    // not be able to cause that, so present wins over live rather than the other way round.
    // ⚠️ SUPPRESS THE OPERATOR VIEW — do NOT return here. Returning early skipped the SSE
    // subscription set up below, so present mode showed "Minami is listening" forever while the
    // board filled up on the server: the exact failure described in the SSE note further down,
    // reproduced by hand. Present must fall THROUGH to the live path, not out of it.
    // ?live=1 (or ?play= for muscle memory) opens the real-audio view.
    if (!isPresent && (q.get("live") || q.get("play"))) { setMode("play"); return; }
    if (q.get("demo") === "1") { setMode("demo"); setGraph({ ...DEMO_GRAPH, focus: undefined }); return; }
    if (q.get("demo") === "focus") { setMode("demo"); setGraph(DEMO_GRAPH); return; }

    // Guard out-of-order frames: a reconnect replays the seed, and without this a stale seed could
    // overwrite a newer map mid-meeting.
    /** ⚠️ THE GUARD MUST BE ABLE TO RECOVER, or one bad frame blanks the screen for the whole call.
     *
     *  Dropping any frame older than the last accepted one is right — a reconnect replays the seed and
     *  a stale seed must not overwrite a newer board. But it had NO WAY BACK: once `rev.current` was
     *  ahead of anything the server would send again, every future frame was rejected, silently,
     *  forever. That is the single defect behind every "no cards shown" report in this project — the
     *  server healthy, the stream delivering, and the client refusing all of it.
     *
     *  Now a run of rejections is treated as evidence that the CLIENT is the one out of step: after
     *  three, it resyncs to whatever the server says. A stale frame can still lose a race; it can no
     *  longer win the war. */
    let stale = 0;
    /** ⚠️ THIS TAB PINS ITSELF TO ONE MEETING, AND NEVER RENDERS ANOTHER.
     *
     *  This surface is SCREEN-SHARED to a customer. Boards used to live in one global document, so a
     *  second meeting publishing anywhere on the server replaced what this tab was showing — proven
     *  twice on 2026-08-19, once by a stray probe and once by two bots in one room. A confidentiality
     *  failure, not a rendering glitch: the other room's decisions, on your screen, mid-call.
     *
     *  Pinning on the FIRST frame rather than from the URL is deliberate. The meeting id is Recall's
     *  bot id and does not exist until the bot has joined, so the launcher cannot put it in the URL it
     *  opens. The first board to arrive is by definition this tab's meeting. */
    let pinned: string | null = null;
    const accept = (next: Graph) => {
      if (!Array.isArray(next.nodes)) return;
      const mid = typeof next.meetingId === "string" ? next.meetingId : "";
      /** ⚠️ ONLY A REAL MEETING ID PINS. An empty one is the seed board, the pre-call reset, or a
       *  legacy caller — and pinning to "" would have been fatal in the obvious way: the SSE stream
       *  seeds every new subscriber with the empty board BEFORE any meeting has published, so the tab
       *  would have locked onto "" and then refused every genuine frame for the whole call. Exactly
       *  the permanent-blank-board failure this pin was written to prevent, caused by the pin. */
      if (mid) {
        if (pinned === null) pinned = mid;
        else if (mid !== pinned) {
          // Refused, loudly in the console and silently on screen: the room must see nothing change.
          console.warn(`[canvas] ignoring a frame from meeting "${mid}" — this tab is showing "${pinned}"`);
          return;
        }
      } else {
        /** ⚠️ AN UNOWNED FRAME RELEASES THE PIN, AND THIS IS NOT A DETAIL — IT IS THE LAUNCHER'S FLOW.
         *
         *  `Minami Call.command` resets the board and opens this tab BEFORE the bot joins, because the
         *  meeting id is Recall's bot id and does not exist yet. So the tab's first frame is whatever
         *  the server still holds — last meeting's board — and without this it would pin to the OLD
         *  meeting and then reject every frame from the new one, for the whole call.
         *
         *  Caught in QA doing exactly that: server showed 1 card, the tab showed "Minami is listening".
         *  A reset publishes an unowned board, so an unowned frame is the signal to let go. */
        if (pinned !== null) console.warn(`[canvas] board reset — releasing the pin on "${pinned}"`);
        pinned = null;
      }
      const r = next.rev ?? 0;
      /** ⚠️ STRICTLY GREATER, not >=. The poller runs every 4s and hands back the same document when
       *  nothing has changed; accepting an equal rev called setGraph with a NEW OBJECT IDENTITY, which
       *  invalidated the layout memo, re-ran layout(), and drove ~54 rAF frames of easing — for an
       *  identical board, four times a minute, all meeting, on the box that is also encoding video.
       *  `seeded` keeps the very first frame (rev may legitimately equal 0). */
      if (r > rev.current || !seeded.current) {
        seeded.current = true;
        stale = 0;
        rev.current = r;
        lastAt.current = Date.now();
        setGraph(next);
        return;
      }
      stale++;
      console.warn(`[canvas] dropped frame rev=${r} < ${rev.current} (${stale} in a row)`);
      if (stale >= 3) {
        console.warn("[canvas] resyncing — the server is authoritative, not this tab");
        stale = 0;
        rev.current = r;
        lastAt.current = Date.now();
        setGraph(next);
      }
    };

    // ── SSE, WITH A POLLING FALLBACK ──────────────────────────────────────────────────────────
    //
    // ⚠️ SSE DOES NOT SURVIVE A CLOUDFLARE QUICK TUNNEL. Measured 2026-08-12 against a live meeting:
    // the same server delivered 2 frames to localhost and ZERO through the tunnel, so the bot's
    // browser rendered "Minami is listening" for the whole call while the board filled up correctly
    // on the server. Six cards existed; the room saw none of them.
    //
    // That is the worst failure shape this surface has: everything is healthy, every log is clean,
    // and the product is simply blank. It cannot be allowed to depend on a streaming connection
    // surviving whatever proxy sits in front of it — and the bot is ALWAYS behind one, because it
    // loads the page from the public internet.
    //
    // So: try SSE, and if no frame arrives within a few seconds, fall back to polling and stay there.
    // Polling is boring and works through anything. At 2s against a 15fps screenshare the difference
    // is imperceptible, and the cost is one small request per two seconds.
    /** ⚠️ POLLING RUNS ALWAYS, not only after SSE is seen to fail.
     *
     *  It used to start only on an error or a 6s silence, which assumes a stream that breaks does so
     *  LOUDLY. EventSource does not: a half-open connection — laptop sleep, network change, a proxy
     *  dropping an idle stream — delivers nothing and fires no error, so the fallback that exists for
     *  exactly this case never armed. The board simply stopped updating.
     *
     *  A poll every 4s costs one small local request and removes the entire class. SSE stays for
     *  latency; polling is the floor under it. Whichever arrives first wins, and `accept` orders them. */
    const tick = async () => {
      // Scoped once known. Without this the poller would happily fetch whatever board was published
      // most recently — the same leak the pin exists to close, arriving by a different route.
      const q = pinned === null ? "" : `?meeting=${encodeURIComponent(pinned)}`;
      try { accept((await (await fetch(`/api/canvas${q}`, { cache: "no-store" })).json()) as Graph); }
      catch { /* a failed poll is one stale frame, not a broken board */ }
    };
    void tick();
    const poll = setInterval(tick, 4000);

    const es = new EventSource("/api/canvas?stream=1");
    es.onmessage = (e) => {
      feed.current = "live";
      try { accept(JSON.parse(e.data) as Graph); }
      catch { /* a malformed frame must never blank a live screen share — keep the last good graph */ }
    };
    es.onerror = () => { feed.current = "polling"; };

    // How long since anything was ACCEPTED — the number that makes a dead feed visible instead of
    // leaving a blank board looking exactly like a quiet meeting.


    return () => {
      clearInterval(poll);
      es.close();
    };
  }, []);

  if (mode === "play") return <AudioMode />;
  return (
    <main className="canvas-surface relative h-dvh w-dvw overflow-hidden">
      <Stage graph={graph} />
    </main>
  );
}

/** Canvas + floating chrome. Shared by every mode so the shared view and the demo view can't drift. */
function Stage({ graph, presence }: { graph: Graph; presence?: "listening" | "thinking" | "idle" }) {
  const status = graph.status ?? "live";

  // Read in an EFFECT, never during render.
  //
  // This was `typeof window !== "undefined" && new URL(location.href)...` inline in the JSX, which is
  // the textbook hydration mismatch: the server renders without the guide, the client renders with it,
  // React finds the trees disagree and THROWS THE WHOLE TREE AWAY to regenerate it. On a debug flag
  // that looks harmless; on a surface being screen-shared it means a full re-render and a visible
  // flash, and it was live in every broadcast frame that carried ?safebox=1.
  const [safebox, setSafebox] = useState(false);
  useEffect(() => {
    setSafebox(new URL(window.location.href).searchParams.get("safebox") === "1");
  }, []);

  // REACTIONS BECOME MOMENTS.
  //
  // The graph is re-sent whole on every frame, so this cannot ask "what changed" by comparing to the
  // previous graph — a card that keeps its 🔥 would re-fire on every tick. Identity is the (node,
  // emoji) pair and the queue remembers what it has already played, so each reaction gets exactly one
  // cut scene for the life of the board however many times the frame repeats it.
  const scenes = useCutScenes();
  const { offer } = scenes;
  useEffect(() => {
    const moments: Moment[] = [];
    for (const n of graph.nodes ?? []) {
      for (const r of n.reactions ?? []) {
        moments.push({ id: `${n.id}:${r.emoji}`, emoji: r.emoji, label: n.label });
      }
    }
    if (moments.length) offer(moments);
  }, [graph, offer]);

  const empty = (graph.nodes ?? []).length <= 1;

  return (
    <div className={empty ? "canvas-empty-frame contents" : "contents"}>
      {/* The lone root pill is not a board, it is the absence of one — and rendered under the empty
          state it collides with the very sentence explaining that nothing has been said yet. Skip the
          canvas entirely until there is something on it. */}
      {empty ? null : <GraphCanvas graph={graph} />}
      {/* Scrim under the floating chrome. The camera can only keep the FOCUSED neighbourhood clear of
          the header; a card from an unrelated branch can still sit at those coordinates, and the
          title then renders on top of it and becomes unreadable. A soft fade keeps the type legible
          whatever slides underneath, without drawing a hard bar across the canvas. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-32"
        style={{ background: "linear-gradient(to bottom, rgba(244,244,242,0.92), rgba(244,244,242,0))" }}
      />
      <header className="canvas-header pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-6 p-7">
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-semibold tracking-[-0.01em] text-neutral-800">
            {graph.title ?? "Meeting"}
          </h1>
          {graph.subtitle ? <p className="mt-0.5 truncate text-[13px] text-neutral-500">{graph.subtitle}</p> : null}
        </div>
        <span className="flex shrink-0 items-center gap-2 rounded-full bg-white/85 px-3 py-1.5 shadow-[0_1px_2px_rgba(16,24,40,0.06),0_4px_12px_-4px_rgba(16,24,40,0.10)] backdrop-blur">
          <span className="size-1.5 rounded-full" style={{ background: status === "live" ? "#1baf7a" : "#a3a3a3" }} />
          <span className="text-[12px] font-medium capitalize text-neutral-600">{status}</span>
          <span className="text-[12px] text-neutral-300">·</span>
          <span className="text-[12px] text-neutral-500">Minami</span>
        </span>
      </header>
      {/* NOTHING SAID YET.
          A board with only its root node rendered as one small pill adrift in an empty frame, which
          reads as broken rather than as ready — anh's first look at a live meeting was exactly this,
          and his note was "no clues on bot listening". An empty state has to say which of the two it
          is, because the viewer cannot tell by looking.
          It disappears the moment a real card exists, so it costs nothing once a meeting is running. */}
      {empty ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          {/* ONE COMPOSITION, NOT THREE ELEMENTS.
              The first version had a centred stack, a status pill in the top-right and a Listening
              pill in the bottom-left corner — three separate things floating in a mostly empty 16:9
              frame, each correct on its own and reading as unfinished together. On a shared screen
              the empty state is the most-seen frame in the product, so it gets composed as a single
              object: one column, one rhythm, everything on the same vertical axis. */}
          <div className="relative flex flex-col items-center">
            {/* A soft stage behind the words. The safe box is portrait inside a landscape frame, so
                without something occupying the middle the eye reads the whole picture as blank. A
                large, very low-contrast glow is also the cheapest possible thing for the encoder —
                unlike the dot grid it replaced. */}
            <div
              className="absolute -inset-x-40 -inset-y-28 -z-10 rounded-[64px]"
              style={{ background: "radial-gradient(60% 55% at 50% 50%, rgba(255,255,255,0.9), rgba(255,255,255,0) 70%)" }}
              aria-hidden
            />

            <span className="flex items-end gap-2" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="size-2.5 rounded-full bg-neutral-400"
                  style={{ animation: `emptyPulse ${2.6 + i * 0.4}s cubic-bezier(0.37,0,0.63,1) ${i * 0.45}s infinite` }}
                />
              ))}
            </span>

            <span className="canvas-empty-title mt-6 text-[26px] font-semibold tracking-[-0.02em] text-neutral-800">
              Minami is listening
            </span>
            <span className="canvas-empty-sub mt-3 max-w-[420px] text-center text-[15px] leading-relaxed text-neutral-500">
              Decisions, actions and open questions appear here as you talk.
            </span>

            {/* The three kinds this board captures, stated once. It tells the room what to expect
                before anything exists, and it quietly teaches the colour language they are about to
                start reading — so the first real card lands as recognition rather than as novelty. */}
            <span className="mt-9 flex items-center gap-6" aria-hidden>
              {[
                { c: "#1baf7a", t: "Decision" },
                { c: "#2a78d6", t: "Action" },
                { c: "#e0a03a", t: "Question" },
              ].map((k) => (
                <span key={k.t} className="flex items-center gap-2">
                  <span className="size-2 rounded-full" style={{ background: k.c }} />
                  <span className="text-[13px] font-medium tracking-[0.01em] text-neutral-500">{k.t}</span>
                </span>
              ))}
            </span>
          </div>
        </div>
      ) : null}
      {/* SAFE BOX GUIDE — `?safebox=1`. Draws the 500x600 region the camera targets, because a rule
          about what stays on screen is only enforceable if you can see where the line is. Never on by
          accident: it is a separate flag from ?broadcast=1, so the bot cannot ship it into a meeting
          just because someone left it on. */}
      {safebox ? (
        <div
          className="pointer-events-none absolute z-30 border-2 border-dashed border-rose-400/70"
          style={{ left: 390, right: 390, top: 60, bottom: 60 }}
        >
          <span className="absolute -top-6 left-0 text-[11px] font-bold uppercase tracking-[0.14em] text-rose-400">
            safe box · 500 × 600
          </span>
        </div>
      ) : null}
      {graph.reaction ? <Reaction kind={graph.reaction.kind} label={graph.reaction.label} /> : null}
      <CutScene moment={scenes.current} onDone={scenes.done} />
      {/* Always shown on the live surface, defaulting to "listening": this is the bot's own screen
          share, and it is ALWAYS listening while it is in the room. Passing nothing meant the one
          indicator that answers "is this working" was absent from the only view that needed it.
          Hidden while the board is empty, because the empty state already says it — larger, centred
          and in the same breath as everything else. Two things saying "listening" in two corners is
          how the frame ended up looking unfinished. */}
      {empty ? null : <Presence state={presence ?? "listening"} />}
      {/* Controls live in their own layer, revealed by pointer proximity — see CommandDock for why
          they must not be permanently visible on a tab that is being screen-shared. */}
      {/* NOT gated on `empty`. The presence pill is hidden before the first card because there is
          nothing to be present ABOUT — but the controls are needed most at minute zero: choosing the
          ear, or typing the first card, happens before anything is on the board. Hiding them until a
          card arrives made the ear picker unreachable exactly when it mattered. */}
      <CommandDock />
      {/* Opposite corner from the dock, off by default, remembered per browser. This tab is the one
          anh screen-shares in present mode, so the trace is opt-in rather than ambient — but when a
          board goes blank or stale mid-call, this is the difference between guessing and reading. */}
      <DebugPanel
        clientCards={graph.nodes.filter((n) => n.kind !== "topic").length}
        clientRev={graph.rev}
      />
    </div>
  );
}

/** Real audio ingest.
 *
 *  Replaces the scripted player entirely. Nothing here is pre-authored: the audio is transcribed, a
 *  model decides what is worth keeping, and the server validates every action before it touches the
 *  board. What you watch is what the model actually did.
 *
 *  The arm buttons pick WHICH pipeline does that (§17). Each run ends with a `report` the panel keeps
 *  per arm, so two arms can be compared on latency, cost and the accuracy proxies.
 *
 *  Everything arrives over one SSE stream, so the transcript and the canvas can never disagree about
 *  what happened — the same events drive both. */
function AudioMode() {
  const [graph, setGraph] = useState<Graph>({ nodes: [{ id: "root", kind: "topic", label: "Meeting" }] });
  const [segments, setSegments] = useState<Segment[]>([]);
  const [running, setRunning] = useState(false);
  const [minutes, setMinutes] = useState(1);
  const [mode, setMode] = useState("live");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept ACROSS runs and keyed by arm — clearing this on each run would destroy the comparison the
  // moment you started the second arm, which is the only time it matters.
  const [reports, setReports] = useState<Record<string, Report>>({});
  // A pause while the model thinks is indistinguishable from a pause because nothing was said, which
  // is indistinguishable from broken. Naming the state is the cheapest fix for the worst ambiguity
  // on this surface.
  const [presence, setPresence] = useState<"listening" | "thinking" | "idle">("idle");
  // Cleared per run, unlike the scorecard: a trace from the previous arm interleaved with this one
  // is worse than no trace at all.
  const [debug, setDebug] = useState<DebugLine[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    if (watchdogRef.current) { clearInterval(watchdogRef.current); watchdogRef.current = null; }
    setRunning(false);
    setPresence("idle");
  }, []);

  const run = useCallback((mins: number, arm: string, pace = "1", feed = "serial", source = "openai") => {
    stop();
    setMinutes(mins);
    setMode(arm);
    setSegments([]);
    setDebug([]);
    setProgress(null);
    setError(null);
    setGraph({ nodes: [{ id: "root", kind: "topic", label: "Meeting" }], status: "live" });
    setRunning(true);
    setPresence("listening");

    const es = new EventSource(
      `/api/canvas/live?minutes=${mins}&mode=${encodeURIComponent(arm)}&pace=${encodeURIComponent(pace)}&feed=${encodeURIComponent(feed)}&source=${encodeURIComponent(source)}`,
    );
    esRef.current = es;

    let total = 0;
    let done = 0;
    // Buffer the transcript for a chunk until its actions arrive, so a segment renders as one
    // complete unit — line plus what it caused — rather than text first and consequences later.
    let held: { at: string; lines: string[] } | null = null;

    es.addEventListener("meta", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      total = d.chunks;
      setProgress({ done: 0, total });
    });

    es.addEventListener("transcript", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      held = { at: d.at, lines: d.lines };
      lastWords = Date.now();
      // Words arrived; the judgement on them hasn't. That gap is exactly the moment the canvas used
      // to look frozen.
      setPresence("thinking");
    });

    es.addEventListener("graph", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setGraph(d.graph);
      if (held) {
        const seg = held;
        setSegments((s) => [...s, { at: seg.at, lines: seg.lines, actions: d.actions, dropped: d.dropped }]);
        held = null;
      }
      // Only a real chunk advances progress. A tidy or relate pass also sends a graph, and counting
      // those pushed `done` past `total` mid-run — which retired the progress bar early and left the
      // presence indicator stuck, since this was the only path back out of "thinking".
      if (d.chunkDone) {
        done += 1;
        setProgress({ done, total });
      }
      setPresence(done >= total ? "idle" : "listening");
    });

    // Watchdog. "Thinking" is only ever true while a judgement is genuinely in flight, and on a
    // paced feed the gap between chunks is mostly silence — the indicator should say "listening"
    // then, which is the truth and also the state the viewer needs to see to keep talking. Without
    // this, a single missed graph event strands it on "thinking" for the rest of the meeting.
    let lastWords = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastWords > 2500) setPresence((p) => (p === "thinking" ? "listening" : p));
    }, 500);
    watchdogRef.current = watchdog;

    es.addEventListener("debug", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as DebugLine;
      // Also to the console, so a trace survives a page you already navigated away from.
      console.debug(`[canvas ${d.atMs}ms] #${d.index} ${d.stage} — ${d.note}`);
      setDebug((prev) => [...prev, d]);
    });

    es.addEventListener("report", (e) => {
      const r = JSON.parse((e as MessageEvent).data) as Report;
      setReports((prev) => ({ ...prev, [r.mode]: r }));
    });

    // A chunk that failed to transcribe or judge is not a failed run — it's one of the numbers the
    // scorecard exists to count. Surface it without tearing the stream down.
    es.addEventListener("warn", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      console.warn(`[canvas] ${d.stage} chunk ${d.index}: ${d.error}`);
    });

    es.addEventListener("fail", (e) => {
      setError(JSON.parse((e as MessageEvent).data).error);
      stop();
    });

    es.addEventListener("done", () => stop());

    // EventSource retries on its own; on a finished stream that would restart the whole run, which
    // would silently re-bill the transcription. Close instead and let the user press again.
    es.onerror = () => stop();
  }, [stop]);

  // stop() closes the EventSource AND clears the watchdog; closing only the former left a 500ms
  // interval calling setPresence on an unmounted component for the life of the page.
  useEffect(() => stop, [stop]);

  return (
    <main className="flex h-dvh w-dvw overflow-hidden">
      <div className="canvas-surface relative min-w-0 flex-1">
        <Stage graph={graph} presence={presence} />
      </div>
      <TranscriptPanel
        segments={segments}
        running={running}
        minutes={minutes}
        mode={mode}
        progress={progress}
        error={error}
        reports={reports}
        debug={debug}
        onRun={run}
        onStop={stop}
      />
    </main>
  );
}

/** Full-canvas moment. A wash rather than a modal: the map stays visible through it, so the
 *  celebration lands without hiding the thing being celebrated. */
function Reaction({ kind, label }: { kind: "handshake" | "highfive" | "spark"; label?: string }) {
  const glyph = kind === "handshake" ? "🤝" : kind === "highfive" ? "🙌" : "✨";
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      <div className="absolute inset-0 bg-white/45 [animation:nodeIn_var(--dur-3)_var(--ease-out)_both]" />
      <div className="[animation:nodeIn_var(--dur-4)_var(--ease-spring)_both] relative flex flex-col items-center gap-2.5">
        <span className="text-[76px] leading-none drop-shadow-sm">{glyph}</span>
        {label ? (
          <span className="rounded-full bg-white px-5 py-2 text-[17px] font-semibold text-neutral-800 shadow-[0_2px_4px_rgba(16,24,40,0.08),0_12px_28px_-8px_rgba(16,24,40,0.18)]">
            {label}
          </span>
        ) : null}
      </div>
    </div>
  );
}
