"use client";
// Mirrors an in-flight `ask_team` call — Claude asking a TEAMMATE over Slack DM through team-ask
// (github.com/Anhduchb01/team-ask). The same topic is showing as a card in that person's DM right
// now; this card exists so the pane says what is being waited on, by name, instead of "running a
// tool" for an hour (ASK_TIMEOUT_MINUTES is 360 on this box).
//
// Read-only on purpose. team-ask has no API to answer through: each Claude session holds its own
// Socket Mode connection and the answer is a click in Slack. Whoever the question went to answers
// it there — including you, if it went to you — and the tool_result is what clears this card.
//
// It reads in the SAME order as the Slack card — topic → where → each question → its options with
// consequences — so what the teammate is being asked and what the asker sees are one thing.
import { useEffect, useState } from "react";
import type { AskTeamPrompt } from "@/lib/use-agent";
import { atLeast, useDensityTier } from "@/lib/density";

const dur = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
// Past this the wait is long enough that "are they even around?" is the question — the card says so.
const LONG_WAIT_MS = 30 * 60_000;

const SCALE = {
  reading: { eyebrow: "text-[10.5px]", section: "text-[10.5px]", body: "text-[12.5px] leading-relaxed", question: "text-[14px] leading-snug", label: "text-[13px]", desc: "text-[11.5px] leading-relaxed", note: "text-[11.5px]", mark: "h-3.5 w-3.5" },
  compact: { eyebrow: "text-[10px]", section: "text-[10px]", body: "text-[11.5px] leading-snug", question: "text-[13px] leading-snug", label: "text-[12px]", desc: "text-[10.5px] leading-snug", note: "text-[10.5px]", mark: "h-3 w-3" },
} as const;
type Scale = (typeof SCALE)[keyof typeof SCALE];

