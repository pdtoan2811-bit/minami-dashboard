"use client";
/**
 * The batch tray (§33): a publish's videos under its bash row on the agent card — one bar for the batch,
 * then a line per video (✓ scheduled, its own bar, queued with a start time, held and why). Picked from the
 * upload-progress pitch, V2, 2026-10-23, over a one-line Finder bar, a speed trace, a slot lane and pipeline
 * steps: the batch is the question while a publish runs ("how many left, when is it done"), not the curve.
 *
 * Polls rather than riding the SSE stream: a background Bash is silent to the SDK for its whole run, so no
 * event would ever carry a byte count. 2 s while a run is on screen (the writer's own cadence), 6 s while
 * there is none, and only while the card is mounted — i.e. while the pane has work in flight.
 */
import { createContext, useContext, useEffect, useState } from "react";
import type { Tray, TrayRow } from "@/lib/upload-progress";

export type { Tray };
/** Which chat the card belongs to. Provided once per pane, read by every AgentBoard inside it. */
export const UploadPaneContext = createContext<{ key: string; cwd: string } | null>(null);

export function useUploadTrays(): Tray[] {
  const who = useContext(UploadPaneContext);
  const [trays, setTrays] = useState<Tray[]>([]);
  const key = who?.key || "", cwd = who?.cwd || "";
  useEffect(() => {
    if (!key && !cwd) return;
    let on = true, t: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      let next: Tray[] = [];
      try {
        const r = await fetch(`/api/agent/uploads?key=${encodeURIComponent(key)}&cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
        if (r.ok) next = (await r.json()).trays || [];
      } catch { /* the next tick tries again */ }
      if (!on) return;
      setTrays(next);
      t = setTimeout(tick, next.length ? 2000 : 6000);
    };
    tick();
    return () => { on = false; if (t) clearTimeout(t); };
  }, [key, cwd]);
  return trays;
}

const UP = "#6c9cf5";
export const fmtMin = (m: number) => (m < 1 ? "<1 min" : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);
const clockIn = (min: number) => new Date(Date.now() + min * 60e3).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
const clockAt = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : "");
const mb = (b: number) => (b / 1e6).toFixed(1);
const pct = (a: number, b: number) => `${b > 0 ? Math.max(0, Math.min(100, (a / b) * 100)).toFixed(1) : 0}%`;

function Bar({ a, b }: { a: number; b: number }) {
  return (
    <span className="relative block h-1 overflow-hidden rounded-full bg-white/[0.07]">
      <i className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700" style={{ width: pct(a, b), background: UP }} />
    </span>
  );
}

/** What the hosting bash row says instead of the model's own description while a tray hangs under it. */
export function trayHeadline(t: Tray) {
  const left = t.leftMin == null ? "" : t.leftMin > 0 ? ` · ~${fmtMin(t.leftMin)} left` : "";
  return <>Publishing <b className="font-semibold text-neutral-100">{t.done} of {t.count}</b> done{left}</>;
}

function ItemLine({ r }: { r: TrayRow }) {
  switch (r.state) {
    case "uploading":
      return (
        <span className="min-w-0">
          <Bar a={r.sent ?? 0} b={r.size} />
          <span className="mt-0.5 block truncate text-neutral-400">
            <span className="tabular-nums">{mb(r.sent ?? 0)} / {mb(r.size)} MB</span>
            {r.rateBps ? ` · ${Math.round(r.rateBps / 1e3)} KB/s` : " · starting"}
            {r.try && r.tries ? ` · try ${r.try} of ${r.tries}` : ""}
          </span>
        </span>
      );
    case "done":
      return <span className="min-w-0 truncate text-neutral-400"><span className="text-[#4ade80]">✓ scheduled {clockAt(r.slot)}</span> · {mb(r.size)} MB{r.tookMs ? ` in ${fmtMin(r.tookMs / 60e3)}` : ""}{r.why ? ` · ${r.why}` : ""}</span>;
    case "held":
      return <span className="min-w-0 truncate text-[#f3c766]" title={r.why}>✋ held · {r.why || "by the checks"}</span>;
    case "failed":
      return <span className="min-w-0 truncate text-[#ff8a8d]" title={r.why}>✗ not posted · {r.why || "upload failed"}</span>;
    case "skipped":
      return <span className="min-w-0 truncate text-neutral-500" title={r.why}>skipped · {r.why}</span>;
    default:
      return <span className="min-w-0 truncate text-neutral-500">{mb(r.size)} MB{r.startsInMin != null ? ` · starts ~${clockIn(r.startsInMin)}` : ""}</span>;
  }
}

/** The tray body: the batch bar and its line, then one line per video. Sits under the bash row it belongs to. */
export function UploadTray({ tray: t }: { tray: Tray }) {
  return (
    <span className="flex flex-col pb-1 text-[11px]">
      <span className="block px-2.5 pb-1.5 pl-8">
        <Bar a={t.sentMb} b={t.allMb} />
        <span className="mt-1 block text-neutral-400">
          <span className="tabular-nums">{t.sentMb.toFixed(0)} of {t.allMb.toFixed(0)} MB</span>
          {t.leftMin ? <> · all done about <b className="font-semibold text-neutral-100">{clockIn(t.leftMin)}</b></> : null}
          {t.held ? <span className="text-[#f3c766]"> · {t.held} held</span> : null}
          {t.failed ? <span className="text-[#ff8a8d]"> · {t.failed} failed</span> : null}
        </span>
      </span>
      {t.rows.map((r) => (
        <span key={r.n} className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-x-2.5 border-t border-white/[0.04] py-1 pl-8 pr-2.5">
          <span className="font-mono text-[10px] font-semibold text-neutral-300">{r.n}</span>
          <ItemLine r={r} />
          <span className={`font-mono text-[9px] tabular-nums ${r.state === "uploading" ? "text-neutral-200" : "text-neutral-500"}`}>
            {(r.state === "uploading" || r.state === "queued") && r.leftMin != null ? fmtMin(r.leftMin) : ""}
          </span>
        </span>
      ))}
    </span>
  );
}
