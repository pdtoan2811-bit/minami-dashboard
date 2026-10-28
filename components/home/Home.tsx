"use client";
// The top of `/` (§37), in the order the 2026-10-28 debate settled from 14 days of real use:
//   Ask line · Needs you · Where you left off · Today · (the tiles, below, unchanged)
// Every row is one tap into the SAME chat panel the tiles open. Nothing here is a new kind of screen.
import { useEffect, useState } from "react";
import { useShellData } from "@/components/shell/use-shell";
import { guessProject, splitAsks, startAsk } from "@/lib/ask";
import { useSetting } from "@/lib/use-settings";
import { openThread, threadPost, useThreads, type ProjectRef, type ThreadView } from "@/lib/use-threads";
import type { AgentMode } from "@/lib/use-agent";
import { DodBar, TINT } from "./TaskCard";

const ago = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const openChat = (sid: string) => window.dispatchEvent(new CustomEvent("minami:open-chat", { detail: sid }));
const head = "mb-1.5 flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-[0.09em] text-neutral-500";
const box = "overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025]";
const row = "flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.04]";
const btn = "shrink-0 rounded-lg border border-white/12 px-2.5 py-1 text-[12px] text-neutral-200 hover:border-white/30 pointer-coarse:py-2";

export function Dots({ dod, size = 7 }: { dod: { done: boolean }[]; size?: number }) {
  return (
    <span className="flex shrink-0 items-center gap-[3px]">
      {dod.map((d, i) => <span key={i} className="rounded-full" style={{ width: size, height: size, background: d.done ? "#4ade80" : "transparent", border: d.done ? "none" : "1.5px solid rgba(255,255,255,0.3)" }} />)}
    </span>
  );
}

