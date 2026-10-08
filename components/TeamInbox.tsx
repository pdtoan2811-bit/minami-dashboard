"use client";
// The team inbox (§25): what a teammate's Claude asked you through team-ask, read here with the full
// context and answered here — the answer goes back as team-ask's own relay, so Slack's card closes
// itself within ~20s exactly as if you'd clicked it. "Explain" opens an ordinary dashboard chat seeded
// with the whole card, in the repo it's about, so you can ask before you answer.
//
// Deliberately no push and no unread state of its own: Slack already notified you, and a second
// notification for the same question is noise. The entry point only appears while something waits.
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Paperclip, Sparkles, Users, X } from "lucide-react";
import { useBackLayer } from "@/lib/use-back";
import Markdown from "@/components/Markdown";
import type { Answer, TeamCard, TeamDm, TeamInbox as Inbox } from "@/lib/team-inbox";

const POLL_MS = 30_000;
const DM_FRESH_MS = 24 * 3600_000; // a plain DM keeps the entry lit for a day; older ones are still listed

export function useTeamInbox() {
  const [data, setData] = useState<Inbox | null>(null);
  const load = useCallback(async (force = false) => {
    try {
      const r = await fetch(`/api/team/inbox${force ? "?force=1" : ""}`, { cache: "no-store" });
      if (r.ok) setData(await r.json());
    } catch { /* offline — keep what we had */ }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
    const vis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", vis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [load]);
  const open = data?.cards.filter((c) => c.state === "open").length ?? 0;
  const fresh = data?.dms.filter((d) => Date.now() - d.at < DM_FRESH_MS).length ?? 0;
  return { data, reload: load, waiting: open + fresh, open };
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** Desktop entry, beside the bell. */
export function TeamButton({ waiting, onOpen }: { waiting: number; onOpen: () => void }) {
  return (
    <button onClick={onOpen} title={`${waiting} from the team`} aria-label="From the team"
      className="relative rounded-lg border border-[var(--sakura)]/40 px-2 py-1 text-xs leading-none text-[var(--sakura)]">
      <Users className="h-3.5 w-3.5" />
      <span className="absolute -right-1 -top-1 min-w-[15px] rounded-full bg-[var(--sakura)] px-1 text-[9px] font-semibold leading-[15px] text-white">{waiting > 9 ? "9+" : waiting}</span>
    </button>
  );
}

/** Phone entry: the first row of the inbox. */
export function TeamRow({ inbox, waiting, onOpen }: { inbox: Inbox; waiting: number; onOpen: () => void }) {
  const first = inbox.cards.find((c) => c.state === "open");
  const dm = inbox.dms[0];
  const line = first ? `${first.asker}: ${first.headline || first.topic}` : dm ? `${dm.from}: ${dm.text}` : "";
  return (
    <button onClick={onOpen} className="mx-3 mt-3 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-2xl border border-[var(--sakura)]/30 bg-[var(--sakura)]/[0.07] px-4 py-3 text-left">
      <Users className="h-5 w-5 shrink-0 text-[var(--sakura)]" />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold text-neutral-100">From the team · {waiting}</span>
        <span className="block truncate text-[13px] text-neutral-400">{line}</span>
      </span>
    </button>
  );
}

type View = { kind: "list" } | { kind: "card"; ts: string } | { kind: "dm"; ts: string };

export function TeamSheet({ inbox, reload, onClose, onExplained }: {
  inbox: Inbox | null; reload: (force?: boolean) => void; onClose: () => void;
  /** A chat was started for this item — the page opens it. */
  onExplained: (sessionId: string) => void;
}) {
  const [view, setView] = useState<View>({ kind: "list" });
  useBackLayer(view.kind !== "list", () => setView({ kind: "list" }));
  const card = view.kind === "card" ? inbox?.cards.find((c) => c.ts === view.ts) : undefined;
  const dm = view.kind === "dm" ? inbox?.dms.find((d) => d.ts === view.ts) : undefined;
  const [explaining, setExplaining] = useState(false);
  const [explainErr, setExplainErr] = useState("");
  const explain = async (ts: string, isDm: boolean) => {
    setExplaining(true); setExplainErr("");
    try {
      const d = await (await fetch("/api/team/explain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ts, dm: isDm }) })).json();
      if (d?.ok && d.sessionId) { onExplained(d.sessionId); onClose(); }
      else setExplainErr(d?.error || "Couldn't start the chat");
    } catch { setExplainErr("Couldn't start the chat"); }
    setExplaining(false);
  };

  return (
    <div className="fixed inset-0 z-[80] flex justify-end bg-black/50 md:items-start md:p-3 md:pt-12" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full flex-col bg-neutral-950 md:h-auto md:max-h-[85vh] md:w-[36rem] md:rounded-2xl md:border md:border-white/10 md:shadow-2xl"
        style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-3 py-2.5">
          {view.kind !== "list"
            ? <button onClick={() => setView({ kind: "list" })} aria-label="Back" className="rounded-lg p-2 text-neutral-400 hover:text-neutral-100"><ArrowLeft className="h-4 w-4" /></button>
            : <Users className="ml-2 h-4 w-4 text-[var(--sakura)]" />}
          <span className="flex-1 text-[14px] font-semibold text-neutral-200">{view.kind === "list" ? "From the team" : card ? card.asker : dm ? dm.from : ""}</span>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-2 text-neutral-500 hover:text-neutral-200"><X className="h-4 w-4" /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {!inbox ? <p className="p-6 text-center text-sm text-neutral-500">Reading Slack…</p>
          : !inbox.ok ? <p className="p-6 text-sm text-neutral-400">{inbox.reason}</p>
          : view.kind === "list" ? <List inbox={inbox} onPick={setView} />
          : card ? <CardView card={card} reload={reload} explaining={explaining} explainErr={explainErr} onExplain={() => explain(card.ts, false)} />
          : dm ? <DmView dm={dm} gate={inbox.gates.files} reload={reload} explaining={explaining} explainErr={explainErr} onExplain={() => explain(dm.ts, true)} />
          : <p className="p-6 text-sm text-neutral-500">That one is gone — withdrawn or answered elsewhere.</p>}
        </div>
      </div>
    </div>
  );
}

const STATE: Record<TeamCard["state"], { label: string; cls: string }> = {
  open: { label: "Needs you", cls: "text-[#4ade80]" },
  sent: { label: "Sent", cls: "text-[var(--sakura)]" },
  answered: { label: "Answered", cls: "text-neutral-500" },
  expired: { label: "Expired", cls: "text-neutral-600" },
};

function List({ inbox, onPick }: { inbox: Inbox; onPick: (v: View) => void }) {
  const live = inbox.cards.filter((c) => c.state === "open" || c.state === "sent");
  const done = inbox.cards.filter((c) => c.state === "answered" || c.state === "expired").slice(0, 8);
  const Row = ({ c }: { c: TeamCard }) => (
    <button onClick={() => onPick({ kind: "card", ts: c.ts })} className="block w-full border-b border-white/[0.05] px-4 py-3 text-left hover:bg-white/[0.03]">
      <span className="flex items-baseline gap-2 text-[12px]">
        <span className={`font-semibold ${STATE[c.state].cls}`}>{STATE[c.state].label}</span>
        <span className="text-neutral-500">{c.asker}{c.repo ? ` · ${c.repo}` : ""} · {ago(c.at)}</span>
        {c.files.length > 0 && <Paperclip className="h-3 w-3 text-neutral-500" />}
      </span>
      <span className="mt-0.5 block text-[15px] leading-snug text-neutral-100">{c.headline || c.topic}</span>
      {c.state === "open" && c.questions.length > 1 && <span className="text-[12px] text-neutral-500">{c.questions.length} questions</span>}
    </button>
  );
  return (
    <>
      {live.length === 0 && inbox.dms.length === 0 && <p className="p-6 text-center text-sm text-neutral-500">Nothing waiting on you.</p>}
      {live.map((c) => <Row key={c.ts} c={c} />)}
      {inbox.dms.length > 0 && <h3 className="px-4 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.09em] text-neutral-500">Messages</h3>}
      {inbox.dms.slice(0, 15).map((d) => (
        <button key={d.ts} onClick={() => onPick({ kind: "dm", ts: d.ts })} className="block w-full border-b border-white/[0.05] px-4 py-3 text-left hover:bg-white/[0.03]">
          <span className="flex items-baseline gap-2 text-[12px] text-neutral-500"><span className="font-semibold text-neutral-300">{d.from}</span> · {ago(d.at)}{d.files.length > 0 && <Paperclip className="h-3 w-3" />}</span>
          <span className="mt-0.5 line-clamp-2 block text-[14px] leading-snug text-neutral-200">{d.text || d.files.map((f) => f.name).join(", ")}</span>
        </button>
      ))}
      {done.length > 0 && <h3 className="px-4 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-[0.09em] text-neutral-600">Earlier</h3>}
      {done.map((c) => <Row key={c.ts} c={c} />)}
      {(inbox.gates.dms || inbox.gates.files) && (
        <div className="m-3 rounded-xl border border-white/10 p-3 text-[12px] leading-relaxed text-neutral-500">
          {inbox.gates.dms && <p>{inbox.gates.dms}</p>}
          {inbox.gates.files && <p className="mt-1">{inbox.gates.files}</p>}
          <p className="mt-1">Questions from team-ask work without either.</p>
        </div>
      )}
    </>
  );
}

const Sec = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mt-4">
    <h4 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-neutral-500">{title}</h4>
    <div className="mt-1 whitespace-pre-wrap text-[15px] leading-relaxed text-neutral-200">{children}</div>
  </section>
);

function ExplainButton({ onExplain, explaining, err }: { onExplain: () => void; explaining: boolean; err: string }) {
  return (
    <>
      <button onClick={onExplain} disabled={explaining}
        className="flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-white/15 px-4 text-[14px] text-neutral-200 hover:border-white/30 disabled:opacity-50">
        <Sparkles className="h-4 w-4" />{explaining ? "Starting a chat…" : "Explain with AI"}
      </button>
      {err && <p className="text-[12px] text-[#ef7c7c]">{err}</p>}
    </>
  );
}

function CardView({ card, reload, onExplain, explaining, explainErr }: { card: TeamCard; reload: (force?: boolean) => void; onExplain: () => void; explaining: boolean; explainErr: string }) {
  // Pre-pick the asker's recommendation, as the Slack card does: agreeing is then one tap on Send.
  const [picked, setPicked] = useState<string[][]>(() => card.questions.map((q) => (q.rec ? [q.rec] : [])));
  const [other, setOther] = useState<string[]>(() => card.questions.map(() => ""));
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const editable = card.state === "open";
  const send = async () => {
    setSending(true); setErr("");
    const answers: Answer[] = card.questions.map((_, i) => (picked[i].length || other[i].trim() ? { picked: picked[i], ...(other[i].trim() ? { text: other[i].trim() } : {}) } : null));
    try {
      const d = await (await fetch("/api/team/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ts: card.ts, answers, text: note }) })).json();
      if (d?.ok) reload(true); else setErr(d?.error || "Didn't send");
    } catch { setErr("Didn't send — try again"); }
    setSending(false);
  };

  return (
    <div className="px-4 pb-6 pt-3 md:px-5">
      <p className="text-[12px] text-neutral-500"><span className={`font-semibold ${STATE[card.state].cls}`}>{STATE[card.state].label}</span> · {card.repo || "no repo"} · {ago(card.at)}{card.context ? ` · ${card.context}` : ""}</p>
      <h2 className="mt-1 text-[19px] font-semibold leading-snug text-neutral-50">{card.headline || card.topic}</h2>
      {card.headline && card.topic !== card.headline && <p className="text-[13px] text-neutral-500">{card.topic}</p>}
      {card.doing && <Sec title="What they're doing">{card.doing}</Sec>}
      {card.whyNow && <Sec title={card.kind === "review" ? "Why they want your review" : "Why it's your call"}>{card.whyNow}</Sec>}
      {card.blocking && <Sec title="What it blocks">{card.blocking}</Sec>}
      {card.settled?.length ? <Sec title="Already settled">{card.settled.map((s) => `• ${s}`).join("\n")}</Sec> : null}
      {card.review && <Sec title="Review">{card.review.ask}{card.review.steps?.length ? "\n" + card.review.steps.map((s, i) => (/^\d+[.)]/.test(s) ? s : `${i + 1}. ${s}`)).join("\n") : ""}</Sec>}
      {card.files.map((f) => (
        <details key={f.name} className="mt-4 rounded-xl border border-white/10">
          <summary className="flex min-h-[44px] cursor-pointer items-center gap-2 px-3 text-[14px] text-neutral-300"><Paperclip className="h-3.5 w-3.5" />{f.name} <span className="text-neutral-600">· {f.lines} lines</span></summary>
          {/\.(md|markdown)$/i.test(f.name)
            ? <div className="max-h-[60vh] overflow-auto border-t border-white/10 px-3 py-2 text-[14px]"><Markdown text={f.text} /></div>
            : <pre className="max-h-[50vh] overflow-auto border-t border-white/10 p-3 text-[12px] leading-relaxed text-neutral-300">{f.text}</pre>}
        </details>
      ))}

      {card.questions.map((q, i) => (
        <section key={i} className="mt-6">
          <h3 className="text-[16px] font-semibold leading-snug text-neutral-100">{card.questions.length > 1 ? `${i + 1}. ` : ""}{q.q}</h3>
          <div className="mt-2 flex flex-col gap-2">
            {q.options.map((o) => {
              const on = picked[i]?.includes(o.label);
              return (
                <button key={o.label} disabled={!editable} onClick={() => setPicked((p) => p.map((x, j) => (j === i ? (on ? [] : [o.label]) : x)))}
                  className={`rounded-xl border px-3.5 py-2.5 text-left transition-colors ${on ? "border-[var(--sakura)] bg-[var(--sakura)]/10" : "border-white/10 hover:border-white/25"} disabled:cursor-default`}>
                  <span className="flex items-baseline gap-2 text-[15px] font-medium text-neutral-100">{o.label}{o.label === q.rec && <span className="text-[12px] font-normal text-amber-300">⭐ recommended</span>}</span>
                  <span className="mt-0.5 block text-[13px] leading-relaxed text-neutral-400">{o.description}</span>
                </button>
              );
            })}
          </div>
          {q.reason && <p className="mt-2 text-[13px] leading-relaxed text-neutral-500">Why they recommend it: {q.reason}</p>}
          {editable && <input value={other[i]} onChange={(e) => setOther((p) => p.map((x, j) => (j === i ? e.target.value : x)))} placeholder="Or say it in your words"
            className="mt-2 w-full rounded-xl border border-white/10 bg-transparent px-3 py-2.5 text-[15px] text-neutral-100 placeholder:text-neutral-600 focus:border-white/30 focus:outline-none" />}
        </section>
      ))}

      {editable ? (
        <>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="A note for them (optional)"
            className="mt-5 w-full resize-y rounded-xl border border-white/10 bg-transparent px-3 py-2.5 text-[15px] text-neutral-100 placeholder:text-neutral-600 focus:border-white/30 focus:outline-none" />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row-reverse">
            <button onClick={send} disabled={sending} className="min-h-[44px] flex-1 rounded-xl bg-[var(--sakura)] px-4 text-[15px] font-semibold text-white disabled:opacity-50">{sending ? "Sending…" : "Send answer"}</button>
            <ExplainButton onExplain={onExplain} explaining={explaining} err="" />
          </div>
          {(err || explainErr) && <p className="mt-2 text-[13px] text-[#ef7c7c]">{err || explainErr}</p>}
        </>
      ) : (
        <div className="mt-5 rounded-xl border border-white/10 p-3 text-[13px] leading-relaxed text-neutral-400">
          {card.state === "sent" ? "Sent. Slack's card closes when their machine picks it up — usually within 20 seconds." : card.summary || STATE[card.state].label}
        </div>
      )}
    </div>
  );
}

function DmView({ dm, gate, reload, onExplain, explaining, explainErr }: { dm: TeamDm; gate?: string; reload: (force?: boolean) => void; onExplain: () => void; explaining: boolean; explainErr: string }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"" | "sending" | "sent">("");
  const [err, setErr] = useState("");
  const send = async () => {
    setState("sending"); setErr("");
    try {
      const d = await (await fetch("/api/team/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ts: dm.ts, text }) })).json();
      if (d?.ok) { setState("sent"); setText(""); reload(true); } else { setState(""); setErr(d?.error || "Didn't send"); }
    } catch { setState(""); setErr("Didn't send — try again"); }
  };
  return (
    <div className="px-4 pb-6 pt-3 md:px-5">
      <p className="text-[12px] text-neutral-500">{dm.from} · {ago(dm.at)}</p>
      {dm.text && <p className="mt-2 whitespace-pre-wrap text-[16px] leading-relaxed text-neutral-100">{dm.text}</p>}
      {dm.files.map((f) => f.mimetype.startsWith("image/") && !gate
        ? <a key={f.id} href={`/api/team/file?id=${f.id}`} target="_blank" rel="noreferrer"><img src={`/api/team/file?id=${f.id}`} alt={f.name} className="mt-3 max-h-80 rounded-xl border border-white/10" /></a>
        : <a key={f.id} href={gate ? undefined : `/api/team/file?id=${f.id}`} target="_blank" rel="noreferrer"
            className="mt-3 flex min-h-[44px] items-center gap-2 rounded-xl border border-white/10 px-3 text-[14px] text-neutral-300"><Paperclip className="h-3.5 w-3.5" />{f.name}<span className="text-neutral-600">· {Math.max(1, Math.round(f.size / 1024))} KB{gate ? " · needs files:read" : ""}</span></a>)}
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder={`Reply to ${dm.from}`}
        className="mt-5 w-full resize-y rounded-xl border border-white/10 bg-transparent px-3 py-2.5 text-[15px] text-neutral-100 placeholder:text-neutral-600 focus:border-white/30 focus:outline-none" />
      <div className="mt-3 flex flex-col gap-2 sm:flex-row-reverse">
        <button onClick={send} disabled={!text.trim() || state === "sending"} className="min-h-[44px] flex-1 rounded-xl bg-[var(--sakura)] px-4 text-[15px] font-semibold text-white disabled:opacity-50">{state === "sending" ? "Sending…" : state === "sent" ? "Sent ✓" : "Send reply"}</button>
        <ExplainButton onExplain={onExplain} explaining={explaining} err="" />
      </div>
      {(err || explainErr) && <p className="mt-2 text-[13px] text-[#ef7c7c]">{err || explainErr}</p>}
    </div>
  );
}
