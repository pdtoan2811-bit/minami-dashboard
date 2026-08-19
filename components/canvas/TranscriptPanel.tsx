"use client";
// The operator panel: what was heard, and what Minami did about it.
//
// NOT part of the screen share. Recall streams /canvas; this exists so you can watch the transcript
// and the canvas react in the same glance, which two windows can't give you.
//
// Actions render inline under the line that caused them, not in a separate log. A log answers "what
// happened"; inline answers "why" — did she keep the right line, did the camera move at the right
// moment. That is the thing you are actually judging.
import { useEffect, useRef, useState } from "react";
import { STATE_COLOR } from "@/lib/canvas-graph";
import { MODES, modelsOf, type ModeId } from "@/lib/canvas-modes";
import { AUDIO_SOURCES, DEFAULT_SOURCE } from "@/lib/canvas-audio";

export type Applied = { op: string; kind?: string; label?: string };
export type Segment = { at: string; lines: string[]; actions: Applied[]; dropped: number };

/** One `debug` event — a single stage of a single chunk. */
export type DebugLine = {
  index: number;
  stage: string;
  atMs: number;
  note: string;
  /** How far behind the audio this stage ran. Undefined for stages with no schedule of their own. */
  lagMs?: number;
};

/** The `report` event from /api/canvas/live — one arm's scorecard. */
export type Report = {
  mode: string;
  label: string;
  audioSeconds: number;
  chunks: number;
  chunkSeconds: number;
  ttfTranscriptMs: number;
  ttfCardMs: number;
  wallMs: number;
  realtimeFactor: number;
  cost: { transcribe: number; judge: number; relations: number; total: number; perAudioHour: number };
  calls: { transcribe: number; judge: number; relations: number };
  quality: {
    emptyChunks: number; wastedCalls: number; transcriptLines: number; topics: number;
    cards: number; edges: number; cardsProposed: number; dropRate: number;
    speakers: number; sttProfile: string;
  };
};

export const DURATIONS = [
  { label: "1 min", minutes: 1 },
  { label: "2 min", minutes: 2 },
  { label: "5 min", minutes: 5 },
  { label: "10 min", minutes: 10 },
  { label: "All", minutes: 0 },
];

/** Playback speed. The pipeline always runs flat out; this only decides how fast the RESULTS are
 *  released to the canvas. Arm A is slower than real time so pacing changes nothing there — but the
 *  ASR arms judge 15s of audio in about two seconds, so unpaced they dump a finished board on screen
 *  in one go and you never see it built. Latency in the scorecard is stamped before the gate, so a
 *  paced run and a max run report the same numbers. */
const PACES = [
  { label: "1×", pace: "1", hint: "real time" },
  { label: "2×", pace: "2", hint: "twice real time" },
  { label: "4×", pace: "4", hint: "four times real time" },
  { label: "Max", pace: "max", hint: "no pacing — as fast as the pipeline goes" },
];

/** Display-only mirror of lib/canvas-modes.ts. Deliberately not imported: that module reads
 *  process.env, and pulling it into a client bundle would evaluate those to undefined and quietly
 *  show defaults that don't match what the server is actually running. */
// Read straight off MODES rather than restated here. The hint and the model list used to be prose
// typed next to the buttons, which is how you end up choosing an arm by a description of what it
// used to do.
export const ARMS = (Object.keys(MODES) as ModeId[]).map((id) => ({
  id,
  label: MODES[id].label,
  hint: MODES[id].blurb,
  models: modelsOf(MODES[id]),
}));

