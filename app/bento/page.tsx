"use client";

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
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}
function isTrivial(s: SessionMeta) {
  if (s.messages < 3) return true;
  const t = s.title.toLowerCase();
  return t.startsWith("reply with") || t.includes("model_ok") || t.startsWith("<local-command") || t.includes("caveat: the messages");
}
const goalOf = (s: SessionMeta) => s.goal || "General";
const titleOf = (s: SessionMeta) => s.task || s.title;

const WINDOWS: { label: string; days: number | null }[] = [
  { label: "24h", days: 1 }, { label: "7d", days: 7 }, { label: "30d", days: 30 }, { label: "All", days: null },
];
const CAP = 48;

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
  const gridRef = useRef<HTMLDivElement>(null);
  const enrichLock = useRef(false);
  const rounds = useRef(0);

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
  useEffect(() => {
    if (!loaded || enrichLock.current || rounds.current >= 6) return;
    if (!sessions.some((s) => !s.task && !isTrivial(s))) return;
    enrichLock.current = true; setEnriching(true); rounds.current++;
    fetch("/api/bento/enrich", { method: "POST" }).then((r) => r.json()).then(() => loadSessions()).finally(() => { enrichLock.current = false; setEnriching(false); });
  }, [sessions, loaded, loadSessions]);
  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    let alive = true;
    const load = () => fetch(`/api/bento/session/${openId}`).then((r) => r.json()).then((d) => { if (alive) setDetail(d); }).catch(() => {});
    load(); const iv = setInterval(load, 2500);
    return () => { alive = false; clearInterval(iv); };
  }, [openId]);

  // Filter → cluster by project (then goal, then recency) → one flat, capped list (fits one screen).
  const { flat, total } = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const filtered = sessions.filter((s) => {
      if (hideTrivial && isTrivial(s)) return false;
      if (winDays != null && Date.now() - s.lastActivity > winDays * 86400000) return false;
      if (ql && !(`${titleOf(s)} ${goalOf(s)} ${s.project} ${s.lastPrompt}`.toLowerCase().includes(ql))) return false;
      return true;
    });
    const byProject = new Map<string, SessionMeta[]>();
    for (const s of filtered) { const a = byProject.get(s.project); if (a) a.push(s); else byProject.set(s.project, [s]); }
    const ordered = [...byProject.values()]
      .sort((a, b) => Math.max(...b.map((x) => x.lastActivity)) - Math.max(...a.map((x) => x.lastActivity)))
      .flatMap((items) => items.sort((a, b) => (goalOf(a) === goalOf(b) ? b.lastActivity - a.lastActivity : goalOf(a).localeCompare(goalOf(b)))));
    return { flat: ordered.slice(0, CAP), total: ordered.length };
  }, [sessions, q, winDays, hideTrivial]);

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
    else if (e.key === "ArrowDown") next = Math.min(flat.length - 1, sel + 6);
    else if (e.key === "ArrowUp") next = Math.max(0, sel - 6);
    else return;
    setSel(next);
  }, [sel, flat]);
  useEffect(() => { window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onKey]);
  useEffect(() => { gridRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [sel]);

  const open = openId ? sessions.find((s) => s.id === openId) : null;

  return (
    <div className="flex h-screen w-screen overflow-hidden text-neutral-100" style={{ background: "radial-gradient(1100px 620px at 25% -12%, #1c1622, #0b0a0d 58%)" }}>
      <div className={`ease-spring flex min-w-0 flex-col transition-[width] duration-500 ${openId ? "w-full md:w-[38%]" : "w-full"}`}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pb-2 pt-4">
          <span className="text-xl">🌸</span>
          <h1 className="text-base font-semibold tracking-tight">Minami Bento</h1>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-400">{total > CAP ? `${CAP}/${total}` : total}</span>
          {enriching && <span className="flex items-center gap-1 text-[11px] text-neutral-500"><span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "#e8859b" }} />labeling…</span>}
          <div className="ml-auto hidden gap-3 text-[11px] text-neutral-500 lg:flex"><span>↑↓←→ / Tab</span><span>↵ open</span><span>esc close</span></div>
        </header>

        {!openId && (
          <div className="flex flex-wrap items-center gap-2 px-5 pb-3">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search project / goal / task…"
              className="ease-spring w-48 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs outline-none transition-colors placeholder:text-neutral-600 focus:border-[--sakura]" style={{ ["--sakura" as string]: "#e8859b" }} />
            <div className="flex items-center gap-1 rounded-lg border border-white/10 p-0.5">
              {WINDOWS.map((w) => (
                <button key={w.label} onClick={() => setWinDays(w.days)} className={`ease-spring rounded-md px-2 py-0.5 text-[11px] transition-all ${winDays === w.days ? "bg-[--sakura] text-white" : "text-neutral-400 hover:text-neutral-200"}`} style={{ ["--sakura" as string]: "#e8859b" }}>{w.label}</button>
              ))}
            </div>
            <button onClick={() => setHideTrivial((v) => !v)} className={`ease-spring rounded-lg border px-2.5 py-1 text-[11px] transition-colors ${hideTrivial ? "border-[--sakura] text-[--sakura]" : "border-white/10 text-neutral-400"}`} style={{ ["--sakura" as string]: "#e8859b" }}>{hideTrivial ? "✓ hide noise" : "show all"}</button>
          </div>
        )}

        <div ref={gridRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {!loaded ? <p className="mt-20 text-center text-sm text-neutral-500">Reading local sessions…</p>
          : sessions.length === 0 ? (
            <div className="mx-auto mt-20 max-w-md text-center text-sm text-neutral-500">No local Claude Code sessions found. Bento mirrors <code className="text-xs">~/.claude/projects</code> — run it locally.</div>
          ) : flat.length === 0 ? <p className="mt-20 text-center text-sm text-neutral-500">Nothing matches these filters.</p>
          : (
            <div className={`grid gap-2.5 ${openId ? "grid-cols-1" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"}`}>
              {flat.map((s, i) => {
                const stale = Date.now() - s.lastActivity > 3 * 86400000;
                const tint = TIER_TINT[s.tier] || "#b98cff";
                const pc = accent(s.project);
                return (
                  <button key={s.id} data-i={i} onMouseEnter={() => setSel(i)} onClick={() => setOpenId(s.id)}
                    style={{ ["--sakura" as string]: "#e8859b", animationDelay: `${Math.min(i, 16) * 18}ms`, background: "linear-gradient(150deg, rgba(255,255,255,0.085), rgba(255,255,255,0.02))" }}
                    className={`bento-in ease-spring group relative flex flex-col gap-1 overflow-hidden rounded-xl border p-2.5 pl-3 text-left backdrop-blur transition-all duration-300 will-change-transform hover:-translate-y-0.5 hover:scale-[1.02] ${
                      i === sel ? "border-[--sakura]/60 ring-1 ring-[--sakura] shadow-[0_16px_36px_-18px_rgba(232,133,155,0.55)]" : "border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_10px_24px_-16px_rgba(0,0,0,0.7)] hover:border-white/20"
                    } ${stale ? "opacity-55 hover:opacity-100" : ""}`}>
                    <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full" style={{ background: pc }} />
                    {s.active && <div className="pointer-events-none absolute -right-8 -top-8 h-20 w-20 rounded-full blur-2xl" style={{ background: tint + "38" }} />}
                    <div className="relative flex items-center justify-between">
                      <span className="flex items-center gap-1.5 truncate text-[10px] text-neutral-500">
                        <span className="text-xs">{thumb(s.project)}</span>
                        <span className="truncate">{s.project}<span className="mx-0.5 opacity-40">›</span>{goalOf(s)}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-[10px] text-neutral-500"><span className={`h-1.5 w-1.5 rounded-full ${s.active ? "animate-pulse bg-green-400" : "bg-neutral-600"}`} />{ago(s.lastActivity)}</span>
                    </div>
                    <p className="relative line-clamp-2 text-[13px] font-semibold leading-snug [overflow-wrap:anywhere]">{titleOf(s)}</p>
                    <div className="relative mt-auto flex items-center gap-2 pt-0.5 text-[10px] text-neutral-500">
                      <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: tint }} />{s.tier}</span>
                      <span>{s.messages} msg</span><span>{short(s.tokensIn + s.tokensOut)} tok</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className={`ease-spring min-h-0 border-l border-white/10 bg-neutral-900/60 backdrop-blur transition-[width] duration-500 ${openId ? "w-full md:w-[62%]" : "w-0 overflow-hidden"}`}>
        {open && <PeekPanel meta={open} detail={detail} onClose={() => setOpenId(null)} />}
      </div>
    </div>
  );
}

/* ---------- minimal markdown (code fences, inline code, bold, headings, bullets) ---------- */
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
          <button onClick={onClose} className="ease-spring rounded-md px-2 py-1 transition-colors hover:bg-white/10">esc ✕</button>
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
