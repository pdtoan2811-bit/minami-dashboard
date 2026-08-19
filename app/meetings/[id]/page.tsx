"use client";
// ONE MEETING, AFTERWARDS — a full-screen board with the transcript on call.
//
// ── The layout, and why it changed ──────────────────────────────────────────────────────────────
// v1 put the board and the transcript in a 1.1fr/1fr grid. Anh's verdict: "not intuitive since the
// canvas should be full screen with actions and tool, and transcript should be like a side panel."
// Right — a mind map in half a column is a thumbnail of a mind map. The board is the artefact; the
// transcript is evidence you reach for when a card looks wrong. Those are not peers, and giving them
// equal width said they were.
//
// So: the canvas owns the viewport, chrome floats over it, and the transcript slides in from the
// right. Opening it NARROWS the canvas rather than covering it, because checking a card against its
// source means looking at both at once.
//
// ── The board is FIT, not followed ──────────────────────────────────────────────────────────────
// The live camera tracks the newest card, which is right during a call and wrong afterwards: the
// meeting is over, nothing is newest, and the only useful first view is the whole thing. `fit` makes
// the review canvas shrink to show every card — a 57-card board was otherwise parked on one branch,
// which is exactly what anh was looking at.
//
// Light at all times, pinned rather than inherited so the dark app shell cannot bleed through.

import { useEffect, useMemo, useState, use } from "react";
import Link from "next/link";
import { GraphCanvas } from "@/components/canvas/GraphCanvas";

type Node = { id: string; kind: string; label: string; detail?: string; parent?: string };
type Meeting = {
  id: string; date: string; time: string; title: string; minutes: number; cost: number;
  graph: { nodes?: Node[]; edges?: unknown[] }; transcript: string[]; notes: string; topics: string[];
};

const KIND_TINT: Record<string, string> = {
  decision: "#159d6b", action: "#2a78d6", question: "#c47f18", note: "#78716c",
  quote: "#b4638a", risk: "#c4486a", aside: "#6d5ae0",
};

