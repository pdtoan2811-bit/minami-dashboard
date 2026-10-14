"use client";
// The Ideas page (§28): everything Thomas stashed — links, memes, screenshots, forwards, half-thoughts —
// sorted three ways: what's HOT now (recent, echoing a building theme, or touched by him), by DAY, and
// by THEME. Cold items fold away but are never deleted; one a new item echoes "came back". Capture is
// mostly a Slack DM to Minami; the drop box here is for the laptop (paste, drag, or type).
// Same material as /today (app/today/ui.tsx).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { RankedIdea, Theme } from "@/lib/ideas";
import { K, mix, hhmm, Ground, TopBar, Glass, Eyebrow, Title, PillButton, Chip, TextButton } from "../today/ui";

type Data = { items: RankedIdea[]; themes: Theme[]; removed: number };
type View = "hot" | "days" | "themes" | "cold";
const KIND: Record<string, string> = { news: "#6fe3ff", meme: "#f3c766", tool: "#90aeff", idea: "#7be495", quote: "#db6393", product: "#c38400", video: "#ec3a3e", thread: "#90aeff" };
const ARROW = { up: "↑", flat: "·", down: "↓" } as const;
const IMG = /^image\//;
const localDate = (d = new Date()) => d.toLocaleDateString("en-CA");
function dayLabel(d: string) {
  const t = localDate(), y = localDate(new Date(Date.now() - 86400e3));
  return d === t ? "Today" : d === y ? "Yesterday" : new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export function Ideas() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<View>("hot");
  const [tag, setTag] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await fetch("/api/ideas", { cache: "no-store" }).then((r) => r.json());
      if (mine !== seq.current) return; // an edit landed meanwhile; its own reload is newer
      if (r.error) setErr(r.error); else { setData(r); setErr(null); }
    } catch { setErr("Couldn't reach the dashboard."); }
  }, []);
  useEffect(() => { load(); }, [load]);
  // 5 s while something is being read (he usually just sent it and is watching), else every 30 s.
  const reading = data?.items.some((x) => x.status === "enriching");
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, reading ? 5000 : 30000);
    const f = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", f);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", f); };
  }, [load, reading]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast]);

  const act = useCallback(async (body: Record<string, unknown>) => {
    seq.current++;
    const r = await fetch("/api/ideas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => ({ error: "Couldn't save — check the connection." }));
    if (r.error) setToast(r.error);
    await load();
    return r;
  }, [load]);

  const items = data?.items ?? [];
  const today = localDate();
  const shown = useMemo(() => {
    const byTag = tag ? items.filter((x) => x.tags?.includes(tag)) : items;
    if (view === "hot") return byTag.filter((x) => x.heat !== "cold");
    if (view === "cold") return byTag.filter((x) => x.heat === "cold");
    return byTag;
  }, [items, view, tag]);
  const days = useMemo(() => {
    const m = new Map<string, RankedIdea[]>();
    for (const x of [...shown].sort((a, b) => b.at.localeCompare(a.at))) m.set(x.date, [...(m.get(x.date) ?? []), x]);
    return [...m.entries()];
  }, [shown]);

  if (!data) return <Ground><TopBar right={<Nav />} /><p className="pt-24 text-center text-sm" style={{ color: K.muted }}>{err ?? "Loading…"}</p></Ground>;

  const hot = items.filter((x) => x.heat === "hot").length, cold = items.filter((x) => x.heat === "cold").length;
  const rising = data.themes.filter((t) => t.trend === "up").slice(0, 3);
  return (
    <Ground>
      <TopBar right={<Nav />} />
      <main className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-4 pb-24 sm:px-0">
        <Glass elevated className="flex flex-col items-center gap-3 px-6 py-8 text-center">
          <Eyebrow>IDEAS · {items.length} SAVED · {items.filter((x) => x.date === today).length} TODAY</Eyebrow>
          <Title size="m">{hot ? `${hot} hot right now` : items.length ? "Nothing hot — send Minami something" : "Send Minami anything"}</Title>
          <p className="max-w-[440px] text-[13.5px] leading-snug" style={{ color: K.muted }}>
            {rising.length ? <>Rising: {rising.map((t, i) => <span key={t.tag}>{i ? " · " : ""}<button onClick={() => { setTag(t.tag); setView("hot"); }} className="underline-offset-2 hover:underline" style={{ color: K.ink }}>{t.tag}</button> ↑</span>)}</>
              : "DM Minami in Ownego a link, a meme or a thought, with or without a word. It lands here, sorted by day and by how hot it is."}
          </p>
        </Glass>

        <Drop onSaved={() => { setToast("Saved — Minami is reading it."); load(); }} onError={setToast} />

        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          <Chip on={view === "hot"} onClick={() => setView("hot")}>Hot & warm</Chip>
          <Chip on={view === "days"} onClick={() => setView("days")}>By day</Chip>
          <Chip on={view === "themes"} onClick={() => setView("themes")}>Themes <span style={{ color: K.faint }}>{data.themes.length}</span></Chip>
          <Chip on={view === "cold"} onClick={() => setView("cold")}>Cold <span style={{ color: K.faint }}>{cold}</span></Chip>
        </div>
        {tag && <div className="flex items-center gap-2 text-[13px]" style={{ color: K.muted }}>Only <b style={{ color: K.ink }}>#{tag}</b><TextButton onClick={() => setTag(null)}>✕ clear</TextButton></div>}

        {view === "themes" ? <Themes themes={data.themes} onPick={(t) => { setTag(t); setView("days"); }} />
          : view === "days" ? days.map(([d, xs]) => (
              <section key={d} className="flex flex-col gap-2">
                <Eyebrow>{dayLabel(d).toUpperCase()} · {xs.length}</Eyebrow>
                {xs.map((x) => <Card key={x.id} x={x} act={act} />)}
              </section>))
          : shown.length ? shown.map((x) => <Card key={x.id} x={x} act={act} />)
          : <p className="py-10 text-center text-[13.5px]" style={{ color: K.faint }}>{view === "cold" ? "Nothing cold yet — items cool off after about two weeks untouched." : "Nothing here yet."}</p>}
      </main>
      {toast && <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4"><div className="rounded-full px-4 py-2.5 text-[13.5px]" style={{ background: K.paper, border: `1px solid ${K.line2}` }}>{toast}</div></div>}
    </Ground>
  );
}

function Nav() {
  return <><Link href="/today" className="rounded-full px-3 py-1.5 hover:text-white">Today</Link><Link href="/" className="rounded-full px-3 py-1.5 hover:text-white">Board</Link></>;
}

/** Paste, drag or type. Images pasted from the clipboard (a screenshot) count as files. */
function Drop({ onSaved, onError }: { onSaved: () => void; onError: (e: string) => void }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const save = async () => {
    if (!text.trim() && !files.length) return;
    setBusy(true);
    const form = new FormData();
    form.set("text", text);
    for (const f of files) form.append("file", f);
    const r = await fetch("/api/ideas", { method: "POST", body: form }).then((r) => r.json()).catch(() => ({ error: "Couldn't save — check the connection." }));
    setBusy(false);
    if (r.error) return onError(r.error);
    setText(""); setFiles([]); onSaved();
  };
  return (
    <Glass className="p-3">
      <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); setFiles((f) => [...f, ...Array.from(e.dataTransfer.files)]); }}
        className="rounded-[22px] transition-colors" style={{ background: over ? mix(K.accent, 18) : "transparent" }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={text.includes("\n") || text.length > 70 ? 3 : 1}
          onPaste={(e) => { const fs = Array.from(e.clipboardData.files); if (fs.length) { e.preventDefault(); setFiles((f) => [...f, ...fs]); } }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save(); }}
          placeholder="Paste a link, a thought, or an image…" className="w-full resize-none bg-transparent px-3 py-2 text-[15px] outline-none placeholder:text-white/35" />
        {!!files.length && <div className="flex flex-wrap gap-1.5 px-3 pb-2">{files.map((f, i) => (
          <button key={i} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="rounded-full px-2.5 py-1 text-[12px]" style={{ background: "rgba(255,255,255,.08)", color: K.muted }}>
            {f.name || "pasted image"} ✕</button>))}</div>}
      </div>
      <div className="flex items-center gap-2 px-1 pt-1">
        <input ref={pick} type="file" multiple hidden onChange={(e) => { setFiles((f) => [...f, ...Array.from(e.target.files ?? [])]); e.target.value = ""; }} />
        <TextButton onClick={() => pick.current?.click()}>+ File</TextButton>
        <span className="hidden text-[12px] sm:inline" style={{ color: K.faint }}>or drop / paste one · ⌘↵ saves</span>
        <div className="ml-auto"><PillButton tone="accent" small disabled={busy || (!text.trim() && !files.length)} onClick={save}>{busy ? "Saving…" : "Save"}</PillButton></div>
      </div>
    </Glass>
  );
}

