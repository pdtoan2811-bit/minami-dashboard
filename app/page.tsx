"use client";

import { Nav } from "@/components/Nav";
import { useSetting } from "@/lib/use-settings";
import { useAgent, type AgentMode } from "@/lib/use-agent";
import Markdown from "@/components/Markdown";
import FolderPicker from "@/components/FolderPicker";
import AttachBar from "@/components/AttachBar";
import BrandIcon, { type Icon } from "@/components/BrandIcon";
import AskCard from "@/components/AskCard";
import { loadTechIcons } from "@/lib/tech-icons";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type SessionMeta = {
  id: string; project: string; cwd: string; gitBranch: string; title: string; lastPrompt: string;
  model: string; tier: string; tokensIn: number; tokensOut: number; cost: number;
  messages: number; tools: number; toolNames: string[]; lastActivity: number; active: boolean;
  task?: string; goal?: string; lastRole?: string; tail?: string; review?: boolean;
};
type Turn = { role: "user" | "assistant"; text: string; tools: { name: string; input: unknown }[]; ts: number; model?: string };
type RenderTurn = { role: "user" | "assistant"; text: string; tools: { name: string; input: unknown }[]; streaming?: boolean };

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

// Project → 3D icon (assets from 3dicons.co, in /public/icons). Icons are inferred from keywords in
// the project (working-directory) name, so this works for anyone's projects with zero config. To pin
// a specific project to a specific icon, add an exact-name entry to ICON_OVERRIDES.
const ICON_OVERRIDES: Record<string, string> = {
  // "my-project": "rocket",
};
const ICON_KEYWORDS: [RegExp, string][] = [
  [/web|site|landing|www|link|url/, "link"],
  [/app|mobile|ios|android|flutter/, "mobile"],
  [/data|analytic|metric|chart|stat|report/, "chart"],
  [/ai|\bml\b|model|intel|brain|agent|llm/, "bulb"],
  [/design|\bui\b|\bux\b|figma|brand|theme/, "color-palette"],
  [/doc|guide|note|wiki|content|blog|readme/, "notebook"],
  [/tool|kit|util|\bcli\b|script|helper/, "tools"],
  [/bot|slack|chat|message|mail/, "chat"],
  [/money|pay|finance|invoice|commerce|shop|store|ecom|cart/, "money-bag"],
  [/game|play|puzzle|fun/, "puzzle"],
  [/secur|auth|lock|secret|vault|key/, "lock"],
  [/config|setting|infra|ops|deploy|server|api/, "setting"],
  [/rocket|launch|startup|mvp|central|core/, "rocket"],
];
function iconOf(project: string): string {
  if (ICON_OVERRIDES[project]) return ICON_OVERRIDES[project];
  const key = project.toLowerCase();
  for (const [re, icon] of ICON_KEYWORDS) if (re.test(key)) return icon;
  return "cube";
}

// A transparent 3D icon (static 3dicons render) with a premium default motion: it gently tilts then
// rotates on a seamless loop (CSS `spin3d` keyframes in globals.css). Hovering the parent `.group`
// faces it front and scales it up; active projects run the loop a touch faster.
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

type Project = { name: string; sessions: SessionMeta[]; cwd: string; reqs: number; tokens: number; last: number; active: boolean; review: boolean; goals: string[]; latest: string; weight: number };
const WINDOWS: { label: string; days: number | null }[] = [
  { label: "24h", days: 1 }, { label: "3d", days: 3 }, { label: "7d", days: 7 }, { label: "30d", days: 30 }, { label: "All", days: null },
];
const MAX_PANES = 4;

const MODE_HINT: Record<AgentMode, string> = {
  default: "Ask before running tools that need approval",
  acceptEdits: "Auto-approve file edits; still ask for other tools",
  plan: "Plan only — propose changes without applying them",
  bypassPermissions: "⚠ Auto-approve EVERY tool with no prompt — including destructive ones",
};
// Inline "thinking" indicator: three bouncing dots + a live hint of what Claude is doing.
function ThinkingLine({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2 text-xs text-neutral-400">
      <span className="flex gap-0.5">
        {[0, 1, 2].map((i) => <span key={i} className="think-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--sakura)", animationDelay: `${i * 0.15}s` }} />)}
      </span>
      <span className="italic">{label}</span>
    </span>
  );
}

