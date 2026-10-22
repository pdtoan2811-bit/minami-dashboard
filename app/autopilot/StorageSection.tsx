"use client";
// The Storage tab of /autopilot (§32): is the disk OK, is the janitor alive, what did it remove (and how to bring
// it back), and what is waiting on Thomas. Built after a day the disk went 30 → 11 GB free in 48 h with nobody
// told — so the first line on the tab is always a sentence about health, and a janitor that stopped running is
// louder than a low number.
import { useCallback, useEffect, useState } from "react";
import { Glass, Eyebrow, PillButton, K, mix } from "../today/ui";

type Run = { at: string; why: string; dry?: boolean; watchOnly?: boolean; error?: string; freeBeforeGB?: number; freeAfterGB?: number; freedGB?: number; errors?: string[] };
type Line = { at: string; tier: number; kind: string; path: string; bytes: number; why: string; restore?: string };
type Sample = { date: string; freeGB: number; top: { path: string; gb: number }[] };
type Ask = { id: string; title: string; detail: string; gb: number; action?: string };
type Snap = {
  freeGB: number; totalGB: number; on: boolean; stale: boolean;
  thresholds: { lowGB: number; targetGB: number; criticalGB: number };
  running: { pid: number; why: string; at: number } | null; lastGood: Run | null;
  runs: Run[]; ledger: Line[]; samples: Sample[]; asks: Ask[]; error?: string;
};

const C = { green: "#3ecf8e", amber: "#f3c766", red: "#ff8a8d" };
const MONO = { fontFamily: "var(--today-mono)" } as const;
const KIND: Record<string, string> = {
  tmp: "Leaked temp folder", "next-cache": "Next.js cache", "pkg-cache": "Package caches", "project-tidy": "Project tidy",
  worktree: "Worktree", node_modules: "node_modules", docker: "Docker",
};
const gb = (b: number) => (b / 2 ** 30 >= 10 ? (b / 2 ** 30).toFixed(0) : (b / 2 ** 30).toFixed(1));
function ago(iso?: string) {
  if (!iso) return "never";
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function useStorage() {
  const [s, setS] = useState<Snap | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/autopilot/storage").then((r) => r.json()).catch((e) => ({ error: String(e) }));
    setS(r);
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 20_000);
    return () => clearInterval(t);
  }, [load]);
  return { s, load };
}

/** One sentence, worst first: a dead janitor beats a low number, because a low number with a live janitor fixes itself. */
function health(s: Snap): { tone: string; text: string } {
  const t = s.thresholds;
  if (s.stale) return { tone: C.red, text: `The janitor hasn't completed a pass since ${s.lastGood ? ago(s.lastGood.at) : "it was installed"}. Check its runner, or run a pass now.` };
  if (s.freeGB < t.criticalGB) return { tone: C.red, text: `Critical: ${s.freeGB.toFixed(1)} GB free. Nothing safe is left to clear on its own; the items below need you.` };
  if (s.running) return { tone: C.amber, text: `Cleaning now (${s.running.why}). ${s.freeGB.toFixed(1)} GB free.` };
  if (!s.on) return { tone: C.amber, text: `Watch-only: autopilot's storage duty is off, so the janitor measures and reports but deletes nothing.` };
  if (s.freeGB < t.lowGB) return { tone: C.amber, text: `Below the ${t.lowGB} GB floor. The janitor starts a pass on its own; what it can't clear is listed below.` };
  return { tone: C.green, text: `Healthy. The janitor keeps at least ${t.lowGB} GB free and cleans back up to ${t.targetGB} GB.` };
}