function Card({ x, act }: { x: RankedIdea; act: (b: Record<string, unknown>) => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const img = x.files.findIndex((f) => f.path && IMG.test(f.mime || ""));
  const link = x.links[0];
  const thumb = img >= 0 ? `/api/ideas/media/${x.id}/${img}` : link?.image || null;
  const color = KIND[x.kind || ""] || K.faint;
  return (
    <Glass className="overflow-hidden">
      <div className="flex gap-3.5 p-3.5">
        {thumb && <button onClick={() => setOpen(!open)} className="shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- local media and arbitrary og:images; next/image would need every host allow-listed */}
          <img src={thumb} alt="" loading="lazy" referrerPolicy="no-referrer" className={`rounded-[16px] object-cover ${open ? "h-auto w-[160px]" : "h-[72px] w-[72px]"}`} style={{ background: "rgba(255,255,255,.05)" }} /></button>}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2 text-[10.5px]" style={{ fontFamily: "var(--today-mono)", color: K.faint }}>
            <span style={{ color }}>{(x.kind || (x.status === "enriching" ? "reading" : "item")).toUpperCase()}</span>
            <span>{hhmm(x.at)}{x.source === "dashboard" ? " · here" : ""}</span>
            {x.heat === "hot" && <span style={{ color: "#ff9a6b" }}>HOT</span>}
            {x.cameBack && <span style={{ color: K.accent2 }}>CAME BACK</span>}
            {x.starred && <span>🔥</span>}
          </div>
          <button onClick={() => setOpen(!open)} className="text-left text-[15px] font-semibold leading-snug" style={{ color: K.ink }}>
            {x.status === "enriching" ? (x.note || link?.url || "Reading…") : x.title}</button>
          {x.gist && <p className={`text-[13px] leading-snug ${open ? "" : "line-clamp-2"}`} style={{ color: K.muted }}>{x.gist}</p>}
          {x.status === "enriching" && <p className="text-[12.5px]" style={{ color: K.faint }}>Minami is reading this — a few seconds.</p>}
          {x.status === "failed" && <p className="text-[12.5px]" style={{ color: "#ff8a8d" }}>Couldn't read it{x.error ? ` — ${x.error}` : ""}. <button onClick={() => act({ op: "retry", id: x.id })} className="underline hover:text-white">Try again</button></p>}
          {!!x.tags?.length && <div className="flex flex-wrap gap-1 pt-0.5">{x.tags.map((t) => <span key={t} className="rounded-full px-2 py-0.5 text-[11px]" style={{ background: "rgba(255,255,255,.06)", color: K.faint }}>#{t}</span>)}</div>}
        </div>
      </div>
      {open && (
        <div className="flex flex-col gap-2.5 px-3.5 pb-3.5" style={{ borderTop: `1px solid ${K.line}` }}>
          <div className="pt-3" />
          {x.note && <p className="text-[13px]" style={{ color: K.muted }}>You: “{x.note}”</p>}
          {x.why && <p className="text-[13px]" style={{ color: K.faint }}>For you: {x.why}</p>}
          {x.shared && <p className="whitespace-pre-line text-[13px]" style={{ color: K.muted }}>{x.shared}</p>}
          {x.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className="truncate text-[13px] underline-offset-2 hover:underline" style={{ color: K.accentBright }}>{l.site ? `${l.site} · ` : ""}{l.title || l.url}</a>)}
          {x.files.filter((f, i) => i !== img).map((f, i) => <span key={i} className="text-[12.5px]" style={{ color: K.faint }}>📎 {f.name}{f.skipped ? ` — ${f.skipped}` : ""}</span>)}
          {x.comments.map((c, i) => <p key={i} className="text-[13px]" style={{ color: K.muted }}><span style={{ fontFamily: "var(--today-mono)", fontSize: 11, color: K.faint }}>{hhmm(c.at)} </span>{c.text}</p>)}
          <form onSubmit={async (e) => { e.preventDefault(); if (!note.trim()) return; await act({ op: "comment", id: x.id, text: note }); setNote(""); }} className="flex items-center gap-2">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a thought…" className="min-w-0 flex-1 rounded-full bg-transparent px-3.5 py-2 text-[13.5px] outline-none placeholder:text-white/35" style={{ border: `1px solid ${K.line2}` }} />
          </form>
          <div className="flex items-center gap-3 text-[13px]">
            <PillButton tone={x.starred ? "accent" : "paper"} small onClick={() => act({ op: "star", id: x.id, on: !x.starred })}>🔥 {x.starred ? "Hot" : "Mark hot"}</PillButton>
            <button onClick={() => act({ op: "remove", id: x.id })} className="ml-auto hover:text-white" style={{ color: K.faint }}>Remove</button>
          </div>
        </div>
      )}
    </Glass>
  );
}

function Themes({ themes, onPick }: { themes: Theme[]; onPick: (t: string) => void }) {
  if (!themes.length) return <p className="py-10 text-center text-[13.5px]" style={{ color: K.faint }}>Themes appear once a topic shows up twice.</p>;
  return (
    <Glass className="overflow-hidden">
      <ul>{themes.map((t, i) => (
        <li key={t.tag} style={{ borderTop: i ? `1px solid ${K.line}` : undefined }}>
          <button onClick={() => onPick(t.tag)} className="flex w-full items-center gap-3 px-5 py-3.5 text-left">
            <span className="text-[15px] font-semibold">#{t.tag}</span>
            <span className="tabular-nums text-[12px]" style={{ fontFamily: "var(--today-mono)", color: K.faint }}>{t.count} saved · {t.recent} in 3 days</span>
            <span className="ml-auto text-[15px]" style={{ color: t.trend === "up" ? "#7be495" : t.trend === "down" ? K.faint : K.muted }}>{ARROW[t.trend]}</span>
          </button>
        </li>))}</ul>
    </Glass>
  );
}