export function TranscriptPanel({
  segments, running, minutes, mode, progress, error, reports, debug, onRun, onStop,
}: {
  segments: Segment[];
  running: boolean;
  minutes: number;
  mode: string;
  /** chunks done / total, so a long run doesn't look hung. */
  progress: { done: number; total: number } | null;
  error?: string | null;
  /** Last completed run per arm, so two arms can be read side by side rather than remembered. */
  reports: Record<string, Report>;
  debug: DebugLine[];
  onRun: (minutes: number, mode: string, pace: string, feed: string, source: string) => void;
  onStop: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  // Follow the stream — a transcript you have to babysit isn't one.
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [segments.length]);

  // The selection is a DRAFT until Start is pressed. Every one of these buttons used to launch a run
  // on click, which made picking an arm and picking a duration two separate billed runs and gave you
  // no way to change your mind — you were committed by the act of looking. Nothing bills until Start.
  const [pickMode, setPickMode] = useState(mode);
  const [pickMinutes, setPickMinutes] = useState(minutes);
  // Serial by default: it is the only setting that behaves like a meeting. Parallel exists to time
  // the pipeline, not to watch it.
  const [pickPace, setPickPace] = useState("1");
  const [pickFeed, setPickFeed] = useState("serial");
  const [pickSource, setPickSource] = useState(DEFAULT_SOURCE);

  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const pickedArm = ARMS.find((a) => a.id === pickMode);
  const alreadyRun = Boolean(reports[pickMode]);

  return (
    <aside className="flex h-dvh w-[390px] shrink-0 flex-col border-l border-neutral-200/80 bg-white/75 backdrop-blur-xl">
      <header className="border-b border-neutral-200/80 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-bold uppercase tracking-[0.13em] text-neutral-400">Live transcript</span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="size-1.5 rounded-full" style={{ background: running ? STATE_COLOR.agreed : "#c4c4c0" }} />
            <span className="text-[11px] font-semibold text-neutral-500">{running ? "listening" : "idle"}</span>
          </span>
        </div>

        {/* ── the run form ──────────────────────────────────────────────────────────────────
            Which arm. Same audio, same everything downstream of the transcript, so a difference in
            the scorecard is a difference in what was HEARD. A tick marks an arm you already have a
            result for — that's what tells you the comparison is ready to read. */}
        <Field label="Pipeline">
          <div className="grid grid-cols-2 gap-1">
            {ARMS.map((a) => (
              <button
                key={a.id}
                onClick={() => setPickMode(a.id)}
                disabled={running}
                title={a.hint}
                className={`rounded-lg px-1.5 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-40 ${
                  pickMode === a.id
                    ? "bg-neutral-900 text-white"
                    : "bg-neutral-100 text-neutral-600 enabled:hover:bg-neutral-200"
                }`}
              >
                {a.label}{reports[a.id] ? " ✓" : ""}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Recording">
          <div className="grid grid-cols-2 gap-1">
            {AUDIO_SOURCES.map((src) => (
              <button
                key={src.id}
                onClick={() => setPickSource(src.id)}
                disabled={running}
                title={src.file}
                className={`truncate rounded-lg px-2 py-1.5 text-[11.5px] font-semibold transition-colors disabled:opacity-40 ${
                  pickSource === src.id
                    ? "bg-neutral-900 text-white"
                    : "bg-neutral-100 text-neutral-600 enabled:hover:bg-neutral-200"
                }`}
              >
                {src.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Duration">
          <div className="grid grid-cols-5 gap-1">
            {DURATIONS.map((d) => (
              <button
                key={d.label}
                onClick={() => setPickMinutes(d.minutes)}
                disabled={running}
                className={`rounded-lg px-1.5 py-1.5 text-[11.5px] font-semibold transition-colors disabled:opacity-40 ${
                  pickMinutes === d.minutes
                    ? "bg-neutral-900 text-white"
                    : "bg-neutral-100 text-neutral-600 enabled:hover:bg-neutral-200"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Playback">
          <div className="grid grid-cols-4 gap-1">
            {PACES.map((p) => (
              <button
                key={p.label}
                onClick={() => setPickPace(p.pace)}
                disabled={running}
                title={p.hint}
                className={`rounded-lg px-1.5 py-1.5 text-[11.5px] font-semibold transition-colors disabled:opacity-40 ${
                  pickPace === p.pace
                    ? "bg-neutral-900 text-white"
                    : "bg-neutral-100 text-neutral-600 enabled:hover:bg-neutral-200"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Audio feed">
          <div className="grid grid-cols-2 gap-1">
            {[
              { id: "serial", label: "One by one", hint: "hand over each 15s only when it would have been spoken" },
              { id: "parallel", label: "All at once", hint: "slice the whole file and run everything concurrently" },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setPickFeed(f.id)}
                disabled={running}
                title={f.hint}
                className={`rounded-lg px-1.5 py-1.5 text-[11.5px] font-semibold transition-colors disabled:opacity-40 ${
                  pickFeed === f.id
                    ? "bg-neutral-900 text-white"
                    : "bg-neutral-100 text-neutral-600 enabled:hover:bg-neutral-200"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </Field>

        {/* What Start will actually do, spelled out — including that it bills. */}
        <p className="mt-2 rounded-lg bg-neutral-50 px-2.5 py-1.5 text-[11px] leading-snug text-neutral-500">
          <span className="font-semibold text-neutral-700">{pickedArm?.label}</span> · {pickedArm?.hint}
          <br />
          {pickMinutes === 0
            ? `all ~${AUDIO_SOURCES.find((x) => x.id === pickSource)?.minutes} min`
            : `${pickMinutes} min`} of audio · {PACES.find((p) => p.pace === pickPace)?.hint} · {pickFeed === "serial" ? "one chunk at a time" : "all chunks at once"} · real API calls, real cost
          {pickedArm ? (
            <>
              <br />
              <span className="mt-1 inline-block font-mono text-[10px] leading-[1.55] text-neutral-400">
                hear <span className="text-neutral-600">{pickedArm.models.hear}</span>
                <br />
                judge <span className="text-neutral-600">{pickedArm.models.judge}</span>
                <br />
                relate <span className="text-neutral-600">{pickedArm.models.relate}</span>
                {" · "}tidy <span className="text-neutral-600">{pickedArm.models.tidy}</span>
              </span>
            </>
          ) : null}
          {alreadyRun ? " · re-running replaces this arm's scorecard" : ""}
        </p>

        {running ? (
          <>
            <div className="mt-2.5 flex items-baseline justify-between text-[11px] font-semibold text-neutral-400">
              <span>{progress ? `chunk ${progress.done} of ${progress.total}` : "starting…"}</span>
              <span className="tabular-nums">{pct}%</span>
            </div>
            <div className="mt-1 h-1 rounded-full bg-neutral-100">
              <span className="block h-1 rounded-full bg-neutral-800 transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </div>
            <button
              onClick={onStop}
              className="mt-2 w-full rounded-lg bg-neutral-100 px-3 py-1.5 text-[12px] font-semibold text-neutral-600 hover:bg-neutral-200"
            >
              Stop
            </button>
          </>
        ) : (
          <button
            onClick={() => onRun(pickMinutes, pickMode, pickPace, pickFeed, pickSource)}
            className="mt-2 w-full rounded-lg bg-neutral-900 px-3 py-2 text-[12.5px] font-semibold text-white transition-colors hover:bg-neutral-700"
          >
            Start run
          </button>
        )}

        {error ? (
          <p className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-[11.5px] leading-snug text-red-700">{error}</p>
        ) : null}
      </header>

      <Scorecard reports={reports} />
      <StageLog lines={debug} />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {!segments.length ? (
          <p className="text-[12.5px] leading-snug text-neutral-400">
            Pick a pipeline and a duration, then press Start. The canvas builds from whatever that
            arm actually hears. Run the same duration on two arms to fill the scorecard and compare
            them.
          </p>
        ) : null}

        {segments.map((s, i) => (
          <div key={i} className="[animation:nodeIn_var(--dur-3)_var(--ease-out)_both]">
            <div className="tabular-nums mb-1 text-[11px] font-bold text-neutral-400">{s.at}</div>
            {s.lines.map((l, j) => (
              <p key={j} className="mb-1 text-[12.5px] leading-snug text-neutral-600">{l}</p>
            ))}

            {s.actions.length ? (
              <div className="mt-1.5 space-y-1 border-l-2 border-neutral-200 pl-2.5">
                {s.actions.map((a, j) => <ActionRow key={j} a={a} />)}
              </div>
            ) : (
              <p className="mt-1.5 text-[11px] italic text-neutral-300">nothing worth keeping</p>
            )}
            {s.dropped ? (
              <p className="mt-1 text-[11px] text-amber-600">{s.dropped} action(s) rejected by validation</p>
            ) : null}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <footer className="border-t border-neutral-200/80 px-4 py-2.5">
        <p className="text-[11px] leading-snug text-neutral-400">
          Operator view — not part of the screen share. Customers see only the canvas.
        </p>
      </footer>
    </aside>
  );
}

/** A labelled row in the run form. Exists so the two selectors read as settings you are choosing
 *  between, rather than as two rows of buttons that each do something. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-2.5">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-neutral-400">{label}</div>
      {children}
    </div>
  );
}

/** The A/B scorecard: every arm that has finished a run, side by side.
 *
 *  Comparing arms from memory doesn't work — the runs are minutes apart and the interesting deltas
 *  are in the second decimal place. Keeping the last report per arm is the whole point of the
 *  exercise, so it lives above the transcript rather than in a console log.
 *
 *  Rows are annotated with which direction is better, because half of these are "lower wins" and
 *  half are not, and a table that doesn't say so invites reading the wrong conclusion off it. */
function Scorecard({ reports }: { reports: Record<string, Report> }) {
  const arms = ARMS.filter((a) => reports[a.id]).map((a) => reports[a.id]);
  if (!arms.length) return null;

  const secs = (ms: number) => (ms ? `${(ms / 1000).toFixed(1)}s` : "—");
  const rows: { label: string; hint: string; cell: (r: Report) => string }[] = [
    { label: "1st transcript", hint: "lower is better", cell: (r) => secs(r.ttfTranscriptMs) },
    { label: "1st card", hint: "lower is better", cell: (r) => secs(r.ttfCardMs) },
    { label: "wall clock", hint: "lower is better", cell: (r) => secs(r.wallMs) },
    { label: "× realtime", hint: "higher is better", cell: (r) => (r.realtimeFactor ? `${r.realtimeFactor}×` : "—") },
    { label: "$ / audio-hr", hint: "lower is better", cell: (r) => `$${r.cost.perAudioHour.toFixed(3)}` },
    { label: "  ↳ ASR", hint: "", cell: (r) => `$${r.cost.transcribe.toFixed(4)}` },
    { label: "  ↳ judge", hint: "", cell: (r) => `$${(r.cost.judge + r.cost.relations).toFixed(4)}` },
    { label: "empty chunks", hint: "lower is better — audio simply lost", cell: (r) => String(r.quality.emptyChunks) },
    { label: "wasted calls", hint: "lower is better — paid for, returned nothing", cell: (r) => String(r.quality.wastedCalls) },
    { label: "topics", hint: "~3-6 for a short meeting; far more means mishearing", cell: (r) => String(r.quality.topics) },
    { label: "cards kept", hint: "of proposed", cell: (r) => `${r.quality.cards}/${r.quality.cardsProposed}` },
    { label: "drop rate", hint: "lower is better — ungrounded or duplicate", cell: (r) => `${Math.round(r.quality.dropRate * 100)}%` },
    { label: "speakers", hint: "0 on arm A is expected: its labels are invented", cell: (r) => String(r.quality.speakers) },
    { label: "req shape", hint: "which request the STT provider accepted", cell: (r) => r.quality.sttProfile || "—" },
  ];

  return (
    <div className="max-h-[38vh] shrink-0 overflow-y-auto border-b border-neutral-200/80 bg-neutral-50/70 px-4 py-3">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[12px] font-bold uppercase tracking-[0.13em] text-neutral-400">Scorecard</span>
        <span className="text-[10.5px] text-neutral-400">
          {arms.length === 1 ? "run another arm to compare" : `${arms[0].audioSeconds}s of audio`}
        </span>
      </div>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className="w-[42%] pb-1 text-left font-semibold text-neutral-400">metric</th>
            {arms.map((r) => (
              <th key={r.mode} className="pb-1 text-right font-semibold text-neutral-600">{r.label.split(" · ")[0]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-neutral-200/60">
              <td className="py-0.5 pr-1 text-neutral-500" title={row.hint}>{row.label}</td>
              {arms.map((r) => (
                <td key={r.mode} className="tabular-nums py-0.5 text-right font-medium text-neutral-700">{row.cell(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5 text-[10.5px] leading-snug text-neutral-400">
        Accuracy here is proxies, not ground truth — read the transcript to judge that. These move in
        the right direction when it degrades.
      </p>
    </div>
  );
}

function ActionRow({ a }: { a: Applied }) {
  const tone =
    a.op === "topic" ? "#8a8a86"
    : a.op === "focus" ? "#a3a3a3"
    : a.kind === "decision" ? STATE_COLOR.agreed
    : a.kind === "risk" ? STATE_COLOR.blocked
    : a.kind === "question" ? STATE_COLOR.open
    : STATE_COLOR.proposed;

  const text =
    a.op === "topic" ? `▣ Topic · ${a.label}`
    : a.op === "card" ? `＋ ${a.kind} · ${a.label}`
    : a.op === "focus" ? `◎ Camera → ${a.label}`
    : a.op === "state" ? `● Marked ${a.label}`
    : a.op === "react" ? `☺ Reaction`
    : `↔ ${a.op}`;

  return (
    <div className="flex items-center gap-1.5">
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: tone }} />
      <span className="truncate text-[11.5px] font-medium text-neutral-500">{text}</span>
    </div>
  );
}


/** Per-chunk stage trace.
 *
 *  Deliberately raw and monospaced. This is the view you open when a run "feels slow" and you need
 *  to know WHICH stage lost the time — slicing, ASR, judging, or waiting on a provider. The lag
 *  column is the point: absolute duration flatters a stage that is fast but still slower than the
 *  audio it has to keep up with, and only the second number tells you a live call was lost.
 *
 *  Collapsed by default so it never competes with the transcript, and copyable in one click because
 *  the useful thing to do with a trace is paste it somewhere. */
function StageLog({ lines }: { lines: DebugLine[] }) {
  const [open, setOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: "end" }); }, [lines.length, open]);
  if (!lines.length) return null;

  const text = lines
    .map((l) => `${String(l.atMs).padStart(6)}ms  ${l.index < 0 ? " ——" : `#${String(l.index).padStart(2)}`}  ${l.stage.padEnd(10)} ${l.note}${l.lagMs === undefined ? "" : `   [lag ${l.lagMs > 0 ? "+" : ""}${(l.lagMs / 1000).toFixed(1)}s]`}`)
    .join("\n");

  // The worst lag seen, promoted into the header — "is this keeping up" is the one question you can
  // answer without expanding anything.
  const lags = lines.map((l) => l.lagMs).filter((v): v is number => typeof v === "number");
  const worst = lags.length ? Math.max(...lags) : 0;

  return (
    <div className="border-t border-neutral-100">
      <div className="flex items-center gap-2 px-4 py-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[11px] font-bold uppercase tracking-[0.13em] text-neutral-400 hover:text-neutral-600"
        >
          {open ? "▾" : "▸"} Stage log · {lines.length}
        </button>
        {worst > 1500 ? (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10.5px] font-semibold text-amber-700">
            behind by {(worst / 1000).toFixed(1)}s
          </span>
        ) : (
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10.5px] font-semibold text-emerald-700">
            keeping up
          </span>
        )}
        <button
          onClick={() => navigator.clipboard?.writeText(text)}
          className="ml-auto text-[11px] font-semibold text-neutral-400 hover:text-neutral-600"
        >
          Copy
        </button>
      </div>
      {open ? (
        <div className="max-h-52 overflow-auto bg-neutral-50 px-4 pb-3">
          <pre className="whitespace-pre text-[10.5px] leading-[1.5] text-neutral-600">{text}</pre>
          <div ref={endRef} />
        </div>
      ) : null}
    </div>
  );
}