function Gauge({ s }: { s: Snap }) {
  const t = s.thresholds;
  const pct = (g: number) => `${Math.min(100, (g / s.totalGB) * 100)}%`;
  const tone = s.freeGB < t.criticalGB ? C.red : s.freeGB < t.lowGB ? C.amber : C.green;
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-[44px] font-semibold leading-none" style={{ color: K.ink }}>{s.freeGB.toFixed(0)}</span>
        <span className="text-[16px]" style={{ color: K.muted }}>GB free of {s.totalGB.toFixed(0)}</span>
      </div>
      <div className="relative mt-4 h-3 rounded-full" style={{ background: mix(K.ink, 8) }}>
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: pct(s.freeGB), background: tone }} />
        {/* ticks only: the floor and the target sit 9% of the disk apart, so labels on the bar collided */}
        {[t.criticalGB, t.lowGB, t.targetGB].map((g) => (
          <div key={g} className="absolute -top-1 h-5 w-px" style={{ left: pct(g), background: K.line2 }} />
        ))}
      </div>
      <p className="mt-2 text-[12px]" style={{ ...MONO, color: K.faint }}>
        ticks: critical {t.criticalGB} · floor {t.lowGB} · target {t.targetGB} GB
      </p>
    </div>
  );
}

/** Free GB per day, last 30 samples. Bars, not a line: a sample is one reading a day, and gaps should look like gaps. */
function Trend({ samples, t }: { samples: Sample[]; t: Snap["thresholds"] }) {
  if (samples.length < 2) return <p className="text-[13px]" style={{ color: K.faint }}>The trend starts after the first two nightly samples.</p>;
  const max = Math.max(t.targetGB, ...samples.map((x) => x.freeGB));
  const last = samples.at(-1)!, prev = samples.at(-2)!;
  const grew = last.top.map((x) => ({ ...x, d: x.gb - (prev.top.find((p) => p.path === x.path)?.gb ?? x.gb) })).filter((x) => x.d > 0.5).sort((a, b) => b.d - a.d).slice(0, 3);
  return (
    <div>
      <div className="flex h-16 items-end gap-[3px]">
        {samples.map((x) => (
          <div key={x.date} title={`${x.date}: ${x.freeGB} GB free`} className="flex-1 rounded-sm"
            style={{ height: `${(x.freeGB / max) * 100}%`, background: x.freeGB < t.lowGB ? C.amber : mix(K.accentBright, 70) }} />
        ))}
      </div>
      <p className="mt-2 text-[13px]" style={{ color: K.muted }}>
        {last.freeGB - prev.freeGB >= 0 ? `+${(last.freeGB - prev.freeGB).toFixed(1)}` : (last.freeGB - prev.freeGB).toFixed(1)} GB since {prev.date}
        {grew.length > 0 && <> · grew most: {grew.map((g) => `${g.path} +${g.d.toFixed(1)}`).join(", ")}</>}
      </p>
    </div>
  );
}