export default function AskTeamCard({ ask, onStop, stopping }: { ask: NonNullable<AskTeamPrompt>; onStop?: () => void; stopping?: boolean }) {
  const d = useDensityTier();
  // A wait runs for hours (ASK_TIMEOUT_MINUTES 360). The card used to pulse identically at minute one
  // and hour five, and its full question list covered the chat the whole time (audit 2026-10-08) —
  // so: a ticking "waiting 2h 14m · expires in 3h 46m", amber past 30 min, and a fold.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const [open, setOpen] = useState(true);
  const [confirmStop, setConfirmStop] = useState(false);
  useEffect(() => { if (!confirmStop) return; const t = setTimeout(() => setConfirmStop(false), 4000); return () => clearTimeout(t); }, [confirmStop]);
  const since = ask.since;
  const waited = since ? now - since : 0;
  const left = since && ask.packet.timeout_minutes ? since + ask.packet.timeout_minutes * 60_000 - now : null;
  const long = waited > LONG_WAIT_MS;
  const sc: Scale = atLeast(d, "snug") ? SCALE.reading : SCALE.compact;
  const p = ask.packet;
  // `assignee` is a roster key or an expertise area, or absent (the tool picks the owner). Shown as
  // given — the roster with real names lives in team-ask's team.json, not here.
  const who = p.assignee ? p.assignee : "a teammate";

  return (
    // Flex column that can shrink, for the reason AskCard gives: this renders as a sibling of the
    // composer in a pane that clips. Eyebrow pinned; the body scrolls.
    <div className="mx-4 mb-2 flex min-h-0 flex-col rounded-xl border border-[var(--sakura)]/40 bg-[var(--sakura)]/[0.06] px-3 py-2.5">
      <div className="mb-1.5 flex shrink-0 items-center justify-between gap-2">
        <p className={`flex min-w-0 items-center gap-1.5 ${sc.eyebrow} font-medium uppercase tracking-wider text-[var(--sakura)]`}>
          <span>✻</span><span className="truncate">Asked {who} on Slack · {p.topic}</span>
        </p>
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open} title={open ? "Fold the card" : "Show the questions"}
          className={`flex shrink-0 items-center gap-1.5 rounded-md px-1 ${sc.note} ${long ? "text-amber-300" : "text-neutral-500"} pointer-coarse:min-h-10`}>
          <span className={`h-1.5 w-1.5 animate-pulse rounded-full ${long ? "bg-amber-300" : "bg-[var(--sakura)]"}`} />
          {since ? `waiting ${dur(waited)}${left !== null ? ` · ${left > 0 ? `expires in ${dur(left)}` : "expiring"}` : ""}` : "waiting for an answer in Slack"}
          <span className="text-neutral-600">{open ? "▴" : "▾"}</span>
        </button>
      </div>

      {open && <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-0.5">
        {p.doing && <p className={`${sc.body} text-neutral-300`}><span className="text-neutral-500">Doing ·</span> {p.doing}</p>}
        {p.why_now && <p className={`${sc.body} text-neutral-300`}><span className="text-neutral-500">Why them, why now ·</span> {p.why_now}</p>}
        <p className={`${sc.body} text-neutral-400`}><span className="text-neutral-500">Where ·</span> {p.context}</p>

        {p.questions.map((q, i) => (
          <div key={i}>
            <p className={`${sc.section} font-medium uppercase tracking-wider text-neutral-500`}>
              {p.questions.length > 1 && <span className="mr-1.5 tabular-nums">{i + 1}.</span>}{q.header || "Question"}
              {q.multiSelect && <span className="ml-1.5 normal-case tracking-normal text-[var(--sakura)]">· select all that apply</span>}
            </p>
            <p className={`mt-0.5 ${sc.question} font-medium text-neutral-50`}>{q.question}</p>
            <div className="mt-1.5 flex flex-col gap-1">
              {q.options.map((o) => {
                const rec = q.recommendation?.label === o.label;
                return (
                  <div key={o.label} className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 ${rec ? "border-[var(--sakura)]/40" : "border-white/10"}`}>
                    <span className={`mt-[3px] ${sc.mark} shrink-0 border border-white/25 ${q.multiSelect ? "rounded-[3px]" : "rounded-full"}`} />
                    <span className="min-w-0 flex-1">
                      <span className={`block ${sc.label} font-medium text-neutral-200`}>
                        {o.label}
                        {rec && <span className={`ml-1.5 ${sc.note} font-normal text-[var(--sakura)]`}>★ recommended</span>}
                      </span>
                      {o.description && <span className={`mt-0.5 block ${sc.desc} text-neutral-400`}>{o.description}</span>}
                    </span>
                  </div>
                );
              })}
            </div>
            {q.recommendation?.reason && (
              <p className={`mt-1 ${sc.note} text-neutral-400`}><span className="text-[var(--sakura)]">Why {q.recommendation.label} ·</span> {q.recommendation.reason}</p>
            )}
          </div>
        ))}

        <p className={`${sc.note} text-neutral-500`}>
          Answer it in the Slack DM — pick a row there (or reply in the thread). This card clears when the answer comes back.
          {long ? " It has been a while — nudge them in Slack, or stop waiting and decide it yourself." : ""}
        </p>
      </div>}
      {/* Stop waiting = stop the turn: ask_team blocks inside the tool call and has no cancel of its
          own, so ending the turn is the only way out. Two taps, because it also drops the question. */}
      {onStop && (
        <div className="mt-2 flex shrink-0 items-center justify-end gap-2">
          <button onClick={() => (confirmStop ? (setConfirmStop(false), onStop()) : setConfirmStop(true))} disabled={stopping}
            className={`rounded-lg border px-2.5 py-1 ${sc.note} transition-colors pointer-coarse:min-h-11 pointer-coarse:px-3.5 disabled:opacity-50 ${confirmStop ? "border-[#ef7c7c]/60 text-[#ef7c7c]" : "border-white/15 text-neutral-400 hover:border-white/30 hover:text-neutral-200"}`}>
            {stopping ? "Stopping…" : confirmStop ? "Stop the turn? Tap again" : "Stop waiting"}
          </button>
        </div>
      )}
    </div>
  );
}