// A readable one-line-ish preview of what a tool wants to do, for the permission prompt.
function permPreview(tool: string, input: unknown): string {
  const o = (input || {}) as Record<string, unknown>;
  if (tool === "Bash" && o.command) return String(o.command);
  if (o.file_path) {
    const edit = o.old_string ? `\n- ${String(o.old_string).slice(0, 160)}\n+ ${String(o.new_string || "").slice(0, 160)}` : "";
    return String(o.file_path) + edit;
  }
  try { return JSON.stringify(input, null, 2).slice(0, 600); } catch { return String(input); }
}

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
  const [addMenu, setAddMenu] = useState(false); // "add a chat to the mix" picker
  const [openPanesMap, setOpenPanesMap] = useSetting<Record<string, string[]>>("openPanes", {}); // remembered per topic
  const [newTopic, setNewTopic] = useState<Project | null>(null); // ad-hoc topic opened via the folder picker
  const [picker, setPicker] = useState(false); // folder picker modal open
  const [techIcons, setTechIcons] = useState<Record<string, Icon>>({}); // brand icon SVGs
  const [attachMap, setAttachMap] = useState<Record<string, { tech: string[] }>>({}); // per-project tech
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
      return { name, sessions: ss, cwd: ss[0]?.cwd || "", reqs, tokens, last: Math.max(...ss.map((x) => x.lastActivity)), active: ss.some((x) => x.active), review: ss.some((x) => x.review), goals: [...new Set(ss.map(goalOf))], latest: titleOf(latest), weight: reqs + tokens / 5000 };
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
    // Default: open the recent combination (up to 4 sessions active within the date filter). If the
    // user has customized which chats are open for this topic before, restore that instead.
    const recent = [...p.sessions].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, MAX_PANES).map((s) => s.id);
    const remembered = (openPanesMap[p.name] || []).filter((id) => id === "" || p.sessions.some((s) => s.id === id));
    const initial = remembered.length ? remembered.slice(0, MAX_PANES) : (recent.length ? recent : [""]);
    setNewTopic(null); setProject(p.name); setPanes(initial); setAddMenu(false);
  }, [openPanesMap]);
  const startTopic = (cwd: string, label?: string) => {
    const name = label || cwd.split("/").filter(Boolean).pop() || cwd;
    setPicker(false); setProject(null); setAddMenu(false);
    setNewTopic({ name, sessions: [], cwd, reqs: 0, tokens: 0, last: Date.now(), active: false, review: false, goals: [], latest: "", weight: 0 });
    setPanes([""]); // one fresh blank chat in the chosen folder (or home, for a folderless CLI)
  };
  const closePanel = () => { setProject(null); setNewTopic(null); setPanes([]); setAddMenu(false); };
  // Remember the open set per topic so re-opening restores the same window layout.
  useEffect(() => { if (project) setOpenPanesMap({ ...openPanesMap, [project]: panes }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [panes, project]);

  // Brand/tech icons for the tiles: load the SVG set once, and batch-fetch each project's tech.
  useEffect(() => { loadTechIcons().then(setTechIcons); }, []);
  const projSig = projects.map((p) => `${p.name}:${p.cwd}`).join("|");
  useEffect(() => {
    if (!projects.length) return;
    let a = true;
    fetch("/api/bento/attach-batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: projects.map((p) => ({ name: p.name, cwd: p.cwd })) }) })
      .then((r) => r.json()).then((d) => { if (a) setAttachMap(d.attach || {}); }).catch(() => {});
    return () => { a = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projSig]);

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

  const proj = project ? projects.find((p) => p.name === project) : newTopic;
  const maxW = Math.max(1, ...projects.map((p) => p.weight)); // size ratio is vs the busiest project

  return (
    <div className={`bg-bento flex h-screen w-screen overflow-hidden text-neutral-100 ${isDragging ? "select-none" : ""}`} style={{ ["--lw" as string]: proj ? `${100 - panelW}%` : "100%", ["--rw" as string]: proj ? `${panelW}%` : "0%" }}>
      {/* Left: bento */}
      <div className={`flex min-w-0 flex-col w-full md:w-[var(--lw)] ${proj ? "hidden md:flex" : ""} ${isDragging ? "" : "transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"}`}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-6 pb-2 pt-5">
          <span className="text-xl">🌸</span><h1 className="text-base font-semibold tracking-tight">Minami Bento</h1>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-400">{projects.length}</span>
          {enriching && <span className="flex items-center gap-1 text-[11px] text-neutral-500"><span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "#e8859b" }} />labeling…</span>}
          <div className="ml-auto flex items-center gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-32 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs outline-none transition-colors placeholder:text-neutral-600 focus:border-[var(--sakura)]" />
            <div className="hidden items-center gap-1 rounded-lg border border-white/10 p-0.5 md:flex">{WINDOWS.map((w) => <button key={w.label} onClick={() => setWinDays(w.days)} className={`rounded-md px-2 py-0.5 text-[11px] transition-all ${winDays === w.days ? "bg-[var(--sakura)] text-white" : "text-neutral-400 hover:text-neutral-200"}`}>{w.label}</button>)}</div>
            {!proj && <div className="hidden items-center gap-1 rounded-lg border border-white/10 p-0.5 md:flex" title="Sort projects">
              <span className="px-1 text-[10px] text-neutral-600">↕</span>
              {([["recent", "Recent"], ["busy", "Busy"], ["name", "A–Z"]] as const).map(([k, label]) => (
                <button key={k} onClick={() => setSortBy(k)} className={`rounded-md px-2 py-0.5 text-[11px] transition-all ${sortBy === k ? "bg-[var(--sakura)] text-white" : "text-neutral-400 hover:text-neutral-200"}`}>{label}</button>
              ))}
            </div>}
            <Nav />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-2.5">
          {!loaded ? <p className="mt-24 text-center text-sm text-neutral-500">Reading local sessions…</p>
          : projects.length === 0 ? (
            <div className="mx-auto mt-24 max-w-md text-center text-sm text-neutral-500">
              No local Claude Code sessions in this window. Bento mirrors <code className="text-xs">~/.claude/projects</code> — run it locally.
              <div className="mt-4"><button onClick={() => setPicker(true)} className="rounded-lg border border-[var(--sakura)]/40 px-3 py-1.5 text-xs font-medium text-[var(--sakura)] transition-colors hover:bg-[var(--sakura)]/10">＋ Start a new topic</button></div>
            </div>
          )
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
                    style={{ background: `radial-gradient(120% 120% at 100% 0%, ${pc}22, rgba(255,255,255,0.03) 55%)` }}
                    className={`group relative flex flex-col overflow-hidden rounded-[1.4rem] border p-4 text-left backdrop-blur ${span} ${
                      project === p.name ? "border-[var(--sakura)] ring-1 ring-[var(--sakura)]" : activeSel ? "border-[var(--sakura)]/70 ring-1 ring-[var(--sakura)] shadow-[0_22px_50px_-22px_rgba(232,133,155,0.6)]" : "border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_34px_-18px_rgba(0,0,0,0.8)] hover:border-white/25"
                    }`}>
                    {p.active && <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full blur-2xl" style={{ background: pc + "44" }} />}
                    <div className="relative flex items-start justify-between">
                      <ProjectIcon name={p.name} big={big} active={p.active} />
                      {status && <span className="flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium" style={{ borderColor: status.tint + "55", color: status.tint, background: status.tint + "1e" }}>{status.pulse && <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: status.tint }} />}{status.label}</span>}
                    </div>
                    <p className={`relative mt-1.5 font-semibold tracking-tight ${big ? "text-xl" : "text-sm"}`}>{p.name}</p>
                    {big && <p className="relative mt-0.5 line-clamp-1 text-xs text-neutral-400">↳ {p.latest}</p>}
                    {(() => { const techs = attachMap[p.name]?.tech || []; const n = big ? 6 : 3; return techs.length > 0 && (
                      <div className="relative mt-1.5 flex items-center gap-1.5">
                        {techs.slice(0, n).map((s) => <BrandIcon key={s} slug={s} icons={techIcons} size={big ? 28 : 22} />)}
                        {techs.length > n && <span className="text-[10px] text-neutral-500">+{techs.length - n}</span>}
                      </div>
                    ); })()}
                    <div className="relative mt-auto flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <span className={`font-semibold tabular-nums ${big ? "text-2xl" : "text-base"}`}>{short(p.reqs)}<span className="ml-1 text-[10px] font-normal text-neutral-500">req</span></span>
                      <span className="text-[11px] tabular-nums text-neutral-500">{short(p.tokens)} tok</span>
                      <span className="text-[11px] text-neutral-600">{p.sessions.length} chats</span>
                    </div>
                  </motion.button>
                );
              })}
              {/* Blank tile: start a brand-new topic/chat in any folder. */}
              <button onClick={() => setPicker(true)} title="Start a new topic in a folder"
                className="group flex flex-col items-center justify-center gap-1.5 rounded-[1.4rem] border border-dashed border-white/15 p-4 text-neutral-500 transition-colors hover:border-[var(--sakura)]/50 hover:text-[var(--sakura)]">
                <span className="text-2xl leading-none transition-transform group-hover:scale-110">＋</span>
                <span className="text-xs font-medium">New topic</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* draggable divider (persists panel width) */}
      {proj && <div onMouseDown={() => setDragging(true)} title="Drag to resize" className="hidden w-1.5 shrink-0 cursor-col-resize bg-white/[0.06] transition-colors hover:bg-[var(--sakura)]/60 md:block" />}

      {/* Right: chat SIDE PANEL */}
      <div className={`min-h-0 bg-neutral-900/50 backdrop-blur w-full md:w-[var(--rw)] ${proj ? "flex flex-col" : "hidden"} ${isDragging ? "" : "transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"}`}>
        {proj && (
          <>
            <div className="flex items-center gap-3 border-b border-white/10 px-4 py-2.5">
              <button onClick={closePanel} className="group flex items-center gap-2 rounded-lg px-1 py-0.5 text-sm transition-colors hover:bg-white/10">
                <ProjectIcon name={proj.name} /><span className="font-semibold">{proj.name}</span>
              </button>
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-400">{panes.length}/{MAX_PANES} open · {proj.sessions.length} chats</span>
              {/* Add a chat to the mix: a blank one, or any of the topic's other sessions. */}
              <div className="relative ml-auto">
                <button onClick={() => setAddMenu((v) => !v)} disabled={panes.length >= MAX_PANES}
                  className="rounded-lg border border-[var(--sakura)]/40 px-2.5 py-1 text-[11px] text-[var(--sakura)] transition-colors hover:bg-[var(--sakura)]/10 disabled:opacity-40">＋ add chat</button>
                {addMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setAddMenu(false)} />
                    <div className="absolute right-0 top-full z-20 mt-1 max-h-96 w-72 overflow-y-auto rounded-xl border border-white/10 bg-neutral-900 p-1 shadow-2xl">
                      <button onClick={() => { setPanes((p) => (p.length < MAX_PANES ? [...p, ""] : p)); setAddMenu(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/10"><span className="text-[var(--sakura)]">＋</span> New blank chat</button>
                      {proj.sessions.some((s) => !panes.includes(s.id)) && <div className="my-1 border-t border-white/10" />}
                      {[...proj.sessions].sort((a, b) => b.lastActivity - a.lastActivity).filter((s) => !panes.includes(s.id)).map((s) => (
                        <button key={s.id} onClick={() => { setPanes((p) => (p.length < MAX_PANES ? [...p, s.id] : p)); setAddMenu(false); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/10">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.active ? "#4ade80" : TIER_TINT[s.tier] }} />
                          <span className="min-w-0 flex-1"><span className="block truncate text-xs">{titleOf(s)}</span><span className="block truncate text-[10px] text-neutral-500">{goalOf(s)} · {ago(s.lastActivity)}</span></span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <button onClick={closePanel} className="rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-white/10">esc ✕</button>
            </div>
            <AttachBar cwd={proj.cwd} project={proj.name} />
            {/* Up to 4 chats in a 2×2 grid — like managing windows on a foldable. */}
            <div className="grid min-h-0 flex-1 gap-2 p-2" style={{ gridTemplateColumns: panes.length <= 1 ? "1fr" : "repeat(2, minmax(0,1fr))", gridAutoRows: "minmax(0, 1fr)" }}>
              {panes.map((id, idx) => (
                <ChatColumn key={id || `new-${idx}`} sessionId={id} sessions={proj.sessions} cwd={proj.cwd} idx={idx} count={panes.length} showTools={showTools}
                  onPick={(nid) => setPanes((p) => p.map((x, j) => (j === idx ? nid : x)))}
                  onClose={() => setPanes((p) => p.filter((_, j) => j !== idx))} />
              ))}
            </div>
          </>
        )}
      </div>

      {picker && <FolderPicker onPick={startTopic} onClose={() => setPicker(false)} />}
    </div>
  );
}

function ChatColumn({ sessionId, sessions, cwd: cwdProp, idx, count, showTools, onPick, onClose }: {
  sessionId: string; sessions: SessionMeta[]; cwd: string; idx: number; count: number; showTools: boolean; onPick: (id: string) => void; onClose: () => void;
}) {
  const [detail, setDetail] = useState<{ meta: SessionMeta | null; turns: Turn[] } | null>(null);
  const [menu, setMenu] = useState(false);
  const [input, setInput] = useState("");
  const [attachOpen, setAttachOpen] = useState(false); // file-attach picker
  const [planning, setPlanning] = useState(false); // Plan vs Code — default Code
  // Approval level in Code mode; persisted so your last choice (incl. bypass) becomes the default.
  const [perm, setPerm] = useSetting<Exclude<AgentMode, "plan">>("permMode", "default");
  const scrollRef = useRef<HTMLDivElement>(null);
  const paneKey = useRef("pane-" + Math.random().toString(36).slice(2)).current;
  const agent = useAgent(paneKey);
  const isNew = !sessionId;
  // Poll the on-disk transcript for history — but stop once this pane is driving the session live
  // (then the live turns are authoritative and the poll would just fight the stream).
  useEffect(() => {
    if (isNew || agent.live) return;
    let a = true;
    const load = () => fetch(`/api/bento/session/${sessionId}`).then((r) => r.json()).then((d) => { if (a) setDetail(d); }).catch(() => {});
    load(); const iv = setInterval(load, 2500); return () => { a = false; clearInterval(iv); };
  }, [sessionId, isNew, agent.live]);
  const cur = sessions.find((s) => s.id === sessionId);
  const cwd = cwdProp || cur?.cwd || sessions[0]?.cwd || "";
  const proj = sessions[0]?.project || cwd.split("/").filter(Boolean).pop() || "";
  const fileTurns = detail?.turns || [];
  // Unified render model: on-disk history until this pane goes live, then the streamed turns.
  const source: RenderTurn[] = agent.live ? agent.turns : fileTurns;
  const visible = showTools ? source : source.filter((t) => t.text.trim() || t.streaming);
  const chats = [...sessions].sort((a, b) => b.lastActivity - a.lastActivity);

  const effectiveMode: AgentMode = planning ? "plan" : perm; // Plan overrides the approval level
  const submit = () => {
    const text = input.trim();
    if (!text || agent.busy || !cwd) return;
    agent.send(text, { cwd, mode: effectiveMode, resume: sessionId || undefined, seed: fileTurns.map((t) => ({ role: t.role, text: t.text, tools: t.tools })) });
    setInput("");
  };
  const setPlan = (on: boolean) => { setPlanning(on); agent.changeMode(on ? "plan" : perm); };
  const setPermLevel = (m: Exclude<AgentMode, "plan">) => { setPerm(m); if (!planning) agent.changeMode(m); };
  // Jump straight to the last message; keep pinned as tokens stream in.
  useEffect(() => {
    const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, source[source.length - 1]?.text.length, agent.pending, agent.busy]);

  return (
    <div className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-neutral-900/40 ${count === 3 && idx === 2 ? "col-span-2" : ""}`}>
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
        {!agent.live && isNew ? (
          <div className="mx-auto mt-16 max-w-sm text-center text-neutral-500">
            <p className="text-2xl">✳</p>
            <p className="mt-2 text-sm font-medium text-neutral-300">New chat in {proj}</p>
            <p className="mt-1 text-xs">Type below to start a live Claude Code session in <code className="text-[11px] text-neutral-400">{cwd || proj}</code>.</p>
          </div>
        ) : visible.length === 0 ? (
          agent.busy ? <p className="text-sm text-neutral-500">Working…</p> : (!isNew && !detail ? <p className="text-sm text-neutral-500">Loading transcript…</p> : null)
        ) : visible.map((t, i) => (
          <div key={i} className={`flex flex-col ${t.role === "user" ? "items-end" : "items-start"}`}>
            <span className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wider text-neutral-600">{t.role === "user" ? "You" : "Claude"}</span>
            <div className={t.role === "user"
              ? "max-w-[85%] rounded-2xl border border-white/15 px-4 py-3 text-[14px] leading-relaxed text-neutral-100 [overflow-wrap:anywhere]"
              : "w-full text-[14px] leading-[1.72] text-neutral-100/90 [overflow-wrap:anywhere]"}>
              {t.text && <Markdown text={t.text} />}
              {t.streaming && (t.text
                ? <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse align-middle" style={{ background: "var(--sakura)" }} />
                : <ThinkingLine label={agent.activity?.label || (t.tools.length ? `using ${t.tools[t.tools.length - 1].name}` : "thinking")} />)}
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

      {/* Claude's AskUserQuestion — a real choice UI. */}
      {agent.ask && <AskCard questions={agent.ask.questions} onAnswer={agent.answerAsk} />}

      {/* Tool-permission prompt (default mode) — Claude is paused until the user decides. */}
      {agent.pending && (
        <div className="mx-4 mb-2 rounded-xl border border-[var(--sakura)]/40 bg-[var(--sakura)]/[0.06] px-3 py-2.5">
          <p className="text-xs text-neutral-200">Claude wants to use <span className="font-semibold text-[var(--sakura)]">{agent.pending.toolName}</span></p>
          <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/40 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-400">{permPreview(agent.pending.toolName, agent.pending.input)}</pre>
          <div className="mt-2 flex items-center gap-2">
            <button onClick={() => agent.respond("allow")} className="rounded-lg bg-[var(--sakura)] px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90">Approve</button>
            <button onClick={() => agent.respond("deny")} className="rounded-lg border border-white/15 px-3 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/10">Deny</button>
            <span className="ml-auto text-[10px] text-neutral-500">acceptEdits mode auto-approves file edits</span>
          </div>
        </div>
      )}

      <div className="border-t border-white/10 px-4 py-3">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {/* Plan vs Code — default Code. Plan proposes without applying. */}
          <div className="flex items-center rounded-lg border border-white/10 p-0.5" title="Plan proposes changes first; Code executes">
            {([["code", false], ["plan", true]] as const).map(([label, on]) => (
              <button key={label} onClick={() => setPlan(on)}
                className={`rounded-md px-2 py-0.5 text-[10px] font-medium capitalize transition-colors ${planning === on ? "bg-[var(--sakura)] text-white" : "text-neutral-500 hover:text-neutral-300"}`}>{label}</button>
            ))}
          </div>
          {/* Approval level (only meaningful in Code mode). "bypass" auto-runs everything — danger. */}
          <div className={`flex items-center gap-1 transition-opacity ${planning ? "pointer-events-none opacity-30" : ""}`}>
            {(["default", "acceptEdits", "bypassPermissions"] as const).map((m) => {
              const on = perm === m;
              const bypass = m === "bypassPermissions";
              return (
                <button key={m} onClick={() => setPermLevel(m)} title={MODE_HINT[m]}
                  className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${on
                    ? (bypass ? "border-green-500/60 bg-green-500/15 text-green-400" : "border-[var(--sakura)]/60 bg-[var(--sakura)]/15 text-[var(--sakura)]")
                    : (bypass ? "border-green-500/25 text-green-500/70 hover:text-green-400" : "border-white/10 text-neutral-500 hover:text-neutral-300")}`}>
                  {m === "default" ? "ask" : m === "acceptEdits" ? "auto-edits" : "bypass"}</button>
              );
            })}
          </div>
          <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[10px] text-neutral-500">
            {agent.error ? <span className="truncate text-red-400">{agent.error.slice(0, 44)}</span>
              : agent.busy ? <><span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ background: "var(--sakura)" }} /><span className="truncate">{agent.activity ? agent.activity.label : planning ? "planning…" : "working…"}</span></>
              : agent.live ? <><span className="h-1.5 w-1.5 rounded-full bg-green-500" />{planning ? "plan mode" : "live"}</> : "ready"}
          </span>
        </div>
        <div className={`flex items-end gap-2 rounded-xl border bg-white/[0.03] px-3 py-2 transition-colors ${agent.busy ? "border-white/10 opacity-70" : "border-white/15 focus-within:border-[var(--sakura)]/60"}`}>
          <button onClick={() => setAttachOpen(true)} disabled={!cwd} title="Attach a file (inserts its path for Claude to read)"
            className="shrink-0 self-end rounded-md px-1 py-1 text-neutral-500 transition-colors hover:text-neutral-200 disabled:opacity-30">📎</button>
          <textarea
            value={input} onChange={(e) => setInput(e.target.value)} rows={1}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder={agent.busy ? "Claude is working…" : `Message Claude in ${proj}…`}
            className="max-h-32 min-h-[20px] flex-1 resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-neutral-600" />
          <button onClick={submit} disabled={!input.trim() || agent.busy || !cwd}
            className="shrink-0 rounded-lg bg-[var(--sakura)] px-2.5 py-1 text-xs font-medium text-white transition-opacity enabled:hover:opacity-90 disabled:opacity-30">↵</button>
        </div>
      </div>
      {attachOpen && <FolderPicker pickFiles start={cwd} onClose={() => setAttachOpen(false)}
        onPick={(p) => { setInput((v) => (v ? v.replace(/\s*$/, " ") : "") + p + " "); setAttachOpen(false); }} />}
    </div>
  );
}

