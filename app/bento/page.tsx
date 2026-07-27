"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type SessionMeta = {
  id: string; project: string; cwd: string; gitBranch: string; title: string; lastPrompt: string;
  model: string; tier: string; tokensIn: number; tokensOut: number; cost: number;
  messages: number; tools: number; lastActivity: number; active: boolean;
};
type Turn = { role: "user" | "assistant"; text: string; tools: { name: string; input: unknown }[]; ts: number; model?: string };

const TIER_TINT: Record<string, string> = { Haiku: "#6cc4a1", Sonnet: "#e8859b", Opus: "#b98cff", Fable: "#f0a868" };
const EMOJI: Record<string, string> = {
  secondBrain: "🧠", ownegoCentral: "🏢", ownego: "🏢", ecomIntel: "🛍️", qdn: "🌐",
  qdnNewWebsite: "🌐", "QSortby-website": "🔀", dataAnalyticsOwnego: "📊", adecosNew: "📦",
  adecosRMF: "📦", CV: "📄", "claude-status-bar-acos": "📟", qikifyDataKnowledge: "📚",
};
const PALETTE = ["#e8859b", "#b98cff", "#6cc4a1", "#6c9cf5", "#f0a868", "#e86c8b"];
function hashN(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function thumb(p: string) { return EMOJI[p] || "◆"; }
function accent(p: string) { return PALETTE[hashN(p) % PALETTE.length]; }
const short = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function Bento() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sel, setSel] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ meta: SessionMeta | null; turns: Turn[] } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  // Poll the session list.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/bento/sessions").then((r) => r.json()).then((d) => {
        if (!alive) return;
        setSessions(d.sessions || []);
        setLoaded(true);
      }).catch(() => setLoaded(true));
    load();
    const iv = setInterval(load, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // Poll the open session (live-tail feel).
  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    let alive = true;
    const load = () => fetch(`/api/bento/session/${openId}`).then((r) => r.json()).then((d) => { if (alive) setDetail(d); }).catch(() => {});
    load();
    const iv = setInterval(load, 2500);
    return () => { alive = false; clearInterval(iv); };
  }, [openId]);

  const cols = 3;
  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") { setOpenId(null); return; }
    if (!sessions.length) return;
    if (e.key === "Enter") { setOpenId(sessions[sel]?.id ?? null); return; }
    let next = sel;
    if (e.key === "ArrowRight" || e.key === "Tab") { e.preventDefault(); next = (sel + 1) % sessions.length; }
    else if (e.key === "ArrowLeft") { next = (sel - 1 + sessions.length) % sessions.length; }
    else if (e.key === "ArrowDown") { next = Math.min(sessions.length - 1, sel + cols); }
    else if (e.key === "ArrowUp") { next = Math.max(0, sel - cols); }
    else return;
    setSel(next);
  }, [sel, sessions]);

  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  useEffect(() => {
    gridRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const open = openId ? sessions.find((s) => s.id === openId) : null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100">
      {/* Grid side */}
      <div className={`flex flex-col transition-all duration-300 ${openId ? "w-full md:w-[40%]" : "w-full"}`}>
        <header className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2">
            <span className="text-xl">🌸</span>
            <h1 className="text-base font-semibold tracking-tight">Minami Bento</h1>
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-400">{sessions.length} sessions</span>
          </div>
          <div className="hidden gap-3 text-[11px] text-neutral-500 md:flex">
            <span>↑↓←→ / Tab navigate</span><span>↵ open</span><span>esc close</span>
          </div>
        </header>

        <div ref={gridRef} className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
          {!loaded ? (
            <p className="mt-20 text-center text-sm text-neutral-500">Reading local sessions…</p>
          ) : sessions.length === 0 ? (
            <div className="mx-auto mt-20 max-w-md text-center text-sm text-neutral-500">
              No local Claude Code sessions found. Bento mirrors <code className="text-xs">~/.claude/projects</code> — run it
              locally (<code className="text-xs">npm run dev</code>) on the machine where you use Claude Code.
            </div>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${openId ? 1 : cols}, minmax(0, 1fr))` }}>
              {sessions.map((s, i) => (
                <button
                  key={s.id}
                  data-i={i}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => setOpenId(s.id)}
                  className={`group relative flex flex-col gap-2 rounded-2xl border p-4 text-left transition-all ${
                    i === sel ? "border-[--sakura] bg-white/[0.07] ring-1 ring-[--sakura]" : "border-white/10 bg-white/[0.03] hover:bg-white/[0.05]"
                  } ${!openId && i === 0 ? "sm:col-span-2 sm:row-span-2" : ""}`}
                  style={{ ["--sakura" as string]: "#e8859b" }}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl text-lg" style={{ background: accent(s.project) + "22" }}>
                      {thumb(s.project)}
                    </div>
                    <span className="flex items-center gap-1 text-[10px] text-neutral-500">
                      <span className={`h-1.5 w-1.5 rounded-full ${s.active ? "animate-pulse bg-green-500" : "bg-neutral-600"}`} />
                      {ago(s.lastActivity)}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className={`truncate font-medium ${!openId && i === 0 ? "text-base" : "text-sm"}`}>{s.title}</p>
                    <p className="truncate text-[11px] text-neutral-500">{s.project}{s.gitBranch ? ` · ${s.gitBranch}` : ""}</p>
                  </div>
                  {!openId && i === 0 && s.lastPrompt && (
                    <p className="line-clamp-2 text-xs text-neutral-400 [overflow-wrap:anywhere]">{s.lastPrompt}</p>
                  )}
                  <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-neutral-500">
                    <span className="inline-flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: TIER_TINT[s.tier] || "#b98cff" }} />{s.tier}
                    </span>
                    <span>{s.messages} msg</span>
                    <span>{short(s.tokensIn + s.tokensOut)} tok</span>
                    <span className="tabular-nums">${s.cost.toFixed(2)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Peek panel */}
      <div className={`min-h-0 border-l border-white/10 bg-neutral-900/60 backdrop-blur transition-all duration-300 ${openId ? "w-full md:w-[60%]" : "w-0 overflow-hidden"}`}>
        {open && (
          <PeekPanel meta={open} detail={detail} onClose={() => setOpenId(null)} />
        )}
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
            <p className="truncate text-sm font-medium">{meta.title}</p>
            <p className="truncate text-[11px] text-neutral-500">{meta.cwd || meta.project}{meta.gitBranch ? ` · ${meta.gitBranch}` : ""}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-neutral-500">
          <span className="inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: TIER_TINT[meta.tier] }} />{meta.tier}</span>
          <span className="tabular-nums">${meta.cost.toFixed(3)}</span>
          <button onClick={onClose} className="rounded-md px-2 py-1 hover:bg-white/10">esc ✕</button>
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {turns.length === 0 ? (
          <p className="text-sm text-neutral-500">Loading transcript…</p>
        ) : turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "flex justify-end" : ""}>
            <div className={`max-w-[92%] rounded-2xl px-3 py-2 text-sm [overflow-wrap:anywhere] ${t.role === "user" ? "bg-[--sakura]/20" : "bg-white/[0.04]"}`} style={{ ["--sakura" as string]: "#e8859b" }}>
              {t.text && <p className="whitespace-pre-wrap leading-relaxed text-neutral-200">{t.text}</p>}
              {t.tools.map((tool, j) => (
                <details key={j} className="mt-1.5 rounded-lg bg-black/30 px-2 py-1 text-xs">
                  <summary className="cursor-pointer select-none text-neutral-400">
                    <span className="mr-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-neutral-300">tool</span>{tool.name}
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[10px] text-neutral-500">{JSON.stringify(tool.input, null, 2)}</pre>
                </details>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Chrome for the live-drive experience (Phase 2 wires this to the Agent SDK) */}
      <div className="border-t border-white/10 px-5 py-3">
        <div className="mb-2 flex items-center gap-1.5">
          {["default", "acceptEdits", "plan"].map((m) => (
            <span key={m} className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-neutral-500">{m}</span>
          ))}
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
