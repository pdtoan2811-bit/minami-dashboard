"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type SessionMeta = {
  id: string; project: string; cwd: string; gitBranch: string; title: string; lastPrompt: string;
  model: string; tier: string; tokensIn: number; tokensOut: number; cost: number;
  messages: number; tools: number; toolNames: string[]; lastActivity: number; active: boolean;
  task?: string; goal?: string;
};
type Turn = { role: "user" | "assistant"; text: string; tools: { name: string; input: unknown }[]; ts: number; model?: string };

const TIER_TINT: Record<string, string> = { Haiku: "#6cc4a1", Sonnet: "#e8859b", Opus: "#b98cff", Fable: "#f0a868" };
const EMOJI: Record<string, string> = {
  secondBrain: "🧠", ownegoCentral: "🏢", ownego: "🏢", ecomIntel: "🛍️", qdn: "🌐", qdnNewWebsite: "🌐",
  "QSortby-website": "🔀", dataAnalyticsOwnego: "📊", adecosNew: "📦", adecosRMF: "📦", CV: "📄",
  "claude-status-bar-acos": "📟", qikifyDataKnowledge: "📚", minami: "🌸",
};
const PALETTE = ["#e8859b", "#b98cff", "#6cc4a1", "#6c9cf5", "#f0a868", "#e86c8b"];
function hashN(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
const thumb = (p: string) => EMOJI[p] || "◆";
const accent = (p: string) => PALETTE[hashN(p) % PALETTE.length];
const short = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "now"; if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`; return `${Math.floor(s / 86400)}d`;
}
function isTrivial(s: SessionMeta) {
  if (s.messages < 3) return true;
  const t = s.title.toLowerCase();
  return t.startsWith("reply with") || t.includes("model_ok") || t.startsWith("<local-command") || t.includes("caveat: the messages");
}
const goalOf = (s: SessionMeta) => s.goal || "General";
const titleOf = (s: SessionMeta) => s.task || s.title;

type Project = { name: string; sessions: SessionMeta[]; reqs: number; tokens: number; last: number; active: boolean; goals: string[]; latest: string; weight: number };

const WINDOWS: { label: string; days: number | null }[] = [
  { label: "24h", days: 1 }, { label: "7d", days: 7 }, { label: "30d", days: 30 }, { label: "All", days: null },
];

export default function Bento() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ meta: SessionMeta | null; turns: Turn[] } | null>(null);
  const [drill, setDrill] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [q, setQ] = useState("");
  const [winDays, setWinDays] = useState<number | null>(30);
  const enrichLock = useRef(false);
  const rounds = useRef(0);

  const loadSessions = useCallback(
    () => fetch("/api/bento/sessions").then((r) => r.json()).then((d) => { setSessions(d.sessions || []); setLoaded(true); }).catch(() => setLoaded(true)),
    [],
  );
  useEffect(() => { let a = true; const t = () => { if (a) loadSessions(); }; t(); const iv = setInterval(t, 5000); return () => { a = false; clearInterval(iv); }; }, [loadSessions]);
  useEffect(() => {
    if (!loaded || enrichLock.current || rounds.current >= 6) return;
    if (!sessions.some((s) => !s.task && !isTrivial(s))) return;
    enrichLock.current = true; setEnriching(true); rounds.current++;
    fetch("/api/bento/enrich", { method: "POST" }).then((r) => r.json()).then(() => loadSessions()).finally(() => { enrichLock.current = false; setEnriching(false); });
  }, [sessions, loaded, loadSessions]);
  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    let a = true;
    const load = () => fetch(`/api/bento/session/${openId}`).then((r) => r.json()).then((d) => { if (a) setDetail(d); }).catch(() => {});
    load(); const iv = setInterval(load, 2500); return () => { a = false; clearInterval(iv); };
  }, [openId]);

  // sessions passing the base filters (window + noise)
  const pool = useMemo(() => sessions.filter((s) => {
    if (isTrivial(s)) return false;
    if (winDays != null && Date.now() - s.lastActivity > winDays * 86400000) return false;
    return true;
  }), [sessions, winDays]);

  // aggregate → one box per project, weighted by requests (messages) + tokens
  const projects = useMemo<Project[]>(() => {
    const m = new Map<string, SessionMeta[]>();
    for (const s of pool) { const a = m.get(s.project); if (a) a.push(s); else m.set(s.project, [s]); }
    const list = [...m.entries()].map(([name, ss]) => {
      const reqs = ss.reduce((a, x) => a + x.messages, 0);
      const tokens = ss.reduce((a, x) => a + x.tokensIn + x.tokensOut, 0);
      const last = Math.max(...ss.map((x) => x.lastActivity));
      const latest = [...ss].sort((a, b) => b.lastActivity - a.lastActivity)[0];
      const goals = [...new Set(ss.map(goalOf))];
      return { name, sessions: ss, reqs, tokens, last, active: ss.some((x) => x.active), goals, latest: titleOf(latest), weight: reqs + tokens / 5000 };
    }).sort((a, b) => b.weight - a.weight);
    const ql = q.trim().toLowerCase();
    return ql ? list.filter((p) => `${p.name} ${p.goals.join(" ")} ${p.latest}`.toLowerCase().includes(ql)) : list;
  }, [pool, q]);

  const drillSessions = useMemo(() => {
    if (!drill) return [];
    const ss = (projects.find((p) => p.name === drill)?.sessions ?? []).sort((a, b) => b.lastActivity - a.lastActivity);
    const ql = q.trim().toLowerCase();
    return ql ? ss.filter((s) => `${titleOf(s)} ${goalOf(s)}`.toLowerCase().includes(ql)) : ss;
  }, [drill, projects, q]);

  const navLen = drill ? drillSessions.length : projects.length;
  useEffect(() => { if (sel >= navLen) setSel(0); }, [navLen, sel]);

  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") { if (openId) setOpenId(null); else if (drill) setDrill(null); return; }
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (!navLen) return;
    if (e.key === "Enter") {
      if (drill) setOpenId(drillSessions[sel]?.id ?? null);
      else { setDrill(projects[sel]?.name ?? null); setSel(0); }
      return;
    }
    let n = sel;
    if (e.key === "ArrowRight" || e.key === "Tab") { e.preventDefault(); n = (sel + 1) % navLen; }
    else if (e.key === "ArrowLeft") n = (sel - 1 + navLen) % navLen;
    else if (e.key === "ArrowDown") n = Math.min(navLen - 1, sel + (drill ? 1 : 3));
    else if (e.key === "ArrowUp") n = Math.max(0, sel - (drill ? 1 : 3));
    else return;
    setSel(n);
  }, [sel, navLen, drill, drillSessions, projects, openId]);
  useEffect(() => { window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onKey]);

  const open = openId ? sessions.find((s) => s.id === openId) : null;
  const maxW = projects[0]?.weight || 1;
  const drillProj = drill ? projects.find((p) => p.name === drill) : null;

  return (
    <div className="flex h-screen w-screen overflow-hidden text-neutral-100" style={{ background: "radial-gradient(1100px 620px at 25% -12%, #1c1622, #0b0a0d 58%)" }}>
      <div className={`flex min-w-0 flex-col transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${openId ? "w-full md:w-[42%]" : "w-full"}`}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 pb-2 pt-5">
          {drill ? (
            <button onClick={() => { setDrill(null); setSel(0); }} className="flex items-center gap-2 rounded-lg px-1 py-0.5 text-sm transition-colors hover:bg-white/10">
              <span className="text-neutral-500">←</span><span className="text-lg">{thumb(drill)}</span><span className="font-semibold">{drill}</span>
            </button>
          ) : (
            <><span className="text-xl">🌸</span><h1 className="text-base font-semibold tracking-tight">Minami Bento</h1></>
          )}
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-400">{drill ? `${drillSessions.length} sessions` : `${projects.length} projects`}</span>
          {enriching && <span className="flex items-center gap-1 text-[11px] text-neutral-500"><span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "#e8859b" }} />labeling…</span>}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…"
            className="ml-auto w-40 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs outline-none transition-colors placeholder:text-neutral-600 focus:border-[--sakura]" style={{ ["--sakura" as string]: "#e8859b" }} />
          {!drill && (
            <div className="flex items-center gap-1 rounded-lg border border-white/10 p-0.5">
              {WINDOWS.map((w) => (
                <button key={w.label} onClick={() => setWinDays(w.days)} className={`rounded-md px-2 py-0.5 text-[11px] transition-all ${winDays === w.days ? "bg-[--sakura] text-white" : "text-neutral-400 hover:text-neutral-200"}`} style={{ ["--sakura" as string]: "#e8859b" }}>{w.label}</button>
              ))}
            </div>
          )}
          <div className="hidden gap-3 text-[11px] text-neutral-500 xl:flex"><span>↑↓←→ move</span><span>↵ {drill ? "open" : "enter"}</span><span>esc back</span></div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {!loaded ? <p className="mt-24 text-center text-sm text-neutral-500">Reading local sessions…</p>
          : projects.length === 0 ? (
            <div className="mx-auto mt-24 max-w-md text-center text-sm text-neutral-500">No local Claude Code sessions in this window. Bento mirrors <code className="text-xs">~/.claude/projects</code> — run it locally.</div>
          ) : (
            <AnimatePresence mode="wait">
              {!drill ? (
                <motion.div key="projects" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }}
                  className="grid auto-rows-[8.5rem] grid-cols-2 gap-3 [grid-auto-flow:dense] sm:grid-cols-3 lg:grid-cols-4">
                  {projects.map((p, i) => {
                    const r = p.weight / maxW;
                    const big = r >= 0.6, wide = !big && r >= 0.28;
                    const span = big ? "col-span-2 row-span-2" : wide ? "col-span-2" : "";
                    const pc = accent(p.name);
                    return (
                      <motion.button layout key={p.name} data-i={i} onMouseEnter={() => setSel(i)} onClick={() => { setDrill(p.name); setSel(0); }}
                        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
                        whileHover={{ y: -4 }} transition={{ type: "spring", stiffness: 320, damping: 30 }}
                        style={{ background: `radial-gradient(120% 120% at 100% 0%, ${pc}22, rgba(255,255,255,0.03) 55%)`, ["--sakura" as string]: "#e8859b" }}
                        className={`group relative flex flex-col overflow-hidden rounded-[1.4rem] border p-4 text-left backdrop-blur ${span} ${
                          i === sel ? "border-[--sakura]/70 ring-1 ring-[--sakura] shadow-[0_22px_50px_-22px_rgba(232,133,155,0.6)]" : "border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_34px_-18px_rgba(0,0,0,0.8)] hover:border-white/25"
                        }`}>
                        {p.active && <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full blur-2xl" style={{ background: pc + "44" }} />}
                        <div className="relative flex items-start justify-between">
                          <span className={big ? "text-3xl" : "text-xl"}>{thumb(p.name)}</span>
                          {p.active && <span className="flex items-center gap-1 text-[10px] text-green-400"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" />live</span>}
                        </div>
                        <p className={`relative mt-1.5 font-semibold tracking-tight ${big ? "text-xl" : "text-sm"}`}>{p.name}</p>
                        {big && <p className="relative mt-0.5 line-clamp-1 text-xs text-neutral-400">↳ {p.latest}</p>}
                        <div className="relative mt-auto flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                          <span className={`font-semibold tabular-nums ${big ? "text-2xl" : "text-base"}`}>{short(p.reqs)}<span className="ml-1 text-[10px] font-normal text-neutral-500">req</span></span>
                          <span className="text-[11px] tabular-nums text-neutral-500">{short(p.tokens)} tok</span>
                          <span className="text-[11px] text-neutral-600">{p.sessions.length} sess · {p.goals.length} goals</span>
                        </div>
                      </motion.button>
                    );
                  })}
                </motion.div>
              ) : (
                <motion.div key="sessions" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }} className="flex flex-col gap-4">
                  {groupByGoal(drillSessions).map((grp) => (
                    <div key={grp.goal}>
                      <div className="mb-1.5 flex items-center gap-2 text-[11px] font-medium text-neutral-400"><span className="opacity-50">↳</span>{grp.goal}<span className="text-neutral-600">· {grp.items.length}</span></div>
                      <div className={`grid gap-2.5 ${openId ? "grid-cols-1" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"}`}>
                        {grp.items.map((s) => {
                          const gi = drillSessions.indexOf(s);
                          const tint = TIER_TINT[s.tier] || "#b98cff";
                          return (
                            <motion.button layout key={s.id} data-i={gi} onMouseEnter={() => setSel(gi)} onClick={() => setOpenId(s.id)}
                              whileHover={{ y: -3 }} transition={{ type: "spring", stiffness: 320, damping: 30 }}
                              style={{ background: "linear-gradient(150deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))", ["--sakura" as string]: "#e8859b" }}
                              className={`group relative flex flex-col gap-1 overflow-hidden rounded-xl border p-3 text-left backdrop-blur ${
                                gi === sel ? "border-[--sakura]/60 ring-1 ring-[--sakura]" : "border-white/10 hover:border-white/20"
                              }`}>
                              <div className="flex items-center justify-between text-[10px] text-neutral-500">
                                <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: tint }} />{s.tier}</span>
                                <span className="flex items-center gap-1">{s.active && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" />}{ago(s.lastActivity)}</span>
                              </div>
                              <p className="line-clamp-2 text-[13px] font-semibold leading-snug [overflow-wrap:anywhere]">{titleOf(s)}</p>
                              <span className="text-[10px] text-neutral-500">{s.messages} req · {short(s.tokensIn + s.tokensOut)} tok</span>
                            </motion.button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </div>

      <div className={`min-h-0 border-l border-white/10 bg-neutral-900/60 backdrop-blur transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${openId ? "w-full md:w-[58%]" : "w-0 overflow-hidden"}`}>
        {open && <PeekPanel meta={open} detail={detail} onClose={() => setOpenId(null)} />}
      </div>
    </div>
  );
}

function groupByGoal(items: SessionMeta[]) {
  const m = new Map<string, SessionMeta[]>();
  for (const s of items) { const k = goalOf(s); const a = m.get(k); if (a) a.push(s); else m.set(k, [s]); }
  return [...m.entries()].map(([goal, items]) => ({ goal, items })).sort((a, b) => Math.max(...b.items.map((i) => i.lastActivity)) - Math.max(...a.items.map((i) => i.lastActivity)));
}

/* ---------- minimal markdown ---------- */
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0, k = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) nodes.push(<code key={k++} className="rounded bg-white/10 px-1 py-[1px] font-mono text-[0.85em] text-[#e8b3c0]">{tok.slice(1, -1)}</code>);
    else nodes.push(<strong key={k++} className="font-semibold text-white">{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
function Markdown({ text }: { text: string }) {
  const blocks = text.split(/(```[\s\S]*?```)/g).filter(Boolean);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        if (b.startsWith("```")) {
          const inner = b.replace(/^```[\w-]*\n?/, "").replace(/\n?```$/, "");
          return <pre key={i} className="overflow-x-auto rounded-lg border border-white/10 bg-black/50 p-3 font-mono text-[12px] leading-relaxed text-neutral-200"><code>{inner}</code></pre>;
        }
        const out: ReactNode[] = [];
        let bullets: ReactNode[] = [];
        const flush = () => { if (bullets.length) { out.push(<ul key={`u${out.length}`} className="ml-4 list-disc space-y-0.5 marker:text-neutral-600">{bullets}</ul>); bullets = []; } };
        for (const line of b.split("\n")) {
          const t = line.replace(/\s+$/, "");
          if (/^\s*[-*•]\s+/.test(t)) { bullets.push(<li key={`b${bullets.length}`}>{inline(t.replace(/^\s*[-*•]\s+/, ""))}</li>); continue; }
          flush();
          if (!t.trim()) continue;
          const h = t.match(/^(#{1,3})\s+(.*)/);
          if (h) { out.push(<p key={`h${out.length}`} className="pt-0.5 text-[13px] font-semibold text-white">{inline(h[2])}</p>); continue; }
          out.push(<p key={`p${out.length}`} className="leading-relaxed">{inline(t)}</p>);
        }
        flush();
        return <div key={i} className="space-y-1.5">{out}</div>;
      })}
    </div>
  );
}

function PeekPanel({ meta, detail, onClose }: { meta: SessionMeta; detail: { meta: SessionMeta | null; turns: Turn[] } | null; onClose: () => void }) {
  const turns = detail?.turns || [];
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [turns.length]);
  return (
    <div className="flex h-full flex-col" style={{ ["--sakura" as string]: "#e8859b" } as React.CSSProperties}>
      <header className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg text-base" style={{ background: accent(meta.project) + "26" }}>{thumb(meta.project)}</span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{meta.task || meta.title}</p>
            <p className="truncate text-[11px] text-neutral-500">{meta.project}<span className="mx-1 opacity-40">›</span>{goalOf(meta)}{meta.gitBranch ? ` · ${meta.gitBranch}` : ""}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-neutral-500">
          <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: TIER_TINT[meta.tier] }} />{meta.tier}</span>
          <button onClick={onClose} className="rounded-md px-2 py-1 transition-colors hover:bg-white/10">esc ✕</button>
        </div>
      </header>
      <div ref={scrollRef} className="mx-auto min-h-0 w-full max-w-3xl flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {turns.length === 0 ? <p className="text-sm text-neutral-500">Loading transcript…</p> : turns.map((t, i) => (
          <div key={i} className={`flex flex-col ${t.role === "user" ? "items-end" : "items-start"}`}>
            <span className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wider text-neutral-600">{t.role === "user" ? "You" : "Claude"}</span>
            <div className={`rounded-2xl px-4 py-2.5 text-[13px] [overflow-wrap:anywhere] ${t.role === "user" ? "max-w-[85%] bg-[--sakura]/[0.14] text-neutral-100" : "w-full border border-white/[0.08] bg-white/[0.03] text-neutral-200"}`}>
              {t.text && <Markdown text={t.text} />}
              {t.tools.map((tool, j) => (
                <details key={j} className="mt-2 rounded-lg border border-white/[0.06] bg-black/40 px-2.5 py-1.5 text-xs">
                  <summary className="cursor-pointer select-none text-neutral-400"><span className="mr-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-neutral-300">tool</span>{tool.name}</summary>
                  <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-neutral-400">{JSON.stringify(tool.input, null, 2)}</pre>
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
