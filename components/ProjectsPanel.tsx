"use client";

import { useEffect, useState } from "react";

const METRICS_URL = (process.env.NEXT_PUBLIC_METRICS_URL || "").replace(/\/$/, "");
const METRICS_KEY = process.env.NEXT_PUBLIC_METRICS_KEY || "";

type RawProject = {
  cwd: string;
  project: string;
  label: string;
  reply: string;
  model: string;
  source: string;
  ts: number;
};
type ProjectsDoc = { projects: RawProject[]; updated: number };

// One row per project *name*, not per cwd — the same logical project can show up under different
// full paths depending on which machine touched it last (e.g. `/Users/thomas/secondBrain` from the
// laptop vs `/root/secondBrain` from Minami's cloud host: same project, different uid/HOME, so the
// server buckets by raw cwd). This is exactly the "local vs cloud" split the protocol audit found —
// merging here, client-side, by the last path segment is the fix: whichever host touched it most
// recently wins the card, and every other host that touched the same project name is listed as a
// secondary "also on" trail so nothing is silently hidden.
type MergedProject = RawProject & { alsoOn: RawProject[] };

function mergeByProjectName(projects: RawProject[]): MergedProject[] {
  const byName = new Map<string, RawProject[]>();
  for (const p of projects) {
    const list = byName.get(p.project) || [];
    list.push(p);
    byName.set(p.project, list);
  }
  const merged: MergedProject[] = [];
  for (const list of byName.values()) {
    list.sort((a, b) => b.ts - a.ts);
    const [latest, ...rest] = list;
    merged.push({ ...latest, alsoOn: rest });
  }
  return merged.sort((a, b) => b.ts - a.ts);
}

// Best-effort "which host" label from the cwd shape, purely for display — not load-bearing.
function hostOf(cwd: string): string {
  if (cwd.startsWith("/root/")) return "cloud";
  if (cwd.startsWith("/Users/")) return "local";
  return "";
}

function fmtAgo(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 0) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export function ProjectsPanel() {
  const [doc, setDoc] = useState<ProjectsDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = METRICS_KEY ? `?k=${encodeURIComponent(METRICS_KEY)}` : "";

  useEffect(() => {
    if (!METRICS_URL) return;
    let cancelled = false;
    const load = () => {
      fetch(METRICS_URL + "/projects" + q)
        .then((r) => r.json())
        .then((d) => { if (!cancelled) { setDoc(d); setError(null); } })
        .catch((e) => { if (!cancelled) setError(String(e)); });
    };
    load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [q]);

  if (!METRICS_URL) {
    return (
      <p className="text-xs text-neutral-400">
        No metrics source connected. Set <code className="text-[11px]">NEXT_PUBLIC_METRICS_URL</code>{" "}
        to see the last checkpoint per project, across every machine.
      </p>
    );
  }
  if (error) return <p className="text-xs text-neutral-400">Projects feed unavailable ({error}).</p>;
  if (!doc) return <p className="text-xs text-neutral-400">Loading projects…</p>;

  const merged = mergeByProjectName(doc.projects);
  if (merged.length === 0) {
    return <p className="text-xs text-neutral-400">No project checkpoints yet — they show up as sessions run.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {merged.map((p) => (
        <div key={p.project} className="rounded-lg border border-white/10 p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-xs font-medium">{p.project}</span>
            <span className="shrink-0 text-[10px] text-neutral-400">{fmtAgo(p.ts)}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            {hostOf(p.cwd) && (
              <span className="shrink-0 rounded-full bg-[var(--sakura)]/15 px-1.5 py-0.5 text-[9px] text-[var(--sakura)]">
                {hostOf(p.cwd)}
              </span>
            )}
            {p.label && <span className="truncate text-[11px] text-neutral-500">{p.label}</span>}
          </div>
          {p.alsoOn.length > 0 && (
            <p className="mt-1 text-[9px] text-neutral-400">
              also on: {p.alsoOn.map((o) => `${hostOf(o.cwd) || o.cwd} (${fmtAgo(o.ts)})`).join(", ")}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
