"use client";
// THE LIBRARY — every call anh has had, and the way back into one.
//
// ⚠️ LIGHT, ALWAYS — and it took two wrong turns to get here. v1 was light on the dashboard's dark
// --bento-bg, so the H1 was black-on-black. v2 matched the dark shell. Anh then asked for light at
// all times, which is the right call: this page sits beside the CANVAS, and the canvas is light
// because it gets screen-shared into meetings. A review surface that inverts every time you move
// between it and the board is its own kind of broken.
//
// The background is pinned here rather than inherited, so the dark shell cannot bleed through.
//
// ── Search is the front door, not a filter ──────────────────────────────────────────────────────
// The question is almost never "list my meetings" — it is "when did we talk about vector search". So
// search covers TRANSCRIPTS as well as cards: the sentence anh half-remembers usually never became a
// card, and a library that searched only summaries would miss precisely what he came for. Matching
// lines are shown inline, so a result answers the question instead of pointing at a folder to open.

import { useEffect, useState } from "react";
import Link from "next/link";
import { SendTo, type ActionCard } from "./SendTo";

type Hit = { kind: string; text: string };
type Meeting = {
  id: string; date: string; time: string; title: string;
  minutes: number; cost: number; cards: number; topics: string[];
  score?: number; cardHits?: Hit[]; lineHits?: string[]; actions?: ActionCard[];
};

const KIND_TINT: Record<string, string> = {
  decision: "#4ade80", action: "#5ec8f8", question: "#e0a94a", note: "#a8a29e", quote: "#e8b3c0",
};

export default function MeetingsPage() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);

  // Debounced: a search reads every transcript on the server, so typing "second brain" should not run
  // eleven full scans on the way there.
  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/meetings${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
        const d = await r.json();
        setRows(d.meetings ?? []);
      } catch { setRows([]); }
      setLoading(false);
    }, q ? 260 : 0);
    return () => clearTimeout(t);
  }, [q]);

  const totalMin = rows.reduce((a, m) => a + m.minutes, 0);
  const totalCost = rows.reduce((a, m) => a + m.cost, 0);

  return (
    <div className="min-h-dvh bg-[#f7f7f5]">
      {/* pb-28 on phones: the shell's fixed bottom bar (§30) would cover the last row otherwise. */}
      <div className="mx-auto w-full max-w-[940px] px-6 pb-28 pt-10 sm:pb-10">
        {/* The way between pages is the shell's rail now (§30), so no brand / breadcrumb here — only the
            one link this page owns. */}
        <nav className="mb-7 flex items-center gap-4 text-[13px]">
          <span className="flex-1" />
          <Link href="/canvas?present=1" className="rounded-lg border border-neutral-200 px-2.5 py-1 text-neutral-500 transition-colors hover:border-neutral-400 hover:text-neutral-800">
            Live canvas →
          </Link>
        </nav>

        <header className="mb-5">
          <h1 className="text-[27px] font-semibold tracking-[-0.02em] text-neutral-900">Meetings</h1>
          <p className="mt-1 text-[13.5px] text-neutral-500 tabular-nums">
            {rows.length} call{rows.length === 1 ? "" : "s"} · {Math.round(totalMin)} min · ${totalCost.toFixed(2)}
          </p>
        </header>

        <div className="relative mb-5">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search everything said — cards and transcripts…"
            className="w-full rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-[14.5px] text-neutral-900 placeholder:text-neutral-400 outline-none transition-colors focus:border-neutral-500 focus:bg-neutral-50"
          />
          {q ? (
            <button
              onClick={() => setQ("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[16px] leading-none text-neutral-400 hover:text-neutral-600"
              aria-label="Clear search"
            >×</button>
          ) : null}
        </div>

        {loading ? <p className="text-[13px] text-neutral-400">Searching…</p> : null}
        {!loading && !rows.length ? (
          <div className="rounded-xl border border-neutral-200 bg-white px-4 py-8 text-center">
            <p className="text-[14px] text-neutral-500">{q ? `Nothing matches “${q}”.` : "No meetings archived yet."}</p>
            {!q ? <p className="mt-1 text-[12.5px] text-neutral-400">Run a call and it will appear here when it ends.</p> : null}
          </div>
        ) : null}

        <ul className="space-y-2.5">
          {rows.map((m) => (
            <li key={m.id} className="overflow-hidden rounded-xl border border-neutral-200 bg-white transition-colors hover:border-neutral-400">
              <Link
                href={`/meetings/${encodeURIComponent(m.id)}`}
                className="block px-4 py-3 transition-colors hover:bg-neutral-50"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[15.5px] font-semibold tracking-[-0.01em] text-neutral-900">{m.title}</span>
                  <span className="text-[12.5px] text-neutral-400 tabular-nums">{m.date}{m.time ? ` · ${m.time}` : ""}</span>
                  <span className="flex-1" />
                  <span className="text-[12.5px] text-neutral-500 tabular-nums">
                    {m.cards} cards · {m.minutes} min · ${m.cost.toFixed(3)}
                  </span>
                </div>

                {m.topics?.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {m.topics.slice(0, 6).map((t) => (
                      <span key={t} className="rounded-md border border-neutral-200 bg-neutral-100 px-1.5 py-0.5 text-[11.5px] text-neutral-600">{t}</span>
                    ))}
                  </div>
                ) : null}

                {/* WHY it matched. Without this a search result is a folder with a good score. */}
                {m.cardHits?.length ? (
                  <div className="mt-2.5 space-y-1">
                    {m.cardHits.slice(0, 3).map((h, i) => (
                      <div key={i} className="flex items-baseline gap-2 truncate text-[12.5px] text-neutral-700">
                        <span
                          className="shrink-0 text-[10px] uppercase tracking-wide"
                          style={{ color: KIND_TINT[h.kind] ?? "#a8a29e" }}
                        >{h.kind}</span>
                        <span className="truncate">{h.text}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {m.lineHits?.length ? (
                  <div className="mt-2 space-y-0.5 border-l-2 border-neutral-300 pl-2.5">
                    {m.lineHits.slice(0, 2).map((l, i) => (
                      <div key={i} className="truncate text-[12px] italic text-neutral-400">“{l}”</div>
                    ))}
                  </div>
                ) : null}
              </Link>
              {/* Outside the Link: these are buttons, and a button inside an <a> both navigates and
                  fires. Action items and decisions only — notes and quotes are the record, not work. */}
              {m.actions?.length ? (
                <div className="space-y-1 border-t border-neutral-100 px-4 py-2.5">
                  {m.actions.slice(0, 4).map((a) => (
                    <div key={a.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px] text-neutral-700 sm:flex-nowrap">
                      <span className="shrink-0 text-[10px] uppercase tracking-wide" style={{ color: KIND_TINT[a.kind] ?? "#a8a29e" }}>{a.kind}</span>
                      {/* Phone: the label keeps the line and the send buttons go under it, or it truncates to ~15 chars. */}
                      <span className="min-w-0 flex-1 basis-[calc(100%-5rem)] truncate sm:basis-0">{a.label}</span>
                      <SendTo meeting={m} card={a} />
                    </div>
                  ))}
                  {m.actions.length > 4 ? (
                    <Link href={`/meetings/${encodeURIComponent(m.id)}`} className="block text-[12px] text-neutral-400 hover:text-neutral-700">
                      +{m.actions.length - 4} more in the meeting →</Link>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
