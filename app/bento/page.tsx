"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SessionMeta = {
  id: string; project: string; cwd: string; gitBranch: string; title: string; lastPrompt: string;
  model: string; tier: string; tokensIn: number; tokensOut: number; cost: number;
  messages: number; tools: number; toolNames: string[]; lastActivity: number; active: boolean;
  task?: string; topic?: string;
};
type Turn = { role: "user" | "assistant"; text: string; tools: { name: string; input: unknown }[]; ts: number; model?: string };

const TIER_TINT: Record<string, string> = { Haiku: "#6cc4a1", Sonnet: "#e8859b", Opus: "#b98cff", Fable: "#f0a868" };
const EMOJI: Record<string, string> = {
  secondBrain: "🧠", ownegoCentral: "🏢", ownego: "🏢", ecomIntel: "🛍️", qdn: "🌐",
  qdnNewWebsite: "🌐", "QSortby-website": "🔀", dataAnalyticsOwnego: "📊", adecosNew: "📦",
  adecosRMF: "📦", CV: "📄", "claude-status-bar-acos": "📟", qikifyDataKnowledge: "📚", minami: "🌸",
};
const PALETTE = ["#e8859b", "#b98cff", "#6cc4a1", "#6c9cf5", "#f0a868", "#e86c8b"];
function hashN(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
const thumb = (p: string) => EMOJI[p] || "◆";
const accent = (p: string) => PALETTE[hashN(p) % PALETTE.length];
const short = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function isTrivial(s: SessionMeta) {
  if (s.messages < 3) return true;
  const t = s.title.toLowerCase();
  return t.startsWith("reply with") || t.includes("model_ok") || t.startsWith("<local-command") || t.includes("caveat: the messages");
}
const topicOf = (s: SessionMeta) => s.topic || s.project;
const titleOf = (s: SessionMeta) => s.task || s.title;

const WINDOWS: { label: string; days: number | null }[] = [
  { label: "24h", days: 1 }, { label: "7d", days: 7 }, { label: "30d", days: 30 }, { label: "All", days: null },
];

export default function Bento() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sel, setSel] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ meta: SessionMeta | null; turns: Turn[] } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [q, setQ] = useState("");
  const [winDays, setWinDays] = useState<number | null>(7);
  const [hideTrivial, setHideTrivial] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const gridRef = useRef<HTMLDivElement>(null);
  const enrichLock = useRef(false);
  const rounds = useRef(0);
  const initCollapse = useRef(false);

  const loadSessions = useCallback(
    () => fetch("/api/bento/sessions").then((r) => r.json()).then((d) => { setSessions(d.sessions || []); setLoaded(true); }).catch(() => setLoaded(true)),
    [],
  );

  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) loadSessions(); };
    tick(); const iv = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(iv); };
  }, [loadSessions]);

  // Semantic labeling: summarize sessions missing a task (Haiku, cached). Progressive over rounds.
  useEffect(() => {
    if (!loaded || enrichLock.current || rounds.current >= 6) return;
    const missing = sessions.some((s) => !s.task && !isTrivial(s));
    if (!missing) return;
    enrichLock.current = true; setEnriching(true); rounds.current++;
    fetch("/api/bento/enrich", { method: "POST" })
      .then((r) => r.json())
      .then(() => loadSessions())
      .finally(() => { enrichLock.current = false; setEnriching(false); });
  }, [sessions, loaded, loadSessions]);

  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    let alive = true;
    const load = () => fetch(`/api/bento/session/${openId}`).then((r) => r.json()).then((d) => { if (alive) setDetail(d); }).catch(() => {});
    load(); const iv = setInterval(load, 2500);
    return () => { alive = false; clearInterval(iv); };
  }, [openId]);

  const { groups, flat } = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const filtered = sessions.filter((s) => {
      if (hideTrivial && isTrivial(s)) return false;
      if (winDays != null && Date.now() - s.lastActivity > winDays * 86400000) return false;
      if (ql && !(`${titleOf(s)} ${topicOf(s)} ${s.project} ${s.lastPrompt}`.toLowerCase().includes(ql))) return false;
      return true;
    });
    const m = new Map<string, SessionMeta[]>();
    for (const s of filtered) { const k = topicOf(s); const a = m.get(k); if (a) a.push(s); else m.set(k, [s]); }
    const groups = [...m.entries()].map(([topic, items]) => ({
      topic, items: items.sort((a, b) => b.lastActivity - a.lastActivity),
      last: Math.max(...items.map((i) => i.lastActivity)),
      cost: items.reduce((a, i) => a + i.cost, 0),
      active: items.some((i) => i.active),
    })).sort((a, b) => b.last - a.last);
    const flat = groups.filter((g) => !collapsed.has(g.topic)).flatMap((g) => g.items);
    return { groups, flat };
  }, [sessions, q, winDays, hideTrivial, collapsed]);

  // On first labeled data, collapse topics with no activity in 2 days.
  useEffect(() => {
    if (initCollapse.current || !loaded || groups.length === 0) return;
    initCollapse.current = true;
    setCollapsed(new Set(groups.filter((g) => Date.now() - g.last > 2 * 86400000).map((g) => g.topic)));
  }, [groups, loaded]);

  useEffect(() => { if (sel >= flat.length) setSel(0); }, [flat.length, sel]);

  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") { setOpenId(null); return; }
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (!flat.length) return;
    if (e.key === "Enter") { setOpenId(flat[sel]?.id ?? null); return; }
    let next = sel;
    if (e.key === "ArrowRight" || e.key === "Tab") { e.preventDefault(); next = (sel + 1) % flat.length; }
    else if (e.key === "ArrowLeft") next = (sel - 1 + flat.length) % flat.length;
    else if (e.key === "ArrowDown") next = Math.min(flat.length - 1, sel + 3);
    else if (e.key === "ArrowUp") next = Math.max(0, sel - 3);
    else return;
    setSel(next);
  }, [sel, flat]);
  useEffect(() => { window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onKey]);
  useEffect(() => { gridRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" }); }, [sel]);

  const toggle = (topic: string) => setCollapsed((prev) => { const n = new Set(prev); if (n.has(topic)) n.delete(topic); else n.add(topic); return n; });
  const open = openId ? sessions.find((s) => s.id === openId) : null;
  let idx = -1;

  return (
    <div className="flex h-screen w-screen overflow-hidden text-neutral-100" style={{ background: "radial-gradient(1100px 620px at 25% -12%, #1c1622, #0b0a0d 58%)" }}>
      <div className={`flex flex-col transition-all duration-300 ${openId ? "w-full md:w-[40%]" : "w-full"}`}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-4">
          <span className="text-xl">🌸</span>
          <h1 className="text-base font-semibold tracking-tight">Minami Bento</h1>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-400">{groups.length} topics · {flat.length}</span>
          {enriching && <span className="flex items-center gap-1 text-[11px] text-neutral-500"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[--sakura]" style={{ ["--sakura" as string]: "#e8859b" }} />labeling…</span>}
          <div className="ml-auto hidden gap-3 text-[11px] text-neutral-500 lg:flex"><span>↑↓←→ / Tab</span><span>↵ open</span><span>esc close</span></div>
        </header>

        {!openId && (
          <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search topic / task…"
              className="w-44 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs outline-none placeholder:text-neutral-600 focus:border-[--sakura]" style={{ ["--sakura" as string]: "#e8859b" }} />
            <div className="flex items-center gap-1 rounded-lg border border-white/10 p-0.5">
              {WINDOWS.map((w) => (
                <button key={w.label} onClick={() => setWinDays(w.days)} className={`rounded-md px-2 py-0.5 text-[11px] ${winDays === w.days ? "bg-[--sakura] text-white" : "text-neutral-400 hover:text-neutral-200"}`} style={{ ["--sakura" as string]: "#e8859b" }}>{w.label}</button>
              ))}
            </div>
            <button onClick={() => setHideTrivial((v) => !v)} className={`rounded-lg border px-2.5 py-1 text-[11px] ${hideTrivial ? "border-[--sakura] text-[--sakura]" : "border-white/10 text-neutral-400"}`} style={{ ["--sakura" as string]: "#e8859b" }}>{hideTrivial ? "✓ hide noise" : "show all"}</button>
          </div>
        )}

        <div ref={gridRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
          {!loaded ? <p className="mt-20 text-center text-sm text-neutral-500">Reading local sessions…</p>
          : sessions.length === 0 ? (
            <div className="mx-auto mt-20 max-w-md text-center text-sm text-neutral-500">No local Claude Code sessions found. Bento mirrors <code className="text-xs">~/.claude/projects</code> — run it locally.</div>
          ) : flat.length === 0 && collapsed.size === 0 ? <p className="mt-20 text-center text-sm text-neutral-500">Nothing matches these filters.</p>
          : (
            <div className="flex flex-col gap-4">
              {groups.map((g) => {
                const isCollapsed = collapsed.has(g.topic);
                return (
                  <section key={g.topic}>
                    <button onClick={() => toggle(g.topic)} className="mb-2 flex w-full items-center gap-2 text-left">
                      <span className={`text-neutral-500 transition-transform ${isCollapsed ? "" : "rotate-90"}`}>▸</span>
                      <h2 className="text-sm font-semibold">{g.topic}</h2>
                      {g.active && <span className="h-1.5 w-1.5 rounded-full bg-green-500" />}
                      <span className="text-[11px] text-neutral-500">{g.items.length} · ${g.cost.toFixed(2)}</span>
                      <span className="text-[11px] text-neutral-600">· {ago(g.last)}</span>
                      <div className="ml-2 h-px flex-1 bg-white/10" />
                    </button>
                    {!isCollapsed && (
                      <div className={openId ? "grid grid-cols-1 gap-3" : "grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 [grid-auto-flow:dense] [grid-auto-rows:9.5rem]"}>
                        {g.items.map((s, li) => {
                          idx++; const i = idx;
                          const stale = Date.now() - s.lastActivity > 3 * 86400000;
                          const hero = !openId && li === 0 && g.items.length >= 3;
                          const wide = !openId && li === 1 && g.items.length >= 6;
                          const span = hero ? "sm:col-span-2 sm:row-span-2" : wide ? "sm:col-span-2" : "";
                          const tint = TIER_TINT[s.tier] || "#b98cff";
                          return (
                            <button key={s.id} data-i={i} onMouseEnter={() => setSel(i)} onClick={() => setOpenId(s.id)}
                              className={`group relative flex flex-col gap-2 overflow-hidden rounded-[1.5rem] border p-4 text-left backdrop-blur transition-all duration-200 hover:-translate-y-0.5 ${span} ${
                                i === sel
                                  ? "border-[--sakura]/60 ring-1 ring-[--sakura] shadow-[0_18px_40px_-18px_rgba(232,133,155,0.5)]"
                                  : "border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_12px_30px_-16px_rgba(0,0,0,0.75)] hover:border-white/20"
                              } ${stale ? "opacity-55 hover:opacity-100" : ""}`}
                              style={{ ["--sakura" as string]: "#e8859b", background: "linear-gradient(150deg, rgba(255,255,255,0.09), rgba(255,255,255,0.02))" }}>
                              {(s.active || hero) && <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full blur-2xl" style={{ background: tint + "3a" }} />}
                              <div className="relative flex items-start justify-between">
                                <div className={`flex items-center justify-center rounded-xl ${hero ? "h-11 w-11 text-2xl" : "h-8 w-8 text-base"}`} style={{ background: accent(s.project) + "26" }}>{thumb(s.project)}</div>
                                <span className="flex items-center gap-1 text-[10px] text-neutral-400"><span className={`h-1.5 w-1.5 rounded-full ${s.active ? "animate-pulse bg-green-400" : "bg-neutral-600"}`} />{ago(s.lastActivity)}</span>
                              </div>
                              <p className={`relative font-semibold leading-snug [overflow-wrap:anywhere] ${hero ? "line-clamp-3 text-lg" : "line-clamp-2 text-sm"}`}>{titleOf(s)}</p>
                              {hero && s.lastPrompt && <p className="relative line-clamp-2 text-xs text-neutral-400 [overflow-wrap:anywhere]">{s.lastPrompt}</p>}
                              <p className="relative truncate text-[10px] text-neutral-500">{s.project}{s.gitBranch ? ` · ${s.gitBranch}` : ""}</p>
                              {hero ? (
                                <div className="relative mt-auto flex items-end justify-between">
                                  <div>
                                    <p className="text-3xl font-semibold tracking-tight tabular-nums">${s.cost.toFixed(2)}</p>
                                    <p className="text-[10px] text-neutral-500">{short(s.tokensIn + s.tokensOut)} tok · {s.messages} msg</p>
                                  </div>
                                  <span className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[10px]"><span className="h-1.5 w-1.5 rounded-full" style={{ background: tint }} />{s.tier}</span>
                                </div>
                              ) : (
                                <div className="relative mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-neutral-500">
                                  <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: tint }} />{s.tier}</span>
                                  <span>{s.messages} msg</span><span>{short(s.tokensIn + s.tokensOut)} tok</span><span className="tabular-nums">${s.cost.toFixed(2)}</span>
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className={`min-h-0 border-l border-white/10 bg-neutral-900/60 backdrop-blur transition-all duration-300 ${openId ? "w-full md:w-[60%]" : "w-0 overflow-hidden"}`}>
        {open && <PeekPanel meta={open} detail={detail} onClose={() => setOpenId(null)} />}
      </div>
    </div>
  );
}

function PeekPanel({ meta, detail, onClose }: { meta: SessionMeta; detail: { meta: SessionMeta | null; turns: Turn[] } | null; onClose: () => void }) {
  const turns = detail?.turns || [];
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [turns.length]);
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg text-base" style={{ background: accent(meta.project) + "22" }}>{thumb(meta.project)}</span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{meta.task || meta.title}</p>
            <p className="truncate text-[11px] text-neutral-500">{meta.topic ? `${meta.topic} · ` : ""}{meta.project}{meta.gitBranch ? ` · ${meta.gitBranch}` : ""}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-neutral-500">
          <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: TIER_TINT[meta.tier] }} />{meta.tier}</span>
          <span className="tabular-nums">${meta.cost.toFixed(3)}</span>
          <button onClick={onClose} className="rounded-md px-2 py-1 hover:bg-white/10">esc ✕</button>
        </div>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {turns.length === 0 ? <p className="text-sm text-neutral-500">Loading transcript…</p> : turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "flex justify-end" : ""}>
            <div className={`max-w-[92%] rounded-2xl px-3 py-2 text-sm [overflow-wrap:anywhere] ${t.role === "user" ? "bg-[--sakura]/20" : "bg-white/[0.04]"}`} style={{ ["--sakura" as string]: "#e8859b" }}>
              {t.text && <p className="whitespace-pre-wrap leading-relaxed text-neutral-200">{t.text}</p>}
              {t.tools.map((tool, j) => (
                <details key={j} className="mt-1.5 rounded-lg bg-black/30 px-2 py-1 text-xs">
                  <summary className="cursor-pointer select-none text-neutral-400"><span className="mr-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-neutral-300">tool</span>{tool.name}</summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[10px] text-neutral-500">{JSON.stringify(tool.input, null, 2)}</pre>
                </details>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-white/10 px-5 py-3">
        <div className="mb-2 flex items-center gap-1.5">
          {["default", "acceptEdits", "plan"].map((m) => <span key={m} className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-neutral-500">{m}</span>)}
          <span className="ml-auto text-[10px] text-neutral-600">read-only mirror · live drive = Phase 2</span>
        </div>
        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 opacity-60">
          <span className="text-neutral-500">＋</span>
          <input disabled placeholder="Chat with this session… (Phase 2)" className="flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-600" />
          <span className="text-xs text-neutral-600">↵</span>
        </div>
      </div>
    </div>
  );
}