// The feed comes from the page, which also needs it for the tab's badge: one poll, not two.
export function StorageSection({ feed }: { feed: ReturnType<typeof useStorage> }) {
  const { s, load } = feed;
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const act = async (op: string) => {
    setBusy(op); setNote("");
    const r = await fetch("/api/autopilot/storage", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op }) })
      .then((r) => r.json()).catch((e) => ({ error: String(e) }));
    setBusy(null);
    setNote(r.error ? r.error : r.started ? "Started. Results land here and in the bell." : r.note || "");
    setTimeout(load, 1500);
  };
  if (!s) return <p className="text-[14px]" style={{ color: K.faint }}>Reading the disk…</p>;
  if (s.error) return <p className="text-[14px]" style={{ color: C.red }}>{s.error}</p>;
  const h = health(s);

  return (
    <div className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
      <div className="flex flex-col gap-5">
        <Glass className="p-6">
          <p className="mb-5 flex gap-2 text-[15px] leading-snug" style={{ color: K.ink }}>
            <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full" style={{ background: h.tone }} />{h.text}
          </p>
          <Gauge s={s} />
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <PillButton tone="paper" small disabled={!!busy || !!s.running} onClick={() => act("run")}>{s.running ? "Cleaning…" : "Run a pass now"}</PillButton>
            <span className="text-[13px]" style={{ color: K.faint }}>Last pass {ago(s.lastGood?.at)}{s.lastGood?.freedGB ? ` · freed ${s.lastGood.freedGB} GB` : ""}</span>
          </div>
          {note && <p className="mt-3 text-[13px]" style={{ color: K.muted }}>{note}</p>}
        </Glass>

        {s.asks.length > 0 && (
          <Glass className="p-6">
            <Eyebrow>Waiting on you</Eyebrow>
            <div className="mt-3 flex flex-col gap-4">
              {s.asks.map((a) => (
                <div key={a.id} className="flex items-start gap-4">
                  <div className="flex-1">
                    <p className="text-[15px] font-semibold" style={{ color: K.ink }}>{a.title}</p>
                    <p className="mt-1 text-[13.5px] leading-snug" style={{ color: K.muted }}>{a.detail}</p>
                  </div>
                  {a.action && <PillButton tone="accent" small disabled={!!busy} onClick={() => act(a.action!)}>{busy === a.action ? "Starting…" : "Clean it"}</PillButton>}
                </div>
              ))}
            </div>
          </Glass>
        )}

        <Glass className="p-6">
          <Eyebrow>Free space, by day</Eyebrow>
          <div className="mt-3"><Trend samples={s.samples} t={s.thresholds} /></div>
        </Glass>
      </div>

      <div className="flex flex-col gap-5">
        <Glass className="p-6">
          <Eyebrow>Recent passes</Eyebrow>
          <div className="mt-3 flex flex-col">
            {s.runs.length === 0 && <p className="text-[13.5px]" style={{ color: K.faint }}>No passes yet. The first runs tonight at 00:15, or press Run.</p>}
            {s.runs.slice(0, 8).map((r) => (
              <div key={r.at + r.why} className="flex items-baseline gap-3 border-t py-2 text-[13.5px] first:border-t-0" style={{ borderColor: K.line }}>
                <span className="w-24 shrink-0 whitespace-nowrap" style={{ ...MONO, color: K.faint }}>{ago(r.at)}</span>
                <span className="w-24 shrink-0" style={{ color: K.muted }}>{r.why}</span>
                <span className="flex-1" style={{ color: r.error ? C.red : K.ink }}>
                  {r.error ? "crashed" : r.watchOnly ? "watched only" : `freed ${r.freedGB} GB`}
                  {!r.error && <span style={{ color: K.faint }}> · {r.freeBeforeGB} → {r.freeAfterGB} GB</span>}
                  {!!r.errors?.length && <span style={{ color: C.amber }}> · {r.errors.length} skipped</span>}
                </span>
              </div>
            ))}
          </div>
        </Glass>

        <Glass className="p-6">
          <Eyebrow>Removed lately · and how to bring it back</Eyebrow>
          <div className="mt-3 flex flex-col">
            {s.ledger.length === 0 && <p className="text-[13.5px]" style={{ color: K.faint }}>Nothing removed yet.</p>}
            {s.ledger.slice(0, 14).map((l, i) => (
              <details key={i} className="border-t py-2 first:border-t-0" style={{ borderColor: K.line }}>
                <summary className="flex cursor-pointer items-baseline gap-3 text-[13.5px]">
                  <span className="w-14 shrink-0 text-right" style={{ ...MONO, color: K.ink }}>{gb(l.bytes)} GB</span>
                  <span className="truncate" style={{ color: K.muted }}>{KIND[l.kind] || l.kind} · {l.path}</span>
                </summary>
                <p className="mt-1 pl-[68px] text-[12.5px]" style={{ color: K.faint }}>{l.why} · {ago(l.at)}</p>
                {l.restore && <p className="mt-1 select-all pl-[68px] text-[12.5px]" style={{ ...MONO, color: K.accentBright }}>{l.restore}</p>}
              </details>
            ))}
          </div>
        </Glass>
      </div>
    </div>
  );
}
