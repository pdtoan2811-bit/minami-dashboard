"use client";

import { Nav } from "@/components/Nav";
import { useSetting } from "@/lib/use-settings";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type SessionMeta = {
  id: string; project: string; cwd: string; gitBranch: string; title: string; lastPrompt: string;
  model: string; tier: string; tokensIn: number; tokensOut: number; cost: number;
  messages: number; tools: number; toolNames: string[]; lastActivity: number; active: boolean;
  task?: string; goal?: string; lastRole?: string; tail?: string; review?: boolean;
};
type Turn = { role: "user" | "assistant"; text: string; tools: { name: string; input: unknown }[]; ts: number; model?: string };

const TIER_TINT: Record<string, string> = { Haiku: "#6cc4a1", Sonnet: "#e8859b", Opus: "#b98cff", Fable: "#f0a868" };
const PALETTE = ["#e8859b", "#b98cff", "#6cc4a1", "#6c9cf5", "#f0a868", "#e86c8b"];
function hashN(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
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

// Project → 3D icon (assets from 3dicons.co, in /public/icons). Fallback: cube.
const PROJECT_ICON: Record<string, string> = {
  secondBrain: "bulb", minami: "magic-trick", ownegoCentral: "rocket", ownego: "rocket",
  dataAnalyticsOwnego: "chart", qikifyDataKnowledge: "notebook", app: "mobile",
  cvtools: "file-text", CV: "file-text", guides: "explorer", userGuideTools: "explorer",
  "design-hub": "color-palette", toolkit: "tools", "claude-status-bar-acos": "setting",
  qdn: "link", qdnNewWebsite: "link", ecomIntel: "money-bag", "QSortby-website": "puzzle",
};
const iconOf = (p: string) => PROJECT_ICON[p] || "cube";

// A 3D icon that, on hover of its parent `.group`, cross-fades from the front render to the
// angled ("dynamic") render + a slight CSS 3D turn — a lightweight faux-3D rotation (the assets
// are static renders, not GLB models). Active projects float gently.
// 3D icon (transparent 3dicons render). Default premium motion: gently TILT, then ROTATE, on loop.
// Hover faces it front + scales up. Active projects run the cycle a touch faster.
function ProjectIcon({ name, big, active }: { name: string; big?: boolean; active?: boolean }) {
  const icon = iconOf(name);
  const s = big ? "h-14 w-14" : "h-9 w-9";
  return (
    <div className={`relative shrink-0 [perspective:600px] transition-transform duration-300 group-hover:scale-[1.16] ${s}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/icons/${icon}.webp`} alt="" draggable={false}
        className="h-full w-full object-contain [transform-style:preserve-3d] drop-shadow-[0_10px_16px_rgba(0,0,0,0.5)]"
        style={{ animation: `spin3d ${active ? 4.5 : 6.8}s ease-in-out infinite` }}
      />
    </div>
  );
}

type Project = { name: string; sessions: SessionMeta[]; reqs: number; tokens: number; last: number; active: boolean; review: boolean; goals: string[]; latest: string; weight: number };
const WINDOWS: { label: string; days: number | null }[] = [
  { label: "24h", days: 1 }, { label: "3d", days: 3 }, { label: "7d", days: 7 }, { label: "30d", days: 30 }, { label: "All", days: null },
];
const MAX_PANES = 2;

export default function BentoHome() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [q, setQ] = useState("");
  const [defaultWindow] = useSetting<number | null>("defaultWindow", 3);
  const [winDays, setWinDays] = useState<number | null>(3);
  useEffect(() => { setWinDays(defaultWindow); }, [defaultWindow]); // apply the user's default window
  const [sortBy, setSortBy] = useState<"recent" | "busy" | "name">("recent");
  const [sel, setSel] = useState(0);
  const [project, setProject] = useState<string | null>(null);
  const [panes, setPanes] = useState<string[]>([]);
  const [showTools] = useSetting<boolean>("showToolLogs", false);
  const [panelW, setPanelW] = useSetting<number>("panelWidth", 60); // chat panel width %, persisted
  const [isDragging, setDragging] = useState(false);
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

  const pool = useMemo(() => sessions.filter((s) => {
    if (isTrivial(s)) return false;
    if (winDays != null && Date.now() - s.lastActivity > winDays * 86400000) return false;
    return true;
  }), [sessions, winDays]);

  const projects = useMemo<Project[]>(() => {
    const m = new Map<string, SessionMeta[]>();
    for (const s of pool) { const a = m.get(s.project); if (a) a.push(s); else m.set(s.project, [s]); }
    const list = [...m.entries()].map(([name, ss]) => {
      const reqs = ss.reduce((a, x) => a + x.messages, 0);
      const tokens = ss.reduce((a, x) => a + x.tokensIn + x.tokensOut, 0);
      const latest = [...ss].sort((a, b) => b.lastActivity - a.lastActivity)[0];
      return { name, sessions: ss, reqs, tokens, last: Math.max(...ss.map((x) => x.lastActivity)), active: ss.some((x) => x.active), review: ss.some((x) => x.review), goals: [...new Set(ss.map(goalOf))], latest: titleOf(latest), weight: reqs + tokens / 5000 };
    });
    const sorters = {
      recent: (a: Project, b: Project) => b.last - a.last,
      busy: (a: Project, b: Project) => b.weight - a.weight,
      name: (a: Project, b: Project) => a.name.localeCompare(b.name),
    };
    list.sort(sorters[sortBy]);
    const ql = q.trim().toLowerCase();
    return ql ? list.filter((p) => `${p.name} ${p.goals.join(" ")} ${p.latest}`.toLowerCase().includes(ql)) : list;
  }, [pool, q, sortBy]);

  const openProject = useCallback((p: Project) => {
    const top = [...p.sessions].sort((a, b) => b.lastActivity - a.lastActivity)[0];
    setProject(p.name); setPanes(top ? [top.id] : []);
  }, []);
  const closePanel = () => { setProject(null); setPanes([]); };

  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") { closePanel(); return; }
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || project) return;
    if (!projects.length) return;
    if (e.key === "Enter") { openProject(projects[sel]); return; }
    let n = sel;
    if (e.key === "ArrowRight" || e.key === "Tab") { e.preventDefault(); n = (sel + 1) % projects.length; }
    else if (e.key === "ArrowLeft") n = (sel - 1 + projects.length) % projects.length;
    else if (e.key === "ArrowDown") n = Math.min(projects.length - 1, sel + (project ? 2 : 3));
    else if (e.key === "ArrowUp") n = Math.max(0, sel - (project ? 2 : 3));
    else return;
    setSel(n);
  }, [sel, projects, project, openProject]);
  useEffect(() => { window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onKey]);
  // draggable panel divider → persists width across sessions
  useEffect(() => {
    if (!isDragging) return;
    const move = (e: MouseEvent) => setPanelW(Math.min(80, Math.max(30, Math.round((1 - e.clientX / window.innerWidth) * 100))));
    const up = () => setDragging(false);
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [isDragging, setPanelW]);

  const proj = project ? projects.find((p) => p.name === project) : null;
  const maxW = Math.max(1, ...projects.map((p) => p.weight)); // size ratio is vs the busiest project

  return (
    <div className={`flex h-screen w-screen overflow-hidden text-neutral-100 ${isDragging ? "select-none" : ""}`} style={{ background: "radial-gradient(1100px 620px at 25% -12%, #1c1622, #0b0a0d 58%)", ["--lw" as string]: proj ? `${100 - panelW}%` : "100%", ["--rw" as string]: proj ? `${panelW}%` : "0%" }}>
      {/* Left: bento */}
      <div className={`flex min-w-0 flex-col w-full md:w-[var(--lw)] ${proj ? "hidden md:flex" : ""} ${isDragging ? "" : "transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"}`}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 pb-2 pt-5">
          <span className="text-xl">🌸</span><h1 className="text-base font-semibold tracking-tight">Minami Bento</h1>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-400">{projects.length}</span>
          {enriching && <span className="flex items-center gap-1 text-[11px] text-neutral-500"><span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "#e8859b" }} />labeling…</span>}
          <div className="ml-auto flex items-center gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-32 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs outline-none transition-colors placeholder:text-neutral-600 focus:border-[--sakura]" style={{ ["--sakura" as string]: "#e8859b" }} />
            <div className="hidden items-center gap-1 rounded-lg border border-white/10 p-0.5 md:flex">{WINDOWS.map((w) => <button key={w.label} onClick={() => setWinDays(w.days)} className={`rounded-md px-2 py-0.5 text-[11px] transition-all ${winDays === w.days ? "bg-[--sakura] text-white" : "text-neutral-400 hover:text-neutral-200"}`} style={{ ["--sakura" as string]: "#e8859b" }}>{w.label}</button>)}</div>
            {!proj && <div className="hidden items-center gap-1 rounded-lg border border-white/10 p-0.5 md:flex" title="Sort projects">
              <span className="px-1 text-[10px] text-neutral-600">↕</span>
              {([["recent", "Recent"], ["busy", "Busy"], ["name", "A–Z"]] as const).map(([k, label]) => (
                <button key={k} onClick={() => setSortBy(k)} className={`rounded-md px-2 py-0.5 text-[11px] transition-all ${sortBy === k ? "bg-[--sakura] text-white" : "text-neutral-400 hover:text-neutral-200"}`} style={{ ["--sakura" as string]: "#e8859b" }}>{label}</button>
              ))}
            </div>}
            <Nav />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2.5">
          {!loaded ? <p className="mt-24 text-center text-sm text-neutral-500">Reading local sessions…</p>
          : projects.length === 0 ? <div className="mx-auto mt-24 max-w-md text-center text-sm text-neutral-500">No local Claude Code sessions in this window. Bento mirrors <code className="text-xs">~/.claude/projects</code> — run it locally.</div>
          : (
            <div className={`grid auto-rows-[8.5rem] gap-3 [grid-auto-flow:dense] ${proj ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"}`}>
              {projects.map((p, i) => {
                const r = p.weight / maxW;
                const big = r >= 0.6, wide = !big && r >= 0.28;
                const span = big ? "col-span-2 row-span-2" : wide ? "col-span-2" : "";
                const pc = accent(p.name);
                const activeSel = i === sel && !proj;
                const age = Date.now() - p.last;
                const status = p.active ? { label: "live", tint: "#4ade80", pulse: true }
                  : p.review ? { label: "review", tint: "#f0a868", pulse: true }
                  : age < 12 * 3600e3 ? { label: "recent", tint: "#e8859b", pulse: false }
                  : age < 3 * 86400e3 ? { label: "active", tint: "#6c9cf5", pulse: false } : null;
                const bright = activeSel || project === p.name || p.active || (p.review && age < 7 * 86400e3);
                const dim = bright ? 1 : age < 86400e3 ? 0.9 : age < 3 * 86400e3 ? 0.72 : age < 7 * 86400e3 ? 0.56 : 0.42;
                return (
                  <motion.button layout key={p.name} data-i={i} onMouseEnter={() => setSel(i)} onClick={() => openProject(p)}
                    initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: dim, scale: 1 }} whileHover={{ y: -4, opacity: 1 }} transition={{ type: "spring", stiffness: 320, damping: 30 }}
                    style={{ background: `radial-gradient(120% 120% at 100% 0%, ${pc}22, rgba(255,255,255,0.03) 55%)`, ["--sakura" as string]: "#e8859b" }}
                    className={`group relative flex flex-col overflow-hidden rounded-[1.4rem] border p-4 text-left backdrop-blur ${span} ${
                      project === p.name ? "border-[--sakura] ring-1 ring-[--sakura]" : activeSel ? "border-[--sakura]/70 ring-1 ring-[--sakura] shadow-[0_22px_50px_-22px_rgba(232,133,155,0.6)]" : "border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_34px_-18px_rgba(0,0,0,0.8)] hover:border-white/25"
                    }`}>
                    {p.active && <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full blur-2xl" style={{ background: pc + "44" }} />}
                    <div className="relative flex items-start justify-between">
                      <ProjectIcon name={p.name} big={big} active={p.active} />
                      {status && <span className="flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium" style={{ borderColor: status.tint + "55", color: status.tint, background: status.tint + "1e" }}>{status.pulse && <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: status.tint }} />}{status.label}</span>}
                    </div>
                    <p className={`relative mt-1.5 font-semibold tracking-tight ${big ? "text-xl" : "text-sm"}`}>{p.name}</p>
                    {big && <p className="relative mt-0.5 line-clamp-1 text-xs text-neutral-400">↳ {p.latest}</p>}
                    <div className="relative mt-auto flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <span className={`font-semibold tabular-nums ${big ? "text-2xl" : "text-base"}`}>{short(p.reqs)}<span className="ml-1 text-[10px] font-normal text-neutral-500">req</span></span>
                      <span className="text-[11px] tabular-nums text-neutral-500">{short(p.tokens)} tok</span>
                      <span className="text-[11px] text-neutral-600">{p.sessions.length} chats</span>
                    </div>
                  </motion.button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* draggable divider (persists panel width) */}
      {proj && <div onMouseDown={() => setDragging(true)} title="Drag to resize" className="hidden w-1.5 shrink-0 cursor-col-resize bg-white/[0.06] transition-colors hover:bg-[--sakura]/60 md:block" style={{ ["--sakura" as string]: "#e8859b" }} />}

      {/* Right: chat SIDE PANEL */}
      <div className={`min-h-0 bg-neutral-900/50 backdrop-blur w-full md:w-[var(--rw)] ${proj ? "flex flex-col" : "hidden"} ${isDragging ? "" : "transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"}`}>
        {proj && (
          <>
            <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2.5">
              <button onClick={closePanel} className="group flex items-center gap-2 rounded-lg px-1 py-0.5 text-sm transition-colors hover:bg-white/10">
                <ProjectIcon name={proj.name} /><span className="font-semibold">{proj.name}</span>
              </button>
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-400">{proj.sessions.length} chats · {short(proj.reqs)} req</span>
              <button onClick={() => setPanes((p) => (p.length < MAX_PANES ? [...p, ""] : p))} disabled={panes.length >= MAX_PANES}
                className="ml-auto rounded-lg border border-[--sakura]/40 px-2.5 py-1 text-[11px] text-[--sakura] transition-colors hover:bg-[--sakura]/10 disabled:opacity-40" style={{ ["--sakura" as string]: "#e8859b" }}>＋ new chat</button>
              <button onClick={closePanel} className="rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-white/10">esc ✕</button>
            </div>
            <div className="flex min-h-0 flex-1">
              {panes.map((id, idx) => (
                <ChatColumn key={idx} sessionId={id} sessions={proj.sessions} idx={idx} count={panes.length} showTools={showTools}
                  onPick={(nid) => setPanes((p) => p.map((x, j) => (j === idx ? nid : x)))}
                  onClose={() => setPanes((p) => p.filter((_, j) => j !== idx))} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChatColumn({ sessionId, sessions, idx, count, showTools, onPick, onClose }: {
  sessionId: string; sessions: SessionMeta[]; idx: number; count: number; showTools: boolean; onPick: (id: string) => void; onClose: () => void;
}) {
  const [detail, setDetail] = useState<{ meta: SessionMeta | null; turns: Turn[] } | null>(null);
  const [menu, setMenu] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNew = !sessionId;
  useEffect(() => {
    if (isNew) { setDetail(null); return; }
    let a = true;
    const load = () => fetch(`/api/bento/session/${sessionId}`).then((r) => r.json()).then((d) => { if (a) setDetail(d); }).catch(() => {});
    load(); const iv = setInterval(load, 2500); return () => { a = false; clearInterval(iv); };
  }, [sessionId, isNew]);
  const turns = detail?.turns || [];
  const visible = showTools ? turns : turns.filter((t) => t.text.trim());
  // Jump straight to the last message (no scroll animation) when the transcript loads/updates.
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [visible.length]);
  const cur = sessions.find((s) => s.id === sessionId);
  const proj = sessions[0]?.project || "";
  const chats = [...sessions].sort((a, b) => b.lastActivity - a.lastActivity);

  return (
    <div className={`flex min-w-0 flex-1 flex-col ${idx > 0 ? "border-l border-white/10" : ""}`} style={{ ["--sakura" as string]: "#e8859b" } as React.CSSProperties}>
      <div className="relative flex items-center gap-2 border-b border-white/[0.07] px-4 py-2">
        <ProjectIcon name={proj} />
        <button onClick={() => setMenu((v) => !v)} className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-white/10">
          <span className="min-w-0"><span className="block truncate text-[13px] font-semibold">{isNew ? "New chat" : cur ? titleOf(cur) : "…"}</span><span className="block truncate text-[10px] text-neutral-500">{isNew ? proj : cur ? goalOf(cur) : ""}</span></span>
          <span className="text-neutral-500">⌄</span>
        </button>
        {count > 1 && <button onClick={onClose} className="ml-auto rounded-md px-1.5 py-0.5 text-xs text-neutral-500 transition-colors hover:bg-white/10">✕</button>}
        {menu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
            <div className="absolute left-8 top-full z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-xl border border-white/10 bg-neutral-900 p-1 shadow-2xl">
              {chats.map((s) => (
                <button key={s.id} onClick={() => { onPick(s.id); setMenu(false); }} className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/10 ${s.id === sessionId ? "bg-white/5" : ""}`}>
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.active ? "#4ade80" : TIER_TINT[s.tier] }} />
                  <span className="min-w-0 flex-1"><span className="block truncate text-xs">{titleOf(s)}</span><span className="block truncate text-[10px] text-neutral-500">{goalOf(s)} · {ago(s.lastActivity)}</span></span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        {isNew ? (
          <div className="mx-auto mt-16 max-w-sm text-center text-neutral-500">
            <p className="text-2xl">✳</p>
            <p className="mt-2 text-sm font-medium text-neutral-300">New chat in {proj}</p>
            <p className="mt-1 text-xs">Start a fresh conversation in this project — sending goes live in Phase 2 (Agent SDK).</p>
          </div>
        ) : visible.length === 0 ? (
          turns.length === 0 ? <p className="text-sm text-neutral-500">Loading transcript…</p> : null
        ) : visible.map((t, i) => (
          <div key={i} className={`flex flex-col ${t.role === "user" ? "items-end" : "items-start"}`}>
            <span className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wider text-neutral-600">{t.role === "user" ? "You" : "Claude"}</span>
            <div className={t.role === "user"
              ? "max-w-[85%] rounded-2xl border border-white/15 px-4 py-3 text-[14px] leading-relaxed text-neutral-100 [overflow-wrap:anywhere]"
              : "w-full text-[14px] leading-[1.72] text-neutral-100/90 [overflow-wrap:anywhere]"}>
              {t.text && <Markdown text={t.text} />}
              {showTools && t.tools.map((tool, j) => (
                <details key={j} className="mt-2 rounded-lg border border-white/[0.06] bg-black/40 px-2.5 py-1.5 text-xs">
                  <summary className="cursor-pointer select-none text-neutral-400"><span className="mr-1.5 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-neutral-300">tool</span>{tool.name}</summary>
                  <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-neutral-400">{JSON.stringify(tool.input, null, 2)}</pre>
                </details>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="border-t border-white/10 px-4 py-3">
        <div className="mb-2 flex items-center gap-1.5">
          {["default", "acceptEdits", "plan"].map((m) => <span key={m} className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-neutral-500">{m}</span>)}
          <span className="ml-auto text-[10px] text-neutral-600">read-only · live drive = Phase 2</span>
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
          const lang = (b.match(/^```([\w-]+)/) || [])[1];
          const inner = b.replace(/^```[\w-]*\n?/, "").replace(/\n?```$/, "");
          let html = "";
          try { html = lang && hljs.getLanguage(lang) ? hljs.highlight(inner, { language: lang }).value : hljs.highlightAuto(inner).value; }
          catch { html = inner.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string)); }
          return (
            <div key={i} className="my-1 overflow-hidden rounded-xl border border-white/10 bg-[#0d1117]">
              {lang && <div className="border-b border-white/[0.06] px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-neutral-500">{lang}</div>}
              <pre className="hljs overflow-x-auto bg-transparent p-3 text-[12.5px] leading-relaxed"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
            </div>
          );
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