// ── Ask line ─────────────────────────────────────────────────────────────────────────────────────
export function AskLine({ pinned }: { pinned?: boolean }) {
  const d = useThreads();
  const [perm] = useSetting<Exclude<AgentMode, "plan">>("permMode", "bypassPermissions");
  const [model] = useSetting<string | null>("chatModel", null);
  const [text, setText] = useState("");
  const [pick, setPick] = useState<ProjectRef | null>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const projects = d?.projects ?? [];
  // The chip says where this lands before it's sent: what you picked, else the project the text names,
  // else wherever you were last working.
  const named = guessProject(text, projects);
  const target = pick ?? named ?? (d?.threads[0] ? projects.find((p) => p.project === d.threads[0].project) : null) ?? projects[0] ?? null;
  const parts = splitAsks(text);

  const send = async (asOne: boolean) => {
    if (!target || !text.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      if (!asOne && parts.length >= 2) {
        // Each ask to the project IT names, falling back to the chip; only the first opens as a tab.
        for (const [i, a] of parts.entries()) await startAsk(guessProject(a, projects) ?? target, a, { mode: perm, model, open: i === 0 });
      } else await startAsk(target, text.trim(), { mode: perm, model });
      setText(""); setPick(null);
    } catch (e) { setErr(String((e as Error).message || e)); } finally { setBusy(false); }
  };

  return (
    <div className={pinned ? "fixed inset-x-0 z-30 border-t border-white/10 bg-neutral-950/95 px-3 pb-2 pt-2" : "mb-4"} style={pinned ? { bottom: "var(--shell-bottom)" } : undefined}>
      {parts.length >= 2 && (
        <div className="mb-2 rounded-xl border border-white/12 bg-neutral-900 p-2.5 text-[13px]">
          <p className="mb-1.5 text-neutral-300">{parts.length} asks — each becomes its own chat:</p>
          {parts.map((a, i) => <p key={i} className="truncate text-[12px] text-neutral-400"><span className="text-neutral-500">{(guessProject(a, projects) ?? target)?.project} ·</span> {a.split("\n").pop()}</p>)}
          <div className="mt-2 flex gap-2">
            <button onClick={() => send(false)} disabled={busy} className="rounded-lg bg-[var(--accent-fill)] px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40">Split into {parts.length}</button>
            <button onClick={() => send(true)} disabled={busy} className={btn}>Send as one</button>
          </div>
        </div>
      )}
      <div className="relative flex items-end gap-2 rounded-2xl border border-white/12 bg-white/[0.04] px-2 py-1.5">
        <button onClick={() => setMenu((v) => !v)} title="Where this ask goes — tap to change"
          className={`mb-0.5 flex h-8 max-w-[40%] shrink-0 items-center gap-1 rounded-xl px-2.5 text-[12px] ${pick || named ? "bg-[var(--sakura)]/15 text-[var(--sakura)]" : "bg-white/[0.06] text-neutral-300"}`}>
          <span className="truncate">{target?.project ?? "project"}</span><span className="opacity-60">▾</span>
        </button>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={1} placeholder="Ask anything…"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(parts.length < 2); } }}
          className="max-h-40 min-h-[34px] flex-1 resize-none bg-transparent py-1.5 text-[16px] leading-snug text-neutral-100 outline-none placeholder:text-neutral-600 md:text-[14px]"
          style={{ fieldSizing: "content" } as React.CSSProperties} />
        <button onClick={() => send(parts.length < 2)} disabled={!text.trim() || !target || busy}
          className="mb-0.5 h-8 shrink-0 rounded-xl bg-[var(--accent-fill)] px-3 text-[13px] font-semibold text-white disabled:opacity-30">{busy ? "…" : "↵"}</button>
        {menu && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
            <div className={`absolute left-0 z-40 max-h-72 w-60 overflow-y-auto rounded-xl border border-white/10 bg-neutral-900 p-1 shadow-2xl ${pinned ? "bottom-full mb-1" : "top-full mt-1"}`}>
              {projects.map((p) => (
                <button key={p.project} onClick={() => { setPick(p); setMenu(false); }} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-white/10 ${p.project === target?.project ? "text-[var(--sakura)]" : "text-neutral-200"}`}>
                  <span className="min-w-0 flex-1 truncate">{p.project}</span><span className="text-[11px] text-neutral-600">{ago(p.at)}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {err && <p className="mt-1 px-1 text-[12px] text-[#ef7c7c]">{err}</p>}
    </div>
  );
}

// ── Where you left off ───────────────────────────────────────────────────────────────────────────
function ThreadRow({ t, first }: { t: ThreadView; first: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={first ? "" : "border-t border-white/[0.06]"}>
      <div className="flex items-center">
        <button onClick={() => openThread(t)} className={`${row} min-w-0 flex-1`}>
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: TINT[t.state] }} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] text-neutral-100">{t.title}</span>
            <span className="block truncate text-[12px] text-neutral-500">
              <span className="text-neutral-400">{t.project}</span>
              {t.state === "working" ? " · working" : t.state === "waiting" ? " · waiting on you" : ""} · {ago(t.at)}{t.line ? ` — ${t.line}` : ""}
            </span>
          </span>
        </button>
        {!!t.dod?.length && <button onClick={() => setOpen((v) => !v)} className="w-24 shrink-0 px-3 py-3" title={t.dodPending ? "Minami's done-list" : "Definition of done"}><DodBar t={t} /></button>}
      </div>
      {open && t.dod && <DodList t={t} className="px-3.5 pb-2.5 pl-8" />}
    </div>
  );
}

/** A thread's done-list: tick, add, and archive once every item is met. Shared with the tile's task cards. */
export function DodList({ t, className = "" }: { t: ThreadView; className?: string }) {
  const [draft, setDraft] = useState("");
  if (!t.dod) return null;
  return (
    <div className={className}>
      {t.dod.map((x) => (
        <label key={x.id} className="flex cursor-pointer items-start gap-2 py-1 text-[13px]">
          <input type="checkbox" checked={x.done} onChange={() => void threadPost({ action: "dod.toggle", id: t.id, dodId: x.id })} className="mt-[3px] accent-[#4ade80]" />
          <span className={x.done ? "text-neutral-500 line-through" : "text-neutral-200"}>{x.t}</span>
        </label>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { void threadPost({ action: "dod.add", id: t.id, t: draft }); setDraft(""); } }} className="mt-1 flex gap-2">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="+ add" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-transparent px-2 py-1 text-[16px] outline-none md:text-[13px]" />
        {t.dod.every((x) => x.done) && <button type="button" onClick={() => void threadPost({ action: "archive", id: t.id })} className={btn}>Done — archive</button>}
      </form>
    </div>
  );
}

// ── Today ────────────────────────────────────────────────────────────────────────────────────────
type Todo = { id: string; title?: string; text: string; done?: boolean; handoff?: { sessionId?: string; cwd?: string } };
function useToday() {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  useEffect(() => {
    let on = true;
    const load = () => fetch("/api/today").then((r) => r.json()).then((j) => { if (on) setTodos(j?.day?.todos ?? []); }).catch(() => {});
    load(); const iv = setInterval(load, 30_000);
    return () => { on = false; clearInterval(iv); };
  }, []);
  return [todos, setTodos] as const;
}

export function Home({ filter }: { filter?: (project: string) => boolean }) {
  const d = useThreads();
  const shell = useShellData();
  const [todos, setTodos] = useToday();
  const [more, setMore] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const ok = (p: string) => !filter || filter(p);

  const needs = (shell?.needs ?? []).filter((n) => ok(n.project));
  const waitingSids = new Set(needs.flatMap((n) => (n.kind === "chat" ? [n.sid] : [])));
  const threads = (d?.threads ?? []).filter((t) => ok(t.project) && t.state !== "queued");
  const shown = threads.slice(0, more ? 10 : 4);
  const open = (todos ?? []).filter((t) => !t.done);
  const doneN = (todos ?? []).length - open.length;

  const run = async (t: Todo) => {
    setRunning(t.id);
    try {
      const r = await (await fetch("/api/today", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "handoff", kind: "todo", id: t.id, how: "do" }) })).json();
      if (r?.sessionId) { setTodos((xs) => xs?.map((x) => (x.id === t.id ? { ...x, handoff: { sessionId: r.sessionId } } : x)) ?? xs); openChat(r.sessionId); }
    } finally { setRunning(null); }
  };
  const go = (t: Todo) => {
    const sid = t.handoff?.sessionId; if (!sid) return;
    void fetch("/api/agent/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "live:" + sid, cwd: t.handoff?.cwd, message: "go", resume: sid }) });
  };

  return (
    <div className="mb-4 flex flex-col gap-4">
      {needs.length > 0 && (
        <section>
          <p className={head}><span className="h-1.5 w-1.5 rounded-full bg-[var(--sakura)]" />Needs you · {needs.length}</p>
          <div className={box}>
            {needs.slice(0, 5).map((n, i) => (
              <button key={i} onClick={() => (n.kind === "chat" ? openChat(n.sid) : location.assign(n.kind === "goal" ? `/autopilot#goal-${n.id}` : "/autopilot"))}
                className={`${row} ${i ? "border-t border-white/[0.06]" : ""}`}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: n.kind === "automation" ? "#ef7c7c" : "var(--sakura)" }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-neutral-100">{n.title}</span>
                  <span className="block truncate text-[12px] text-neutral-500"><span className="text-neutral-400">{n.project}</span>{n.summary ? ` — ${n.summary}` : ""}</span>
                </span>
                <span className="shrink-0 text-[12px] text-neutral-400">{n.kind === "automation" ? "failing" : n.kind === "goal" ? "goal" : "open"} ›</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {shown.length > 0 && (
        <section>
          <p className={head}>Where you left off</p>
          <div className={box}>{shown.map((t, i) => <ThreadRow key={t.id} t={t} first={i === 0} />)}</div>
          {threads.length > 4 && <button onClick={() => setMore((v) => !v)} className="mt-1 px-1 text-[12px] text-neutral-500 hover:text-neutral-300">{more ? "Fewer" : `${Math.min(threads.length, 10) - 4} more`}</button>}
        </section>
      )}

      {todos && (open.length > 0 || doneN > 0) && (
        <section>
          <p className={head}>☀ Today · {open.length ? `${open.length} left` : "all done"}{doneN ? ` · ${doneN} done` : ""}<a href="/today" className="ml-auto normal-case tracking-normal text-neutral-600 hover:text-neutral-300">plan ›</a></p>
          {open.length > 0 && (
            <div className={box}>
              {open.slice(0, 4).map((t, i) => {
                const sid = t.handoff?.sessionId;
                const waiting = !!sid && waitingSids.has(sid);
                return (
                  <div key={t.id} className={`${row} ${i ? "border-t border-white/[0.06]" : ""}`}>
                    <span className="min-w-0 flex-1 truncate text-[14px] text-neutral-200">{t.title || t.text}</span>
                    {!sid && <button onClick={() => void run(t)} disabled={running === t.id} className={btn}>{running === t.id ? "…" : "Run"}</button>}
                    {sid && waiting && <button onClick={() => go(t)} className="shrink-0 rounded-lg bg-[var(--accent-fill)] px-2.5 py-1 text-[12px] font-semibold text-white pointer-coarse:py-2">Go</button>}
                    {sid && <button onClick={() => openChat(sid)} className={btn}>Open</button>}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
