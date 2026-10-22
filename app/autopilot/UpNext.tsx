"use client";
// Up next: what happens in the next 24 h, in order, and which videos won't go out on their own (lib/upnext.ts).
// Thomas, 2026-10-22: "Need to show in detail like event of uploading etc to let me know what's coming up next".
import { Fragment } from "react";
import type { UpEvent, UpNext, UpWait } from "@/lib/upnext";
import { K as TK } from "../today/ui";
import { DC, dur } from "./DayStrip";

const K = { ...TK, amber: "#f3c766", pink: "#db6393" };
const MONO = { fontFamily: "var(--today-mono)" } as const;
const mix = (c: string, p: number) => `color-mix(in srgb, ${c} ${p}%, transparent)`;
const ICON: Record<UpEvent["kind"], string> = { runner: "◷", post: "📤", card: "💬" };
const WAIT: Record<UpWait["state"], string> = { held: "Held", "not-booked": "Not booked", "not-made": "Not made", failed: "Failed" };
const LANG = (l?: string) => (l === "vi" ? K.pink : K.accent2);

const dayKey = (d: Date) => d.toDateString();
function dayLabel(d: Date, now: Date) {
  if (dayKey(d) === dayKey(now)) return "Today";
  const t = new Date(now); t.setDate(t.getDate() + 1);
  return dayKey(d) === dayKey(t) ? "Tomorrow" : d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}

export function UpNextPanel({ up, visible, jump, now: _tick }: { up: UpNext; visible: Set<string>; jump: (id: string) => void; now: number }) {
  const now = new Date();
  const videos = visible.has("com.thomas.video-overnight");
  const events = up.events.filter((e) => (e.kind === "post" ? videos : !e.id || visible.has(e.id)));
  const waiting = videos ? up.waiting : [];
  if (!events.length && !waiting.length) return null;
  let lastDay = "";

  return (
    <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <section className="rounded-2xl px-5 py-4" style={{ background: "rgba(255,255,255,.035)", border: `1px solid ${K.line}` }}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[12px] font-semibold uppercase tracking-[.08em]" style={{ ...MONO, color: K.faint }}>Up next · 24 h</h3>
          {videos && up.posted.length > 0 && (
            <span className="text-[12.5px]" style={{ ...MONO, color: K.muted }}>
              {up.posted.map((p) => `${p.day.slice(11)} ${p.done}/${p.of} posted`).join(" · ")}
            </span>
          )}
        </div>
        <ol className="mt-2">
          {events.map((e, i) => {
            const d = new Date(e.at), k = dayKey(d), head = k !== lastDay ? dayLabel(d, now) : null;
            lastDay = k;
            const post = e.kind === "post";
            return (
              <li key={`${e.kind}${e.id ?? e.n}${e.at}${i}`}>
                {head && <div className="mb-1 mt-3 text-[11.5px] font-semibold uppercase tracking-[.06em]" style={{ ...MONO, color: K.faint }}>{head}</div>}
                <button type="button" onClick={() => e.id && jump(e.id)} disabled={!e.id}
                  className="grid w-full grid-cols-[48px_86px_22px_minmax(0,1fr)] items-baseline gap-x-2 rounded-lg px-2 py-1.5 text-left"
                  style={{ background: post ? mix(LANG(e.lang), 8) : "transparent", cursor: e.id ? "pointer" : "default" }}>
                  <span className="text-[14px] font-semibold" style={MONO}>{d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
                  <span className="text-[12px]" style={{ ...MONO, color: K.faint }}>in {dur(Math.max(0, (d.getTime() - now.getTime()) / 1000))}</span>
                  <span className="text-[14px]">{ICON[e.kind]}</span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      {post && <span className="rounded px-1.5 text-[11px] font-bold" style={{ ...MONO, background: mix(LANG(e.lang), 22), color: LANG(e.lang) }}>{e.n}</span>}
                      <span className="text-[14.5px] font-medium">{e.title}</span>
                      {e.local && <span className="text-[12px]" style={{ ...MONO, color: K.muted }}>{e.local}</span>}
                    </span>
                    <span className="block text-[13px] leading-snug" style={{ color: K.muted }}>{e.what}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {up.repeating.length > 0 && (
          <p className="mt-3 text-[12.5px] leading-snug" style={{ color: K.faint }}>Also on repeat: {up.repeating.join(" · ")}</p>
        )}
      </section>

      {waiting.length > 0 && (
        <section className="rounded-2xl px-5 py-4" style={{ background: mix(DC.amber, 6), border: `1px solid ${mix(DC.amber, 30)}` }}>
          <h3 className="text-[16px] font-semibold">
            {waiting.length} video{waiting.length === 1 ? "" : "s"} <span style={{ color: DC.amber }}>won't go out on their own</span>
          </h3>
          <p className="mt-0.5 text-[13px]" style={{ color: K.muted }}>None of these has a TikTok slot. Each needs a fix, a publish, or a drop.</p>
          <ul className="mt-3 flex flex-col gap-2">
            {waiting.map((w, i) => (<Fragment key={w.day + w.n}>
              {w.day !== waiting[i - 1]?.day && <li className="mt-1 text-[11.5px] font-semibold uppercase tracking-[.06em]" style={{ ...MONO, color: K.faint }}>{w.day.slice(5)}</li>}
              <li className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-2">
                <span className="mt-0.5 h-fit rounded px-1.5 text-center text-[11px] font-bold" style={{ ...MONO, background: mix(LANG(w.lang), 22), color: LANG(w.lang) }}>{w.n}</span>
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium" title={w.title}>{w.title}</span>
                  <span className="line-clamp-2 block text-[12.5px] leading-snug" title={w.why} style={{ color: K.muted }}>
                    <b style={{ color: DC.amber }}>{WAIT[w.state]}</b> · {w.why}
                  </span>
                </span>
              </li>
            </Fragment>))}
          </ul>
        </section>
      )}
    </div>
  );
}