export default function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [m, setM] = useState<Meeting | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState<"map" | "outline">("map");
  const [panel, setPanel] = useState(true);
  const [tidying, setTidying] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  /** AI TIDY, on the finished board.
   *
   *  The live pass tidies every three utterances but sees only the last 60 lines — so a point made in
   *  minute 5 and repeated in minute 40 is never visible to it as a duplicate. Run once at the end,
   *  against the whole transcript, it can actually do the job.
   *
   *  Applied without a confirmation because anh chose "just do it, I'll undo", and that is safe here
   *  for a specific reason: the transcript is immutable, so the board is regenerable. A .bak is
   *  written anyway — regenerable in principle and one click away are different things. */
  async function tidy() {
    if (tidying) return;
    setTidying(true);
    setFlash(null);
    try {
      const r = await fetch("/api/meetings/tidy", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
      });
      const d = await r.json();
      if (!d.ok) { setFlash(d.error ?? "tidy failed"); return; }
      if (d.skipped) { setFlash(d.skipped); return; }
      setFlash(`${d.merged} merged · ${d.revised} rewritten · ${d.nested} re-nested`);
      const rr = await fetch(`/api/meetings?id=${encodeURIComponent(id)}`);
      const dd = await rr.json();
      if (dd.ok) setM(dd.meeting);
    } catch { setFlash("could not reach Minami"); }
    finally { setTidying(false); }
  }

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/meetings?id=${encodeURIComponent(id)}`);
        const d = await r.json();
        if (!d.ok) { setErr(d.error ?? "not found"); return; }
        setM(d.meeting);
      } catch { setErr("could not load"); }
    })();
  }, [id]);

  /** Cards in tree order, so the hierarchy the tidy pass built shows as indentation. Cycle-safe, and
   *  anything unreachable is still listed — the review page must never be where a card disappears. */
  const tree = useMemo(() => {
    const nodes = m?.graph?.nodes ?? [];
    const byParent = new Map<string, Node[]>();
    for (const n of nodes) {
      const k = n.parent ?? "__root";
      (byParent.get(k) ?? (byParent.set(k, []), byParent.get(k)!)).push(n);
    }
    const out: Array<{ n: Node; depth: number }> = [];
    const seen = new Set<string>();
    const walk = (pid: string, depth: number) => {
      for (const n of byParent.get(pid) ?? []) {
        if (seen.has(n.id) || depth > 8) continue;
        seen.add(n.id);
        out.push({ n, depth });
        walk(n.id, depth + 1);
      }
    };
    walk("__root", 0);
    for (const n of nodes) if (!seen.has(n.id)) out.push({ n, depth: 0 });
    return out;
  }, [m]);

  const lines = useMemo(() => {
    const t = m?.transcript ?? [];
    if (!q.trim()) return t;
    return t.filter((l) => l.toLowerCase().includes(q.trim().toLowerCase()));
  }, [m, q]);

  if (err) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#f7f7f5]">
        <div className="text-center">
          <p className="text-[15px] text-neutral-600">{err}</p>
          <Link href="/meetings" className="mt-2 inline-block text-[13px] text-neutral-400 underline hover:text-neutral-700">back to meetings</Link>
        </div>
      </div>
    );
  }
  if (!m) return <div className="min-h-dvh bg-[#f7f7f5] p-10 text-[14px] text-neutral-400">Loading…</div>;

  const cards = (m.graph?.nodes ?? []).filter((n) => n.kind !== "topic");

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-[#f7f7f5]">
      {/* ── THE BOARD, full bleed. Its right edge yields to the panel rather than being covered. ── */}
      <div
        className="absolute inset-y-0 left-0 transition-[right] duration-300"
        style={{ right: panel ? 380 : 0 }}
      >
        {view === "map" ? (
          cards.length ? (
            <GraphCanvas
              graph={{
                rev: 0, title: m.title, status: "ended",
                nodes: m.graph?.nodes ?? [],
                edges: (m.graph?.edges ?? []) as never,
              } as never}
              thinking="idle"
              fit
            />
          ) : (
            <div className="flex h-full items-center justify-center text-[13px] text-neutral-400">
              This meeting produced no cards.
            </div>
          )
        ) : (
          <div className="h-full overflow-y-auto px-8 pb-10 pt-32">
            <div className="mx-auto max-w-[720px] space-y-1.5">
              {tree.map(({ n, depth }) => (
                <div
                  key={n.id}
                  style={{ marginLeft: Math.min(depth, 5) * 18 }}
                  className={n.kind === "topic"
                    ? "rounded-lg bg-neutral-200/60 px-3 py-1.5"
                    : "rounded-lg border border-neutral-200 bg-white px-3 py-2"}
                >
                  <div className="flex items-baseline gap-2">
                    {n.kind !== "topic" ? (
                      <span className="shrink-0 text-[10px] uppercase tracking-wide" style={{ color: KIND_TINT[n.kind] ?? "#78716c" }}>{n.kind}</span>
                    ) : null}
                    <span className={n.kind === "topic" ? "text-[13px] font-semibold text-neutral-700" : "text-[13.5px] text-neutral-900"}>{n.label}</span>
                  </div>
                  {n.detail ? <p className="mt-1 text-[12.5px] leading-5 text-neutral-500">{n.detail}</p> : null}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── CHROME, floating. Frosted, so the board reads underneath instead of being cut off by a bar. */}
      {/* ⚠️ The chrome must respect the panel, not float over it. Spanning the full width meant the
          tool row sat on top of the transcript's own header and close button — two layers of UI in
          the same pixels, and the panel's controls unreachable. It ends where the board ends. */}
      <header
        className="pointer-events-none absolute left-0 top-0 z-20 flex items-start gap-4 p-5 transition-[right] duration-300"
        style={{ right: panel ? 380 : 0 }}
      >
        <div className="pointer-events-auto rounded-2xl border border-neutral-200/70 bg-white/85 px-4 py-2.5 shadow-[0_8px_28px_-18px_rgba(16,24,40,0.35)] backdrop-blur-xl">
          <Link href="/meetings" className="text-[12px] text-neutral-400 transition-colors hover:text-neutral-900">← Meetings</Link>
          <h1 className="mt-0.5 text-[17px] font-semibold leading-tight tracking-[-0.02em] text-neutral-900">{m.title}</h1>
          <p className="mt-0.5 text-[11.5px] text-neutral-400 tabular-nums">
            {m.date}{m.time ? ` · ${m.time}` : ""} · {m.minutes} min · {cards.length} cards · ${m.cost.toFixed(4)}
          </p>
        </div>

        <span className="flex-1" />

        {/* Tools: one row, always reachable, never sitting in the middle of the board. */}
        <div className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-neutral-200/70 bg-white/85 p-1 shadow-[0_8px_28px_-18px_rgba(16,24,40,0.35)] backdrop-blur-xl">
          {(["map", "outline"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className="rounded-xl px-2.5 py-1.5 text-[13px] font-medium transition-colors"
              style={view === v ? { background: "#111827", color: "#fff" } : { color: "#4b5563" }}
            >{v === "map" ? "Mind map" : "Outline"}</button>
          ))}
          <span className="mx-0.5 h-4 w-px bg-neutral-200" />
          <button
            onClick={tidy}
            disabled={tidying}
            title="Re-tidy this board against the whole transcript"
            className="rounded-xl px-2.5 py-1.5 text-[13px] font-medium text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-40"
          >{tidying ? "Tidying…" : "AI tidy"}</button>
          <span className="mx-0.5 h-4 w-px bg-neutral-200" />
          <button
            onClick={() => setPanel((p) => !p)}
            className="rounded-xl px-2.5 py-1.5 text-[13px] font-medium transition-colors"
            style={panel ? { background: "#111827", color: "#fff" } : { color: "#4b5563" }}
          >Transcript</button>
          <Link
            href="/canvas?present=1"
            className="rounded-xl px-2.5 py-1.5 text-[13px] font-medium text-neutral-600 transition-colors hover:bg-neutral-100"
          >Live →</Link>
        </div>
      </header>

      {flash ? (
        <div className="pointer-events-none absolute inset-x-0 top-24 z-30 flex justify-center">
          <div className="rounded-full bg-neutral-900/90 px-3.5 py-1.5 text-[13px] font-medium text-white backdrop-blur">
            {flash}
          </div>
        </div>
      ) : null}

      {/* ── TRANSCRIPT: evidence on demand, not a permanent half of the screen. ── */}
      <aside
        className="absolute inset-y-0 right-0 z-10 w-[380px] border-l border-neutral-200 bg-white/95 backdrop-blur-xl transition-transform duration-300"
        style={{ transform: panel ? "none" : "translateX(100%)" }}
      >
        <div className="flex h-full flex-col px-4 pb-4 pt-5">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-[11.5px] font-semibold uppercase tracking-wide text-neutral-400">Transcript</h2>
            <span className="text-[11.5px] tabular-nums text-neutral-400">{m.transcript?.length ?? 0} lines</span>
            <span className="flex-1" />
            <button onClick={() => setPanel(false)} className="text-[15px] leading-none text-neutral-300 hover:text-neutral-700" aria-label="Close transcript">×</button>
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a line…"
            className="mb-2.5 w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-[13px] text-neutral-900 placeholder:text-neutral-400 outline-none transition-colors focus:border-neutral-500"
          />
          <div className="flex-1 space-y-1.5 overflow-y-auto pr-1">
            {lines.map((l, i) => (
              <p key={i} className="text-[12.5px] leading-5 text-neutral-600">{l}</p>
            ))}
            {!lines.length ? <p className="text-[12.5px] text-neutral-400">No matching lines.</p> : null}
          </div>
        </div>
      </aside>
    </div>
  );
}
