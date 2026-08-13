"use client";

import { Nav } from "@/components/Nav";
import { Segmented } from "@/components/ui/Segmented";
import { NotificationBell } from "@/components/NotificationBell";
import AutopilotTile from "@/components/AutopilotTile";
import { useSetting } from "@/lib/use-settings";
import { useAgent, toolCategory, activityLabel, escalationHint, type AgentMode, type ActivityState, type ActivityPhase, type AgentToolCall, type ToolCategory, type ToolOutputBlock, type Notice } from "@/lib/use-agent";
import { ensureNotifyPermission, notify, useTitleFlash } from "@/lib/use-notify";
import Markdown from "@/components/Markdown";
import ThoughtBlock from "@/components/ThoughtBlock";
import FolderPicker from "@/components/FolderPicker";
import AttachBar from "@/components/AttachBar";
import BrandIcon, { type Icon } from "@/components/BrandIcon";
import { ProjectIcon, assignIcons } from "@/components/ProjectIcon";
import BentoRail, { RAIL_W } from "@/components/BentoRail";
import AskCard from "@/components/AskCard";
import Composer from "@/components/Composer";
import BrowserPanel from "@/components/BrowserPanel";
import FilePanel from "@/components/FilePanel";
import { deriveFileState, writtenBy } from "@/lib/file-view";
import { rankTopics, type RecentTopic } from "@/lib/topic-rank";
import BrowserLightbox from "@/components/BrowserLightbox";
import { FlowStrip } from "@/components/FlowStrip";
import { FlowCanvas } from "@/components/FlowCanvas";
import { buildJourney } from "@/lib/flow-model";
import { deriveBrowserState, isBrowserTool, browserArg, browserVerb, hostOf, type BrowserState } from "@/lib/browser-view";
import { loadTechIcons } from "@/lib/tech-icons";
import { atLeast, looser, useDensity, DensityContext, type Density } from "@/lib/density";
import { motion } from "motion/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronLeft, ChevronRight, Chrome, Clock, FileText, GitBranch, Globe, Grid2x2, HelpCircle, ListChecks, PanelLeftClose, Pencil, Puzzle, Search, SquareTerminal, Workflow, Wrench, type LucideIcon } from "lucide-react";

type SessionMeta = {
  id: string; project: string; cwd: string; gitBranch: string; title: string; lastPrompt: string;
  model: string; tier: string; tokensIn: number; tokensOut: number; cost: number;
  messages: number; tools: number; toolNames: string[]; lastActivity: number; active: boolean;
  task?: string; goal?: string; lastRole?: string; tail?: string; review?: boolean;
};
// Reuses AgentToolCall (not a separate shape) so a disk-loaded tool call and a live-streamed one render
// through the exact same code — `done`/`ms` just stay unset for disk data, `output` (incl. screenshots)
// is populated by claude-sessions.ts the same way manager.ts populates it live.
// Mirrors lib/claude-sessions.ts's Turn. `off` (the byte offset of the line that produced this turn) is
// what lets a fetched history page be de-duplicated against the polled window.
type Turn = { role: "user" | "assistant"; text: string; tools: AgentToolCall[]; ts: number; model?: string; off?: number };
// Live turns carry per-tool completion state (id/done/ok/ms) that the on-disk transcript doesn't have.
type RenderTurn = { role: "user" | "assistant"; text: string; tools: AgentToolCall[]; streaming?: boolean; thinking?: string };

// A pane = one chat column. `key` is a stable id (survives refresh, so it can reattach to its live
// server session); `sid` is the Claude session id it's showing ("" for a brand-new blank chat).
// `switchGen` bumps only when the USER explicitly picks a different existing session for this pane (the
// chat-switcher dropdown) — see its use as part of ChatColumn's React `key` below for why this can't
// just be `sid` itself.
// `cwd` is set only on an ISOLATED pane — a chat given its own git worktree so it cannot overwrite
// another agent's files (§9). It lives on the pane rather than being derived, because a session's cwd
// is fixed at spawn: once the chat exists, this string is the only record of where it actually runs,
// and `--resume` is scoped to the directory the transcript is filed under (§1). Persisted with the
// pane in `openPanes`, so a reload resumes it in its own checkout rather than in the shared one.
type Pane = { key: string; sid: string; switchGen?: number; cwd?: string };
let paneSeq = 0;
const mkPane = (sid = ""): Pane => ({ key: `pane-${Date.now().toString(36)}-${paneSeq++}-${Math.random().toString(36).slice(2, 7)}`, sid });
const asPanes = (v: unknown): Pane[] => Array.isArray(v)
  ? v.map((x) => (typeof x === "string" ? mkPane(x) : (x && typeof x === "object" && "key" in (x as object) ? (x as Pane) : mkPane())))
  : [];

// Client-side transcript cache. Switching between projects remounts the chat columns; without this,
// each switch re-fetches and flashes "Loading transcript…" again. It's ALSO mirrored to sessionStorage
// so a hard reload (which re-executes this module from scratch, wiping the plain in-memory Map) still
// paints instantly from what was cached a moment ago, instead of a cold fetch+parse for every open pane.
// sessionStorage (not localStorage) deliberately — this cache is scoped to "this tab's lifetime": it
// should survive a reload but not linger forever across days like a stale localStorage entry would.
// `start` is the byte offset the server's window begins at, and `hasMore` is simply `start > 0` — the
// signal the old shape had no way to express, which is why a truncated transcript was indistinguishable
// from a short one. Both optional so a response cached by an older build still deserializes.
type Detail = { meta: SessionMeta | null; turns: Turn[]; start?: number; hasMore?: boolean };
const TS_PREFIX = "bento:t:";
const TS_ORDER_KEY = "bento:t:__order";
const TS_MAX = 24;
const transcriptCache = new Map<string, Detail>();

// Trim what actually gets persisted (the in-memory copy stays full-fidelity for normal in-tab reuse).
// Tool inputs can carry a whole file's contents (Write/Edit) — cap those, and cap history depth, so a
// handful of verbose sessions can't blow sessionStorage's ~5-10MB quota.
function trimInput(input: unknown): unknown {
  try {
    const s = JSON.stringify(input);
    return s.length <= 2000 ? input : { _truncated: true, preview: s.slice(0, 2000) };
  } catch { return null; }
}
// Screenshots are the whole point of the browser tool, but a handful of them (each tens of KB of
// base64) would blow sessionStorage's ~5-10MB quota fast — drop images from what's PERSISTED (the
// live in-memory transcriptCache above keeps full fidelity for the rest of the tab's session; only a
// hard reload loses the pixels, never the fact that a screenshot happened).
function trimOutput(tc: AgentToolCall): AgentToolCall["output"] {
  if (!tc.output) return undefined;
  const hadImage = tc.output.blocks.some((b) => b.type === "image");
  const blocks = tc.output.blocks.filter((b) => b.type !== "image");
  if (!blocks.length && !hadImage) return undefined;
  return { blocks, truncated: tc.output.truncated || hadImage };
}
function toStorable(d: Detail): Detail {
  return { meta: d.meta, turns: d.turns.slice(-40).map((t) => ({ ...t, tools: t.tools.map((tc) => ({ name: tc.name, input: trimInput(tc.input), output: trimOutput(tc) })) })) };
}
function loadOrder(): string[] {
  try { const s = sessionStorage.getItem(TS_ORDER_KEY); return s ? (JSON.parse(s) as string[]) : []; } catch { return []; }
}
function persistTranscript(id: string, d: Detail) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(TS_PREFIX + id, JSON.stringify(toStorable(d)));
    sessionStorage.setItem(TS_ORDER_KEY, JSON.stringify([...transcriptCache.keys()]));
  } catch {
    // Quota exceeded — drop the oldest half of what's persisted and retry once; if it still fails,
    // this tab just keeps serving from the in-memory cache (worst case reverts to a cold reload).
    try {
      const order = [...transcriptCache.keys()];
      for (const old of order.slice(0, Math.ceil(order.length / 2))) sessionStorage.removeItem(TS_PREFIX + old);
      sessionStorage.setItem(TS_PREFIX + id, JSON.stringify(toStorable(d)));
      sessionStorage.setItem(TS_ORDER_KEY, JSON.stringify([...transcriptCache.keys()]));
    } catch { /* give up silently */ }
  }
}
const cacheTranscript = (id: string, d: Detail) => {
  transcriptCache.set(id, d);
  if (transcriptCache.size > TS_MAX) {
    const k = transcriptCache.keys().next().value;
    if (k) { transcriptCache.delete(k); if (typeof window !== "undefined") { try { sessionStorage.removeItem(TS_PREFIX + k); } catch { /* ignore */ } } }
  }
  persistTranscript(id, d);
};
// Hydrate once, on first module evaluation in the browser (i.e. right as the (re)loaded page boots) —
// seeds the in-memory cache so the very first render after a reload already has data to paint.
if (typeof window !== "undefined") {
  for (const id of loadOrder()) {
    try { const raw = sessionStorage.getItem(TS_PREFIX + id); if (raw) transcriptCache.set(id, JSON.parse(raw) as Detail); } catch { /* corrupt entry — skip it */ }
  }
}

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
// How long a thin session still counts as "something the user just started" rather than noise.
const FRESH_MS = 24 * 3600 * 1000;
// Sessions worth hiding from the grid: the enrichment summarizer's probes, slash-command echoes, and
// one-shot noise. `messages` counts user AND assistant records, so a real first exchange is exactly 2.
//
// That made `messages < 3` fatal for new topics: you'd pick a folder, send one message, get a reply —
// and the topic had no tile, because its only session was 2 messages and got filtered out here. It
// appeared on the third message, which reads exactly like "Bento can't create the topic". A thin
// session is now only trivial once it's gone cold, so a topic you just made is always visible.
function isTrivial(s: SessionMeta) {
  const t = s.title.toLowerCase();
  if (t.startsWith("reply with") || t.includes("model_ok") || t.startsWith("<local-command") || t.includes("caveat: the messages")) return true;
  if (s.messages < 3) return !s.active && Date.now() - s.lastActivity > FRESH_MS;
  return false;
}
const goalOf = (s: SessionMeta) => s.goal || "General";
const titleOf = (s: SessionMeta) => s.task || s.title;

type Project = { name: string; sessions: SessionMeta[]; cwd: string; reqs: number; tokens: number; last: number; active: boolean; review: boolean; goals: string[]; latest: string; weight: number };
// Sessions → topics. A topic is not stored anywhere: it's `basename(cwd)`, grouped (see §5d). Pulled
// out of the grid's useMemo so the same derivation can run over the FILTERED list (what the board
// draws) and over the unfiltered one (what the open panel resolves against) without the two drifting.
function groupProjects(list: SessionMeta[]): Project[] {
  const m = new Map<string, SessionMeta[]>();
  for (const s of list) { const a = m.get(s.project); if (a) a.push(s); else m.set(s.project, [s]); }
  return [...m.entries()].map(([name, ss]) => {
    const reqs = ss.reduce((a, x) => a + x.messages, 0);
    const tokens = ss.reduce((a, x) => a + x.tokensIn + x.tokensOut, 0);
    const latest = [...ss].sort((a, b) => b.lastActivity - a.lastActivity)[0];
    return { name, sessions: ss, cwd: ss[0]?.cwd || "", reqs, tokens, last: Math.max(...ss.map((x) => x.lastActivity)), active: ss.some((x) => x.active), review: ss.some((x) => x.review), goals: [...new Set(ss.map(goalOf))], latest: titleOf(latest), weight: reqs + tokens / 5000 };
  });
}
const WINDOWS: { label: string; days: number | null }[] = [
  { label: "24h", days: 1 }, { label: "3d", days: 3 }, { label: "7d", days: 7 }, { label: "30d", days: 30 }, { label: "All", days: null },
];
const MAX_PANES = 4;
// useLayoutEffect is a no-op (and warns) during Next's server prerender.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const MODE_HINT: Record<AgentMode, string> = {
  default: "Ask before running tools that need approval",
  acceptEdits: "Auto-approve file edits; still ask for other tools",
  plan: "Plan only — propose changes without applying them",
  bypassPermissions: "⚠ Auto-approve EVERY tool with no prompt — including destructive ones",
};
// One name per approval level, used by the chips AND by the folded mode pill that replaces them in a
// cramped pane. Two spellings of "bypass" in one UI is how a badge starts describing the wrong thing.
const PERM_LABEL: Record<Exclude<AgentMode, "plan">, string> = {
  default: "ask", acceptEdits: "auto-edits", bypassPermissions: "bypass",
};
const fmtElapsed = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
// Per-phase accent, so the indicator's colour alone tells you thinking vs tool vs blocked-on-you.
const PHASE_TINT: Record<ActivityPhase, string> = {
  idle: "#6b7280", spawning: "#f6c667", thinking: "var(--sakura)", responding: "#6c9cf5", tool: "#f0a868",
  awaiting: "#4ade80", retrying: "#ef7c7c", compacting: "#a78bfa",
};
// Per-tool-category accent, layered on top of PHASE_TINT: while the phase is `tool`, the indicator
// takes the color of the SPECIFIC kind of work — reading vs writing vs running a command vs a
// subagent — instead of one flat orange for every tool. Same map drives the chat panel's tool chips,
// the per-call transcript block, AND (since it's the same ActivityLine component) the bento tile's
// live-activity dot, so "what's this box actually doing" reads the same everywhere it shows up.
const TOOL_TINT: Record<ToolCategory, string> = {
  read: "#6c9cf5", write: "#f0a868", exec: "#e8859b", search: "#6cc4a1", web: "#4dd0e1", browser: "#5ec8f8",
  task: "#b98cff", plan: "#4ade80", ask: "#e8859b", skill: "#f0a868", mcp: "#b98cff", other: "#9ca3af",
};
const TOOL_ICON: Record<ToolCategory, LucideIcon> = {
  read: FileText, write: Pencil, exec: SquareTerminal, search: Search, web: Globe, browser: Chrome,
  task: Bot, plan: ListChecks, ask: HelpCircle, skill: Puzzle, mcp: Puzzle, other: Wrench,
};

/**
 * The live activity indicator: bouncing dots + what Claude is doing + how long it's been doing it.
 *
 * Everything shown here comes from the server-derived ActivityState, so it stays truthful across
 * parallel tool calls, subagents, retries and refreshes. The elapsed counter is the important part —
 * during a silent 90s Bash the label doesn't change, and without a ticking number the pane is
 * indistinguishable from a hung one.
 */
function ActivityLine({ activity, elapsed, compact, busy, hideTime, notices }: { activity: ActivityState; elapsed: number; compact?: boolean; busy?: boolean; hideTime?: boolean; notices?: Notice[] }) {
  // `busy` without a phase shouldn't happen (the server always sets one), but if the two ever
  // disagree, err toward animating: a silent blank line is the exact failure we're fixing.
  const phase: ActivityPhase = activity.phase === "idle" && busy ? "thinking" : activity.phase;
  if (phase === "idle") return null;
  // A `spawning` cold-start has no per-step signal from the SDK, just elapsed time — so the hint IS
  // the label (it narrates a plausible sequence) rather than a secondary aside next to a static string.
  const hint = escalationHint(phase, elapsed);
  const label = phase === "spawning" ? (hint || activity.label || "starting session…") : (activity.label || "working…");
  const extras = activity.tools.filter((t) => !t.parentId && t.name !== "Task" && t.name !== "Agent");
  // While a tool is running, color the whole line by the SPECIFIC kind of work — the same "own" tool
  // (or, with none, the running subagent) that the label text itself names — instead of one flat
  // "tool" orange for reads, writes, exec and everything else alike.
  const activeCat: ToolCategory | null = phase === "tool"
    ? (extras.length ? toolCategory(extras[extras.length - 1].name) : (activity.tasks.length ? "task" : null))
    : null;
  const tint = activeCat ? TOOL_TINT[activeCat] : PHASE_TINT[phase];
  const Icon = activeCat ? TOOL_ICON[activeCat] : null;
  const frozen = phase === "awaiting"; // nothing is moving — don't pretend otherwise
  const finished = compact ? [] : (notices || []).filter((n) => n.kind === "task");
  return (
    <span className={`flex min-w-0 flex-col gap-y-1 ${compact ? "text-[10px]" : "text-xs"}`}>
      <span className={`flex min-w-0 items-center gap-x-2 gap-y-1 ${compact ? "flex-nowrap" : "flex-wrap"} text-neutral-400 ${frozen ? "activity-idle" : ""}`}>
        <span className="flex shrink-0 items-center gap-0.5">
          {[0, 1, 2].map((i) => <span key={i} className={`think-dot ${compact ? "h-1 w-1" : "h-1.5 w-1.5"} rounded-full`} style={{ background: tint, animationDelay: `${i * 0.15}s` }} />)}
        </span>
        {/* A small glyph naming the kind of work, chat-panel only — the tile stays dot+text so a tiny
            tile never feels cluttered. */}
        {Icon && !compact && <Icon className="h-3 w-3 shrink-0" style={{ color: tint }} strokeWidth={2.25} />}
        <span className="activity-label min-w-0 truncate italic" style={{ color: tint }}>{label}</span>
        {/* For every OTHER phase the hint is an addition, not a replacement — it only shows once a task
            has clearly run past typical duration, as a reassurance alongside the (more specific) label. */}
        {hint && phase !== "spawning" && !compact && <span className="shrink-0 italic text-[10px] text-neutral-600">· {hint}</span>}
        {!hideTime && <span className="shrink-0 font-mono text-[10px] tabular-nums text-neutral-600">{fmtElapsed(elapsed)}</span>}
        {/* Parallel tool calls: the label names one, so chip the rest instead of hiding them — each
            tinted by its own category so read/write/exec/etc. are distinguishable at a glance. */}
        {!compact && extras.length > 1 && (
          <span className="flex flex-wrap gap-1">
            {extras.slice(0, 4).map((t) => {
              const c = toolCategory(t.name);
              return <span key={t.id} className="rounded border px-1 py-px font-mono text-[9px]" style={{ borderColor: TOOL_TINT[c] + "45", color: TOOL_TINT[c] }}>{t.name}</span>;
            })}
            {extras.length > 4 && <span className="text-[9px] text-neutral-600">+{extras.length - 4}</span>}
          </span>
        )}
        {/* Running subagents, with the inner tool they're on — otherwise a 3-minute Task is opaque. */}
        {!compact && activity.tasks.map((k) => (
          <span key={k.id} className="flex items-center gap-1 rounded-full border px-1.5 py-px text-[9px]" style={{ borderColor: TOOL_TINT.task + "45", color: TOOL_TINT.task }}>
            <Bot className="h-2.5 w-2.5" strokeWidth={2.5} />
            {k.agent || k.description}{k.lastTool ? ` · ${k.lastTool}` : ""}{k.toolUses ? ` · ${k.toolUses} tools` : ""}
          </span>
        ))}
      </span>
      {/* Subagents that already finished — pulled onto their own row, dimmed with a ✓/✗/⏹ instead of a
          live tool. Used to live crammed onto the status line above, jockeying for space with the
          dots/label/timer/extras/running-tasks — with several subagents (a common pattern in this repo:
          parallel investigations) that line filled up and wrapped into a jumble. A dedicated row below
          keeps the live status line readable regardless of how many subagents finished this turn. This
          in turn replaced an even older design, where each finished subagent appended its own
          full-sentence line (NoticeStrip's "task" notices) that stacked up at the bottom of the chat as
          the turn went on. Full text still available on hover. */}
      {finished.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {finished.map((n, i) => {
            const ok = n.status === "completed";
            const nTint = ok ? TOOL_TINT.task : "#ef7c7c";
            return (
              <span key={`${n.at}-${i}`} title={n.text} className="flex items-center gap-1 rounded-full border px-1.5 py-px text-[9px] opacity-70" style={{ borderColor: nTint + "45", color: nTint }}>
                <Bot className="h-2.5 w-2.5" strokeWidth={2.5} />
                {n.agent || "subagent"}
                <span>{ok ? "✓" : n.status === "stopped" ? "⏹" : "✗"}</span>
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}

// Retries, auto-compactions and denials: brief, non-fatal, but they explain long silences. Subagent
// ("task") notices are deliberately excluded here — they render as compact inline pills inside
// ActivityLine instead (see the "Subagents that already finished" block above), so a chatty session
// with several subagents doesn't grow a full-sentence line per one at the bottom of the chat.
// `restarting` shares the amber warning language used by the account alert: it's the one notice that
// arrives BEFORE the disruption (the deploy script warning panes it's about to swap the server out from
// under them), so it has to read as "act now", not as after-the-fact grey chatter like `aborted`.
const NOTICE_TINT: Record<string, string> = { retry: "#ef7c7c", compact: "#a78bfa", task: "#6c9cf5", limit: "#f0a868", denied: "#f0a868", aborted: "#9ca3af", restarting: "#f0a868" };
function NoticeStrip({ notices }: { notices: Notice[] }) {
  const rest = notices.filter((n) => n.kind !== "task");
  if (!rest.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {rest.map((n, i) => (
        <span key={`${n.at}-${i}`} className="flex items-center gap-1.5 text-[10px]" style={{ color: NOTICE_TINT[n.kind] || "#9ca3af" }}>
          <span className="h-1 w-1 rounded-full" style={{ background: "currentColor" }} />{n.text}
        </span>
      ))}
    </div>
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
  // Away-tab notifications: flashes the document title when any pane (see ChatColumn) fires notify()
  // while this tab isn't visible/focused. Mounted once, here, not per-pane — see lib/use-notify.ts.
  useTitleFlash("Minami Bento");
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
  const [panes, setPanes] = useState<Pane[]>([]);
  const [addMenu, setAddMenu] = useState(false); // "add a chat to the mix" picker
  // Which pane, if any, has the whole panel to itself. Four transcripts at once is a glanceable state,
  // not a readable one — you watch four and read one. null = the grid; an index = that pane is the
  // screen and the rest collapse to the tab strip above it (they stay MOUNTED, see the grid below).
  // Tabs is the DEFAULT, and the grid is the alternate view — the inverse of the first cut, where the
  // grid was the resting state and one pane could be promoted out of it. Four transcripts at once is a
  // glanceable state, not a readable one: you watch four and read one, so the resting state should be
  // the one you can read. The grid stays a keystroke away for when the question is "what are all four
  // doing", which is a real question, just not the common one.
  //
  // Persisted, because it's a statement about how you want to work, not about this topic.
  const [paneView, setPaneView] = useSetting<"tabs" | "grid">("paneView", "tabs");
  const [activePane, setActivePane] = useState(0);
  // The identity header hides itself and comes back on hover. Persisted, because "I want to see the
  // repo path at all times" is a preference about the app, not about this project.
  const [headerPinned, setHeaderPinned] = useSetting<boolean>("panelHeaderPinned", false);
  // The pane that owns the panel right now, or null in grid view. Clamped here rather than in state so
  // it can never point past the array even for the render between a close and its effect.
  const focusPane = paneView === "tabs" && panes.length ? Math.min(activePane, panes.length - 1) : null;
  // Read inside the window key handler, which deliberately doesn't re-subscribe per keystroke.
  const focusRef = useRef<number | null>(null);
  focusRef.current = focusPane;
  const panesRef = useRef(0); // same reason: how many panes ⌥1–4 may address, read without re-subscribing
  panesRef.current = panes.length;
  // Closed tabs, most recent last — the ⌥⇧T stack. Declared up here with the other cross-cutting refs
  // because both the close path and every panel-teardown path touch it. See closePane below.
  const closedTabs = useRef<{ pane: Pane; at: number }[]>([]);
  const [openPanesMap, setOpenPanesMap] = useSetting<Record<string, Pane[]>>("openPanes", {}); // remembered per topic
  // The currently-open panel, persisted so a page refresh reopens it exactly (with its panes).
  const [openPanel, setOpenPanel] = useSetting<{ name: string; cwd: string; topic: boolean; panes: Pane[] } | null>("openPanel", null);
  const restoredRef = useRef(false);
  const [newTopic, setNewTopic] = useState<Project | null>(null); // ad-hoc topic opened via the folder picker
  // Which tile is currently expanded into the flow canvas, and for which session. One at a time: two
  // canvases in a grid is two things fighting for the same attention, and the grid has room for one.
  const [flowFor, setFlowFor] = useState<{ project: string; sid: string } | null>(null);
  const [picker, setPicker] = useState(false); // folder picker modal open
  // Is something layered ON TOP of the panel right now? Read by the window-level Escape handler, which
  // deliberately doesn't re-subscribe per render (same pattern as focusRef/panesRef). Escape belongs to
  // the nearest thing that can consume it, and both of these are dismissed by it — without this, one
  // press closed the overlay AND the panel underneath, so leaving the flow canvas also left the chat.
  const overlayRef = useRef(false);
  overlayRef.current = picker || !!flowFor;
  const [techIcons, setTechIcons] = useState<Record<string, Icon>>({}); // brand icon SVGs
  const [attachMap, setAttachMap] = useState<Record<string, { tech: string[]; icon?: string }>>({}); // per-project tech + topic icon
  const [showTools] = useSetting<boolean>("showToolLogs", false);
  const [panelW, setPanelW] = useSetting<number>("panelWidth", 60); // chat panel width %, persisted
  // Past a threshold the bento stops shrinking and becomes a rail (see components/BentoRail.tsx). It's
  // explicit state, not a width derivation: it has to survive a reload, and a percentage-of-viewport
  // means a different thing on a 13" laptop than on a 32" display.
  const [rail, setRail] = useSetting<boolean>("bentoRail", false);
  const [isDragging, setDragging] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null); // the split's DOM node, written to directly mid-drag
  const railRef = useRef(rail); // read inside the drag listener, which is deliberately not re-subscribed
  railRef.current = rail;
  // The width in flight. It lives in a ref, not in the drag effect's closure: flipping to the rail
  // mid-gesture re-renders, and anything held in the effect's locals is reset when it re-subscribes —
  // which silently threw away the width you'd just dragged to.
  const pendingW = useRef(panelW);
  const enrichLock = useRef(false);
  const rounds = useRef(0);
  const sessionsSig = useRef("");

  const loadSessions = useCallback(
    () => fetch("/api/bento/sessions").then((r) => r.json()).then((d) => {
      // A response without a `sessions` ARRAY is a failure, not an empty board — `{error}` from the
      // route, or an HTML error page that happened to parse. Treating it as [] emptied the grid and,
      // because the open panel resolves through that list, took the conversation off screen with it
      // for one poll. Hold the last good list instead; the next tick corrects it either way.
      if (!Array.isArray(d?.sessions)) { setLoaded(true); return; }
      // Skip the state update (and the whole grid re-render) when nothing changed since the last poll.
      const sig = JSON.stringify(d.sessions);
      if (sig !== sessionsSig.current) { sessionsSig.current = sig; setSessions(d.sessions); }
      setLoaded(true);
    }).catch(() => setLoaded(true)),
    [],
  );
  useEffect(() => { let a = true; const t = () => { if (a) loadSessions(); }; t(); const iv = setInterval(t, 5000); return () => { a = false; clearInterval(iv); }; }, [loadSessions]);
  // Live activity per session (what each running dashboard-driven session is doing right now) — polled
  // fast so a tile can show "thinking… / running: … / reading X" live while a box works.
  const [liveAct, setLiveAct] = useState<Record<string, { phase: string; label: string; busy: boolean; cwd: string }>>({});
  const liveActSig = useRef("");
  useEffect(() => {
    let a = true;
    const t = () => fetch("/api/agent/live").then((r) => r.json()).then((d) => {
      if (!a) return;
      const sig = JSON.stringify(d.activity || {});
      if (sig !== liveActSig.current) { liveActSig.current = sig; setLiveAct(d.activity || {}); }
    }).catch(() => {});
    t(); const iv = setInterval(t, 1500); return () => { a = false; clearInterval(iv); };
  }, []);
  // Read by `openProject`, which must NOT re-create itself every 1.5s: it is the onClick of every tile
  // on the board, so a new identity per poll re-renders the whole grid twice a second for a value that
  // is only ever read at the instant of a click.
  const liveActRef = useRef(liveAct);
  liveActRef.current = liveAct;
  // The open project's folder, read at click time by `addPane`. A ref for the same reason as the two
  // above: it is used inside a callback that must not be rebuilt as the board polls.
  const projCwdRef = useRef("");
  // Same reason, and deliberately the RAW list rather than `pool` or a project's `sessions`: those are
  // filtered (trivial, then the date window), and `openProject` sorts panes the user chose to keep open
  // — including ones the board itself would not show. Reading a filtered list there dated every such
  // pane to 0 and swept them all to the end of the row.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // Per-PANE activity, keyed by pane key rather than session id — the fallback for the one window
  // `liveAct` structurally cannot cover. A blank chat has no session id until the server assigns one a
  // second or two into its first turn, so a just-sent pane is missing from a session-id-keyed map at
  // exactly the moment its tab most needs to say "running". Each pane reports its own SSE-derived
  // phase here (see ChatColumn's `onBusy`), and the tab strip reads it ONLY where `liveAct` has no
  // entry — so the server stays the single source of truth everywhere it has an answer.
  const [paneAct, setPaneAct] = useState<Record<string, { phase: ActivityPhase; label: string; busy: boolean }>>({});
  const reportPaneAct = useCallback((key: string, next: { phase: ActivityPhase; label: string; busy: boolean }) => {
    setPaneAct((p) => {
      const cur = p[key];
      // Return the SAME object when nothing changed: this fires on every ChatColumn render, and a fresh
      // object each time would re-render the whole board (and every tile) at the pane's stream rate.
      if (cur && cur.phase === next.phase && cur.busy === next.busy && cur.label === next.label) return p;
      return { ...p, [key]: next };
    });
  }, []);
  // Closed panes leave their key behind; drop it, so a long day of opening and closing chats doesn't
  // grow a map of phases nothing reads.
  const paneKeySig = panes.map((p) => p.key).join("|");
  useEffect(() => {
    setPaneAct((p) => {
      const live = new Set(paneKeySig ? paneKeySig.split("|") : []);
      const stale = Object.keys(p).filter((k) => !live.has(k));
      if (!stale.length) return p;
      const n = { ...p };
      stale.forEach((k) => delete n[k]);
      return n;
    });
  }, [paneKeySig]);
  useEffect(() => {
    if (!loaded || enrichLock.current || rounds.current >= 6) return;
    if (!sessions.some((s) => !s.task && !isTrivial(s))) return;
    enrichLock.current = true; setEnriching(true); rounds.current++;
    fetch("/api/bento/enrich", { method: "POST" }).then((r) => r.json()).then(() => loadSessions()).finally(() => { enrichLock.current = false; setEnriching(false); });
  }, [sessions, loaded, loadSessions]);

  // Everything the board could ever show — `isTrivial` only. The date window is applied on top of this
  // (below) rather than folded into it, because the two answer different questions: `pool` is "what
  // exists", `windowed` is "what I want to look at right now". The open panel needs the first.
  const pool = useMemo(() => sessions.filter((s) => !isTrivial(s)), [sessions]);
  const windowed = useMemo(
    () => (winDays == null ? pool : pool.filter((s) => Date.now() - s.lastActivity <= winDays * 86400000)),
    [pool, winDays],
  );

  const projects = useMemo<Project[]>(() => {
    const list = groupProjects(windowed);
    const sorters = {
      recent: (a: Project, b: Project) => b.last - a.last,
      busy: (a: Project, b: Project) => b.weight - a.weight,
      name: (a: Project, b: Project) => a.name.localeCompare(b.name),
    };
    list.sort(sorters[sortBy]);
    const ql = q.trim().toLowerCase();
    return ql ? list.filter((p) => `${p.name} ${p.goals.join(" ")} ${p.latest}`.toLowerCase().includes(ql)) : list;
  }, [windowed, q, sortBy]);

  // The open project, resolved OUTSIDE the board's filters.
  //
  // `projects` is a view: the search box and the date chip narrow it. The panel used to read the open
  // project straight out of that view, so anything that filtered a project off the BOARD unmounted the
  // CONVERSATION with it — every pane in it, mid-turn, with no close action and nothing to say why.
  // Reproduced: open a chat, type four letters in Search, and the panel is gone. Typing "24h" over an
  // older chat did the same, as did any poll that failed to return an array (see loadSessions).
  //
  // Two lookups, in order: the filtered one first so `p.sessions` still respects the window everywhere
  // it's read (the ＋ menu, the chat switcher, `continueTarget`), then the unfiltered one purely to
  // keep what's on screen on screen.
  const allProjects = useMemo(() => groupProjects(pool), [pool]);
  const openProj = useMemo(
    () => (project ? allProjects.find((p) => p.name === project) ?? null : null),
    [allProjects, project],
  );

  const openProject = useCallback((p: Project) => {
    // Default: open the recent combination (up to 4 sessions active within the date filter). If the
    // user has customized which chats are open for this topic before, restore that instead.
    const recent = [...p.sessions].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, MAX_PANES).map((s) => s.id);
    // Keep every remembered pane (blank or an existing session). We deliberately don't drop panes whose
    // session isn't in the current window/list — that used to silently discard a brand-new running chat
    // on a project switch. A pane reattaches by session id, so a running one resumes streaming.
    const remembered = asPanes(openPanesMap[p.name]);
    // ...unless what's remembered is nothing but BLANK panes while the project does have chats. That's
    // the fingerprint of a brand-new topic whose pane never learned its session id: the SDK reports the
    // id a second or two after the first send (via the SSE `init` event → onLive), so closing or
    // reloading inside that window persists `sid: ""` forever. The topic then reopened on an empty "New
    // chat" every time, with the actual conversation reachable only from the chat-switcher dropdown —
    // it looked like the chat had been thrown away. A deliberately-kept blank pane alongside real ones
    // still survives, because this only triggers when EVERY remembered pane is blank.
    const allBlank = remembered.length > 0 && remembered.every((x) => !x.sid);
    const usable = allBlank && recent.length ? [] : remembered;
    // Each pane carries the cwd its session was actually born in. For an isolated chat that is its
    // worktree, and `--resume` is scoped to the directory the transcript is filed under — resuming it
    // from the shared checkout is §1's "No conversation found with session ID", not a cosmetic slip.
    const cwdOf = (sid: string) => { const c = sessionsRef.current.find((x) => x.id === sid)?.cwd; return c && c !== p.cwd ? c : undefined; };
    const withCwd = (pn: Pane): Pane => { const c = pn.sid ? cwdOf(pn.sid) : undefined; return c ? { ...pn, cwd: c } : pn; };
    const initial = (usable.length ? usable.slice(0, MAX_PANES) : (recent.length ? recent.map((sid) => mkPane(sid)) : [mkPane()])).map(withCwd);

    // ── which tab you land on, and in what order ───────────────────────────────────────────────
    // Both of these are ONLY decided here, at the moment a topic opens. Nothing re-sorts the row or
    // moves the selection while you are in it: a tab that reorders itself under the cursor is the
    // same mis-click the header peek caused (see the chrome note below), and stealing focus to a
    // background chat that just started a turn would take the transcript you were reading off screen
    // mid-sentence. While you're here, a working tab announces itself and stays where it is —
    // that's what the sweep and the ring on it are for.
    const lastOf = (pn: Pane) => (pn.sid ? sessionsRef.current.find((s) => s.id === pn.sid)?.lastActivity ?? 0 : 0);
    // Newest interaction first. A remembered BLANK pane sorts last (`0`): it is a scratch pad you kept,
    // and landing the panel on an empty composer is precisely the "the chat was thrown away" shape the
    // `allBlank` guard above exists to prevent.
    const ordered = [...initial].sort((a, b) => lastOf(b) - lastOf(a));
    // Running outranks recent. `lastActivity` comes off the transcript on disk and a session mid-turn
    // may not have written a line for a minute, so the chat that is *working* can easily sort below
    // one you merely opened more recently — and it is the one you crossed the board to look at.
    const live = liveActRef.current;
    const runningAt = ordered.findIndex((pn) => pn.sid && live[pn.sid]?.busy);

    // Flow needs the room: a step graph in a quarter-pane is a picture of a graph, not something you
    // can review. So a Flow topic opens full-bleed — bento railed, one pane — which is the same
    // layout the divider already produces, not a second window mode to maintain.
    setNewTopic(null); setProject(p.name); setPanes(ordered); setAddMenu(false); closedTabs.current = [];
    // Explicit, not left alone: `activePane` is panel-scoped state that survives a project switch, so
    // without this you arrive at another topic on whichever *index* you were reading in the last one —
    // tab 3 of a project you have never opened, or tab 0 by accident. Index-carry-over is not a
    // selection.
    setActivePane(runningAt >= 0 ? runningAt : 0);
  }, [openPanesMap]);
  // Prefetch a project's likely-open transcripts on hover so clicking it paints instantly (the fetch +
  // parse already happened). Each session is fetched once — the cache guard makes repeat hovers free.
  const prefetchProject = useCallback((p: Project) => {
    const ids = [...p.sessions].sort((a, b) => b.lastActivity - a.lastActivity).slice(0, MAX_PANES).map((s) => s.id);
    for (const id of ids) {
      if (!id || transcriptCache.has(id)) continue;
      fetch(`/api/bento/session/${id}`).then((r) => r.json()).then((d) => { if (d?.turns) cacheTranscript(id, d); }).catch(() => {});
    }
  }, []);
  const startTopic = (cwd: string, label?: string) => {
    const name = label || cwd.split("/").filter(Boolean).pop() || cwd;
    setPicker(false); setProject(null); setAddMenu(false);
    setNewTopic({ name, sessions: [], cwd, reqs: 0, tokens: 0, last: Date.now(), active: false, review: false, goals: [], latest: "", weight: 0 });
    setPanes([mkPane()]); // one fresh blank chat in the chosen folder (or home, for a folderless CLI)
    setActivePane(0); // same reason as openProject: a stale index from the topic you left is not a choice
    closedTabs.current = [];
  };
  // ── adding a chat, and the one moment isolation can happen ────────────────────────────────────
  // Every pane that is added by hand goes through here, because the decision to isolate can only be
  // taken now: a session's cwd is fixed at spawn, so a conversation that is already running cannot be
  // moved into its own checkout afterwards (§9).
  //
  // The rule is narrow on purpose. A BLANK second-or-later chat gets its own git worktree — that is
  // the collision the amber banner has been warning about for months, and the warning was never
  // actionable because acting on it meant leaving the dashboard for a CLI. Reopening an EXISTING
  // session never isolates; it carries whatever cwd that session was born in, which for a chat that
  // was isolated earlier is its worktree. Passing that through is not a nicety: `--resume` is scoped
  // to the directory the transcript is filed under, and resuming in the wrong one is §1's "No
  // conversation found with session ID".
  //
  // The await is deliberate. Adding the tab first and patching its cwd when the worktree lands would
  // leave a window where the pane is typable and still pointed at the shared checkout — the exact
  // collision this exists to prevent, now with the extra insult of having claimed to prevent it.
  // `task new` takes a few hundred ms; a click can wait that long.
  const addPane = useCallback(async (sid?: string, sessionCwd?: string) => {
    setAddMenu(false);
    if (panesRef.current >= MAX_PANES) return;
    let cwd = sid ? sessionCwd : undefined;
    if (!sid && panesRef.current >= 1) {
      const root = projCwdRef.current;
      if (root) {
        try {
          const d = await (await fetch("/api/worktree", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "isolate", cwd: root, label: "chat" }),
          })).json();
          if (d?.isolated?.dir) cwd = d.isolated.dir;
        } catch { /* isolation is an optimisation; a chat in the shared folder still works */ }
      }
    }
    setPanes((p) => {
      if (p.length >= MAX_PANES) return p;
      const pane: Pane = { ...mkPane(sid), ...(cwd && cwd !== projCwdRef.current ? { cwd } : {}) };
      setActivePane(p.length); // land on what you just opened, not on whatever was lit before
      setPaneView("tabs");
      return [...p, pane];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const closePanel = () => { setProject(null); setNewTopic(null); setPanes([]); setAddMenu(false); setOpenPanel(null); setActivePane(0); closedTabs.current = []; };
  // Tabs close the way browser tabs do: an ✕ on the tab, middle-click, ⌥W — and ⌥⇧T puts the last one
  // back. Where the analogy stops: closing a tab here is a VIEW action, not a lifecycle one. The
  // session keeps running server-side (nothing is sent to it; the pane just unsubscribes, and the
  // manager only reaps a session after IDLE_REAP_MS with no listeners) and it stays on the bento board
  // and in the ＋ menu. So this is "stop showing me this", never "end this chat" — which is what makes
  // a one-keystroke close safe enough to offer in the first place.
  //
  // The reopen stack is per-panel: it's cleared whenever the panel closes or another topic opens, so
  // ⌥⇧T can't drop a chat from a project you left into the one you're in.
  const closePane = (i: number) => {
    const n = panesRef.current;
    if (i < 0 || i >= n) return;
    // The last tab takes the panel with it, the way the last browser tab takes the window — the
    // alternative is panel chrome with nothing under it, which is not a state you can read.
    if (n === 1) { closePanel(); return; }
    setPanes((p) => {
      const gone = p[i];
      // Bounded: this is an undo affordance, not a session history. Eight is far more than the four a
      // panel can hold, so the cap can only ever discard something long forgotten.
      if (gone) closedTabs.current = [...closedTabs.current, { pane: gone, at: i }].slice(-8);
      // An auto-created worktree is a GUESS about what a chat was going to do, and a wrong guess has to
      // cost nothing — otherwise opening and closing three blank chats leaves three checkouts and three
      // branches behind forever, and the feature that was supposed to remove friction becomes a mess to
      // clean up by hand. The server only removes it when it is genuinely untouched: no commits ahead,
      // nothing uncommitted. Fire-and-forget, because a tab close must never wait on git — if it can't
      // be discarded it simply stays, and `task.mjs list` still shows it.
      if (gone?.cwd) {
        fetch("/api/worktree", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "discard", cwd: gone.cwd }),
        }).catch(() => {});
      }
      return p.filter((_, j) => j !== i);
    });
    // Closing a tab to the LEFT of the active one shifts every later index down by one, so the stored
    // index has to follow or the panel silently swaps to a neighbouring conversation — you closed tab 1
    // and tab 2's transcript is suddenly the one you're reading. The clamp effect above can't fix this:
    // it only knows the array got shorter, not which end lost the element. Closing the ACTIVE tab keeps
    // the index, which lands on its right-hand neighbour (clamped back if it was the last), matching
    // what every browser does.
    setActivePane((a) => (i < a ? a - 1 : a));
  };
  const reopenPane = () => {
    if (panes.length >= MAX_PANES) return;
    // Drop anything that's already back on screen instead of reopening a duplicate: two panes on one
    // session id would share a draft key and a live subscription and fight over both.
    const stack = closedTabs.current.filter((e) => !e.pane.sid || !panes.some((x) => x.sid === e.pane.sid));
    if (!stack.length) return;
    const entry = stack[stack.length - 1];
    closedTabs.current = stack.slice(0, -1);
    // Back where it was, not on the end — a restored tab that lands somewhere new isn't an undo.
    const at = Math.min(entry.at, panes.length);
    setPanes((p) => { const next = [...p]; next.splice(Math.min(at, p.length), 0, entry.pane); return next; });
    setActivePane(at);
  };
  // Read by the window key handler, which deliberately doesn't re-subscribe per render (same pattern as
  // focusRef/panesRef). Both handlers only ever call setters, so a render-old copy behaves identically.
  const tabActions = useRef({ close: closePane, reopen: reopenPane });
  tabActions.current = { close: closePane, reopen: reopenPane };
  // The active tab is an index into `panes`, so it's re-clamped whenever that array shrinks — closing
  // the active pane (or any pane before it) would otherwise leave the panel showing a different
  // conversation than the tab that's lit. `focusPane` above clamps for the render; this one settles the
  // stored value so the next open doesn't start on a stale index.
  useEffect(() => {
    setActivePane((i) => (panes.length ? Math.min(i, panes.length - 1) : 0));
  }, [panes.length]);
  // Crossing into 3+ panes in GRID view, the bento column stops being worth its width: three or four
  // transcripts side by side is where all the room needs to go, and the rail still shows every
  // project's live state. Latched, so this is a nudge and not a fight — un-rail it by hand and it
  // stays un-railed until you drop back under three and come up again.
  //
  // Gated on grid, because the heuristic predates tab view and `panes.length` stopped meaning what it
  // used to. It counts chats that are OPEN, not chats that are VISIBLE — and in tabs view exactly one
  // is visible however many are open. So opening a topic with four remembered chats railed the bento
  // instantly, every time, to buy width for three panes that were never on screen. That reads as the
  // app throwing your board away for no reason: you clicked a tile and the thing you clicked vanished.
  const autoRailed = useRef(false);
  useEffect(() => {
    if (paneView !== "grid" || panes.length < 3) { autoRailed.current = false; return; }
    if (!autoRailed.current && !rail) { autoRailed.current = true; setRail(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes.length, paneView]);
  // Remember the open panel + its layout so a refresh (or re-opening the topic) restores it exactly.
  useEffect(() => {
    const name = project || newTopic?.name || null;
    if (!name) return;
    // Same fallback chain as `proj`: a project filtered off the board must not persist `cwd: ""`, or a
    // refresh restores a panel whose composer is disabled (`submit` requires a cwd) with no way back.
    const cwd = newTopic ? newTopic.cwd : (projects.find((p) => p.name === name)?.cwd || openProj?.cwd || "");
    // Functional update: merge into the LATEST map, never a stale closure — otherwise a project switch
    // right after adding a pane would overwrite the just-persisted panes of the project we left.
    setOpenPanesMap((prev) => ({ ...prev, [name]: panes }));
    setOpenPanel({ name, cwd, topic: !!newTopic, panes });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panes, project, newTopic]);
  // Hand a new topic over to the real one the moment the board has it.
  //
  // A topic isn't a stored object (§5d) — `newTopic` is pure client state, a name and a cwd with a
  // permanently EMPTY `sessions` array, meant to hold the panel together only until the first chat
  // lands on disk. Nothing ever retired it. So the board would grow a proper tile for the folder while
  // the panel stayed in ad-hoc mode reading `sessions: []`: the chat switcher listed nothing, the ＋
  // menu offered no existing chats, `continueTarget` was always null, and a refresh restored a topic
  // panel with no route back to the conversation it had just started. That is the shape of the
  // complaint "the new chat lost my history" — the transcript was on disk and reachable from the tile
  // the whole time, but not from the panel that was actually open on it.
  //
  // Matched on CWD rather than name: the picker may label a topic something other than its folder
  // ("CLI" for a folderless session in $HOME) while a topic's name is derived as basename(cwd), so
  // adopting by name would strand exactly those. The `sessions.some` arm covers the other direction —
  // two different folders sharing a basename collapse into one topic whose `cwd` is only whichever
  // session sorted first (see `continueTarget`'s note on ~/work/api vs ~/personal/api).
  //
  // `panes` is deliberately untouched. A blank pane here is a chat the user is about to start, not a
  // gap to be filled — replacing it with the folder's recent chats would hijack a "new chat in a folder
  // that already has some", which is the ordinary case for the ＋ tile.
  useEffect(() => {
    if (!newTopic) return;
    const real = allProjects.find((p) => p.cwd === newTopic.cwd || p.sessions.some((s) => s.cwd === newTopic.cwd));
    if (!real) return;
    setNewTopic(null);
    setProject(real.name);
  }, [newTopic, allProjects]);
  // On first load, reopen whatever panel was open before a refresh (its ChatColumns then reattach to
  // any still-running session). Runs once, after the persisted value has hydrated from localStorage.
  useEffect(() => {
    if (restoredRef.current || !openPanel) return;
    restoredRef.current = true;
    const op = openPanel;
    if (op.topic) setNewTopic({ name: op.name, cwd: op.cwd, sessions: [], reqs: 0, tokens: 0, last: Date.now(), active: false, review: false, goals: [], latest: "", weight: 0 });
    else setProject(op.name);
    if (op.panes?.length) setPanes(asPanes(op.panes));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPanel]);

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
    // Escape closes the panel — but only when nothing nearer is entitled to it. It used to fire
    // unconditionally, above even the input/textarea guard further down, which made it the single most
    // destructive key in the app: pressing it with the caret in the composer tore down the whole panel
    // (measured, with a half-typed draft in the box), and `closePanel` also clears the persisted
    // `openPanel`, so a reload afterwards came back to the board rather than the conversation. On a
    // Vietnamese keyboard it's worse than a slip — Escape is how you dismiss an IME candidate list, so
    // the key you press *while writing a message* threw the message's window away.
    //
    // Four claims outrank the panel, in this order:
    //   defaultPrevented — a child (the lightbox's capture handler, the URL bar) already used it
    //   isComposing      — the IME owns the keystroke; it never reaches the app as intent
    //   a text field     — Escape means "cancel what I'm typing", never "close the window"
    //   an open overlay  — the folder picker and the flow canvas have their own way out
    if (e.key === "Escape") {
      if (e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      if (overlayRef.current) return;
      closePanel();
      return;
    }
    // ⌥1–4 selects a tab, ⌥0 flips to the grid — and it deliberately fires even while the composer has
    // focus: switching panes mid-draft is the whole point, and each pane's draft is persisted per
    // session (see `draft:` in ChatColumn), so nothing is lost.
    //
    // `e.code`, not `e.key`: Option+1 on a Mac layout produces "¡", and on a Vietnamese layout something
    // else again. The physical key is the only stable name for this chord.
    if (e.altKey && !e.metaKey && !e.ctrlKey && /^Digit[0-9]$/.test(e.code) && panesRef.current > 0) {
      const n = Number(e.code.slice(5));
      if (n === 0) { e.preventDefault(); setPaneView("grid"); return; }
      if (n <= panesRef.current) { e.preventDefault(); setPaneView("tabs"); setActivePane(n - 1); return; }
    }
    // ⌥W closes the tab you're reading, ⌥⇧T puts the last one back. The browser chords without the ⌘:
    // Chrome reserves ⌘W/⌘⇧T for its own tabs and won't let a page have them, and a shortcut that
    // sometimes closes the dashboard itself is worse than no shortcut. ⌥ also keeps them in the same
    // family as ⌥1–4/⌥0, which is already how you move between panes.
    //
    // `e.code` for the same reason as the digits: ⌥W emits "∑" on a Mac layout. Fires even inside the
    // composer, like ⌥1–4 — a draft is keyed by session (or pane key, when blank), so ⌥⇧T brings the
    // pane back with what you were typing still in it.
    if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === "KeyW" && !e.shiftKey && focusRef.current != null) {
      e.preventDefault(); tabActions.current.close(focusRef.current); return;
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey && e.shiftKey && e.code === "KeyT" && panesRef.current > 0) {
      e.preventDefault(); tabActions.current.reopen(); return;
    }
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
  }, [sel, projects, project, openProject, setPaneView]);
  useEffect(() => { window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onKey]);
  // draggable panel divider → persists width across sessions.
  //
  // The split is painted STRAIGHT TO THE DOM while dragging, and only committed to React state on
  // mouseup. Routing every mousemove through `setPanelW` re-rendered the entire bento — every tile is
  // a `motion.button` with `layout`, so each pixel of drag re-ran a spring layout animation — and the
  // divider visibly lagged the cursor. The variables it writes are the same `--lw`/`--rw` the render
  // sets, so the two can't disagree: the next React render simply overwrites them.
  //
  // Snapping is immediate and one-way-at-a-time: cross COLLAPSE_AT and the bento becomes the rail on
  // that very frame (no in-between column that can show neither a tile nor a rail), and coming back
  // out needs a *lower* threshold, or the divider chatters between states on a pixel of mouse jitter.
  useEffect(() => {
    if (!isDragging) return;
    const COLLAPSE_AT = 260, EXPAND_AT = 170;
    const move = (e: MouseEvent) => {
      const left = e.clientX; // the bento column ends where the divider is
      if (left < (railRef.current ? EXPAND_AT : COLLAPSE_AT)) { if (!railRef.current) setRail(true); return; }
      if (railRef.current) setRail(false);
      const pct = Math.min(80, Math.max(30, Math.round((1 - left / window.innerWidth) * 100)));
      pendingW.current = pct;
      const el = shellRef.current;
      if (el) { el.style.setProperty("--lw", `${100 - pct}%`); el.style.setProperty("--rw", `${pct}%`); }
    };
    const up = () => { setDragging(false); setPanelW(pendingW.current); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [isDragging, setPanelW, setRail]);

  const proj = project ? (projects.find((p) => p.name === project) || openProj) : newTopic;
  projCwdRef.current = proj?.cwd || "";
  const maxW = Math.max(1, ...projects.map((p) => p.weight)); // size ratio is vs the busiest project
  // The rail is only a state the bento can be *in* while a chat is open; with no panel it would just
  // be a worse grid. Every collapse path checks this, so there's one definition of "railed".
  const railed = !!proj && rail;
  // ⌘B / Ctrl+B toggles the bento between grid and rail — the shortcut every editor with a sidebar
  // already trained everyone to reach for. Both buttons name it in their tooltip, which is the only
  // reason a shortcut ever gets discovered.
  //
  // Guarded on the composer: this app's primary input is a textarea, and ⌘B is *also* "bold" muscle
  // memory. Stealing it mid-message would be the worst kind of shortcut — one that fires when you were
  // writing, not navigating. Only bound while a chat is open, since the rail is meaningless without one.
  useEffect(() => {
    if (!proj) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "b" && e.key !== "B") return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      e.preventDefault();
      setRail((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [proj, setRail]);
  // The flow canvas now replaces the whole grid, so its ONLY exit is its own ✕ — and the ✕ is inside the
  // one tile still rendered. Two ways out are therefore mandatory rather than nice: Escape, and an
  // auto-close if the search box filters its project away (otherwise typing in the still-visible header
  // leaves an empty screen with no control on it).
  useEffect(() => {
    if (!flowFor) return;
    if (!projects.some((p) => p.name === flowFor.project)) { setFlowFor(null); return; }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFlowFor(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flowFor, projects]);
  const busyCwds = useMemo(() => new Set(Object.values(liveAct).filter((x) => x.busy).map((x) => x.cwd)), [liveAct]);
  // How many live sessions sit in each working tree. Two agents in one checkout share a branch and an
  // index: one's `grep` returns code the other is halfway through rewriting, and whoever writes last
  // wins silently. Nothing in git or the SDK prevents this, so the least we can do is say it out loud.
  const cwdAgentCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const x of Object.values(liveAct)) m[x.cwd] = (m[x.cwd] || 0) + 1;
    return m;
  }, [liveAct]);
  // One assignment pass for every surface — the grid, the rail and the chat header all read this, so
  // a project is the same glyph everywhere and no two projects share one.
  const topicIcons = useMemo(
    () => assignIcons(projects.map((p) => p.name), Object.fromEntries(Object.entries(attachMap).map(([k, v]) => [k, v.icon]))),
    [projects, attachMap],
  );
  // The picker's Recent tab. Derived from `allProjects` — the UNFILTERED grouping — on purpose: the
  // search box and the date-window chip are view state for the BOARD, and letting either decide what
  // "where do I work" offers would mean a 24h window hid the project you opened the picker to reach.
  // Ranking (and the noise floor) is lib/topic-rank.ts; this only flattens it for rendering.
  const recentTopics = useMemo<RecentTopic[]>(
    () => rankTopics(allProjects, Date.now(), 8).map(({ topic, why, last }) => ({
      name: topic.name, cwd: topic.cwd, why, last,
      active: topic.active,
      // The board's assignment when the topic is on it (same glyph in both places), falling back to
      // the explicit override for one the window filtered out; ProjectIcon derives one otherwise.
      icon: topicIcons[topic.name] || attachMap[topic.name]?.icon,
    })),
    // `picker` is a dependency so the list is re-ranked when the modal OPENS rather than on a timer —
    // the score decays with wall-clock age, and re-running it on every render would be churn for a
    // number that can't visibly change between two frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allProjects, topicIcons, attachMap, picker],
  );

  return (
    <div ref={shellRef} className={`bg-bento flex h-screen w-screen overflow-hidden text-neutral-100 ${isDragging ? "cursor-col-resize select-none" : ""}`} style={{ ["--lw" as string]: proj ? `${100 - panelW}%` : "100%", ["--rw" as string]: proj ? `${panelW}%` : "0%" }}>
      {/* Left: bento — full grid, or the rail once the chat panel has taken the room. */}
      {railed ? (
        <div className={`hidden shrink-0 md:block ${isDragging ? "" : "transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"}`} style={{ width: RAIL_W }}>
          <BentoRail
            projects={projects} current={project} accent={accent} fmtNum={short} busyCwds={busyCwds} icons={topicIcons}
            onOpen={(p) => openProject(projects.find((x) => x.name === p.name)!)}
            onExpand={() => setRail(false)}
            onNew={() => setPicker(true)}
          />
        </div>
      ) : (
      // `@container`: the header's controls have to thin out by the BENTO COLUMN's width, not the
      // window's. At a 60% chat panel this column is ~500px on a wide display — plenty of window,
      // nowhere near enough column, and the old `md:` breakpoints happily overflowed it.
      <div className={`@container flex min-w-0 flex-col w-full md:w-[var(--lw)] ${proj ? "hidden md:flex" : ""} ${isDragging ? "" : "transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"}`}>
        {/* Only the full-width (no project open) case needs the bell's gutter: with a panel open the
            bento is a left column whose right edge is nowhere near the viewport corner. */}
        <header className={`flex flex-wrap items-center gap-x-3 gap-y-2 pb-2 pl-6 pt-5 ${proj ? "pr-6" : "pr-16"}`}>
          <span className="text-xl">🌸</span><h1 className="text-base font-semibold tracking-tight">Minami Bento</h1>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-400">{projects.length}</span>
          {enriching && <span className="flex items-center gap-1 text-[11px] text-neutral-500"><span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "#e8859b" }} />labeling…</span>}
          <div className="ml-auto flex items-center gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-24 @min-[620px]:w-32 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs outline-none transition-colors placeholder:text-neutral-600 focus:border-[var(--sakura)]" />
            <Segmented className="hidden @min-[700px]:flex" value={winDays} onChange={setWinDays}
              options={WINDOWS.map((w) => ({ value: w.days, label: w.label }))} />
            {!proj && <Segmented className="hidden md:flex" title="Sort projects" lead="↕" value={sortBy} onChange={setSortBy}
              options={[{ value: "recent", label: "Recent" }, { value: "busy", label: "Busy" }, { value: "name", label: "A–Z" }] as const} />}
            {/* Collapsing is discoverable here, not just by dragging the divider to the edge.
                This and the rail's expand button are deliberately the SAME control in two states —
                same icon family, same hover treatment, same ⌘B — because they are one toggle. It used
                to be a bare `⇤` here and a flower there: two glyphs, two locations, two metaphors, and
                nothing to tell you they were the same idea. */}
            {proj && <button onClick={() => setRail(true)} title="Collapse the bento to a rail  (⌘B)" aria-label="Collapse the bento to a rail"
              className="hidden rounded-lg border border-white/10 p-1.5 text-neutral-500 transition-colors hover:border-white/25 hover:text-neutral-200 md:block"><PanelLeftClose className="h-3.5 w-3.5" /></button>}
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
            // With the flow open, this becomes a single full-height cell rather than a grid: the canvas is
            // the screen, so it should get all of it instead of three fixed rows with dead space below.
            <div className={`grid gap-3 ${flowFor ? "h-full grid-cols-1 grid-rows-1" : `auto-rows-[10.5rem] [grid-auto-flow:dense] ${proj ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"}`}`}>
              {projects.map((p, i) => {
                const r = p.weight / maxW;
                const big = r >= 0.6, wide = !big && r >= 0.28;
                const span = big ? "col-span-2 row-span-2" : wide ? "col-span-2" : "";
                const pc = accent(p.name);
                const activeSel = i === sel && !proj;
                const age = Date.now() - p.last;
                // What this project is doing right now, if any live dashboard run is in its folder. Match
                // by cwd (not the session list) so a brand-new/trivial running session still shows.
                // Hoisted above `status` because it is now what decides whether anything animates.
                const la = Object.values(liveAct).find((x) => x.busy && x.cwd === p.cwd);
                // Animate ONLY while something is genuinely running — `la`, a turn in flight right now.
                //
                // It used to be `p.active` ("touched in the last 2 minutes") and `p.review` (a standing
                // state that can persist for days). Both kept a pulse going with nothing happening, so
                // the page never reached zero animations. That matters far more than it sounds:
                // measured, the cost of animation is a fixed per-frame tax for running a frame loop at
                // all, NOT a per-element cost — 0 elements = 1.3% CPU, 1 element = 12.6%, 41 = 17.1%.
                // One permanently pulsing dot therefore costs essentially the same as forty, and a
                // single "review" badge on a project last touched a week ago was enough to hold the
                // whole tab at ~12.6% forever.
                //
                // A pulse should mean "this is happening now". A standing state gets a static dot.
                const status = p.active ? { label: "live", tint: "#4ade80", pulse: !!la }
                  : p.review ? { label: "review", tint: "#f0a868", pulse: false }
                  : age < 12 * 3600e3 ? { label: "recent", tint: "#e8859b", pulse: false }
                  : age < 3 * 86400e3 ? { label: "active", tint: "#6c9cf5", pulse: false } : null;
                const bright = activeSel || project === p.name || p.active || (p.review && age < 7 * 86400e3);
                const dim = bright ? 1 : age < 86400e3 ? 0.9 : age < 3 * 86400e3 ? 0.72 : age < 7 * 86400e3 ? 0.56 : 0.42;
                // Expanded, this tile IS the canvas: it takes the full row and three rows of height, and
                // every other tile reflows around it. The motion is free — the wrapper already carries
                // framer's `layout`, so the span change animates and the neighbours slide, which is
                // exactly the bento behaviour asked for. A separate overlay would have covered them
                // instead of moving them.
                const flowing = flowFor?.project === p.name;
                // The flow screen is a screen, not a big tile: while it's open every OTHER tile is gone.
                // It used to reflow them around the expanded cell, which read as "one tile got bigger"
                // and left the rest competing for attention with the graph you opened to read.
                if (flowFor && !flowing) return null;
                return (
                  // The ⚙ has to be a SIBLING of the tile, not a child: the tile is itself a <button>,
                  // and a nested button is invalid HTML that React will happily render and the browser
                  // will then handle unpredictably (the inner click also fires the outer one). Hence
                  // this wrapper — it owns the grid span and the layout animation; the tile fills it.
                  // `@container` so the stats row below can drop items by TILE width rather than
                  // viewport width. The same tile renders at ~175px in the narrow column beside an open
                  // chat and at ~725px as the featured tile, and a viewport breakpoint can't tell those
                  // apart — it's the same viewport.
                  <motion.div layout key={p.name} className={`@container relative ${flowing ? "h-full min-h-0" : span}`}
                    initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: flowing ? 1 : dim, scale: 1 }}
                    whileHover={flowing ? undefined : { y: -4, opacity: 1 }} transition={{ type: "spring", stiffness: 320, damping: 30 }}>
                  {flowing ? (
                    <div className="h-full overflow-hidden rounded-[1.4rem] border border-[#c47f18]/40 bg-black/30">
                      <FlowCanvas sessionId={flowFor!.sid} project={p.name} busy={!!liveAct[flowFor!.sid]?.busy} onClose={() => setFlowFor(null)} />
                    </div>
                  ) : (
                  <>
                  <button data-i={i} onMouseEnter={() => { setSel(i); prefetchProject(p); }} onClick={() => openProject(p)}
                    style={{ background: `radial-gradient(120% 120% at 100% 0%, ${pc}22, rgba(255,255,255,0.03) 55%)` }}
                    // NO backdrop-blur here — it was measured as the single biggest CPU cost in the app.
                    // A `backdrop-filter` must re-blur everything beneath it whenever anything inside its
                    // box changes, and every live indicator (pulse dot, think-dots, activity shimmer,
                    // spinning icon) is a descendant of this tile. A 1.5px dot pulsing at 60fps therefore
                    // re-blurred the whole 610x348 card, 60 times a second, forever.
                    // Measured on an idle headless tab: 30.6% GPU with the blur, 4.6% without — same
                    // animations. And it bought nothing: behind a tile is a flat body colour and a very
                    // smooth radial gradient, and blurring a low-frequency image returns the same image.
                    className={`group relative flex h-full w-full flex-col overflow-hidden rounded-[1.4rem] border p-4 text-left ${
                      project === p.name ? "border-[var(--sakura)] ring-1 ring-[var(--sakura)]" : activeSel ? "border-[var(--sakura)]/70 ring-1 ring-[var(--sakura)] shadow-[0_22px_50px_-22px_rgba(232,133,155,0.6)]" : "border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_14px_34px_-18px_rgba(0,0,0,0.8)] hover:border-white/25"
                    }`}>
                    {p.active && <div className="pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full blur-2xl" style={{ background: pc + "44" }} />}
                    <div className="relative flex items-start justify-between">
                      {/* Same rule: tumble only while a turn is actually in flight, not for the two
                          minutes after one finished. See the note on `status` above. */}
                      <ProjectIcon name={p.name} icon={topicIcons[p.name]} big={big} active={!!la} />
                      {status && <span className="flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium" style={{ borderColor: status.tint + "55", color: status.tint, background: status.tint + "1e" }}>{status.pulse && <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: status.tint }} />}{status.label}</span>}
                    </div>
                    <p className={`relative mt-1.5 font-semibold tracking-tight ${big ? "text-xl" : "text-sm"}`}>{p.name}</p>
                    {/* Live activity — the SAME hint (phase-tinted dots + tool/file label) as the chat panel. */}
                    {la
                      ? <div className="relative mt-0.5 min-w-0"><ActivityLine compact hideTime busy activity={{ phase: la.phase as ActivityPhase, label: la.label, elapsedMs: 0, tools: [], tasks: [] }} elapsed={0} /></div>
                      : big && <p className="relative mt-0.5 line-clamp-1 text-xs text-neutral-400">↳ {p.latest}</p>}
                    {/* Tech icons on every tile. Small tiles show a compact row; the tile height (auto-rows)
                        was raised so this never clips the stats. */}
                    {(() => { const techs = attachMap[p.name]?.tech || []; const n = big ? 6 : 4; return techs.length > 0 && (
                      <div className="relative mt-1.5 flex items-center gap-1.5">
                        {techs.slice(0, n).map((s) => <BrandIcon key={s} slug={s} icons={techIcons} size={big ? 28 : 20} />)}
                        {techs.length > n && <span className="text-[10px] text-neutral-500">+{techs.length - n}</span>}
                      </div>
                    ); })()}
                    {/* Two things keep this row off the flow switch, and both are needed.
                        `pr-14` reserves the switch's footprint — it's `absolute bottom-3 right-3` and
                        has to be, because it's a button and this row lives inside another button,
                        which can't nest.
                        Padding alone wasn't enough: these spans were `shrink-0`, so at rail width they
                        simply overflowed the padding and ran UNDER the pill (`1.5M tok`, `8 chats`
                        struck through by it on 6 of 8 tiles). So the two softer stats also drop by
                        container width — request count is the one that always survives, because it's
                        the number the tile is sorted and sized by. */}
                    <div className="relative mt-auto flex flex-nowrap items-baseline gap-x-3 overflow-hidden pr-14">
                      <span className={`shrink-0 font-semibold tabular-nums ${big ? "text-2xl" : "text-base"}`}>{short(p.reqs)}<span className="ml-1 text-[10px] font-normal text-neutral-500">req</span></span>
                      <span className="hidden shrink-0 text-[11px] tabular-nums text-neutral-500 @min-[200px]:inline">{short(p.tokens)} tok</span>
                      <span className="hidden shrink-0 truncate text-[11px] text-neutral-600 @min-[280px]:inline">{p.sessions.length} chats</span>
                    </div>
                  </button>

                  {/* The switch. Visible at rest — the whole reason the previous two attempts went
                      unfound is that their control only appeared on hover, or lived in another screen. */}
                  {p.sessions.length > 0 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); const best = [...p.sessions].sort((a, b) => b.lastActivity - a.lastActivity); setFlowFor({ project: p.name, sid: (best.find((x) => x.active) || best[0]).id }); }}
                      title={`See ${p.name}'s journey — every ask, what it did, what's still open`}
                      className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-lg border border-white/15 bg-black/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400 transition-colors hover:border-[#c47f18]/60 hover:text-[#c47f18]">
                      <Workflow className="h-2.5 w-2.5" />flow
                    </button>
                  )}
                  </>
                  )}
                  </motion.div>
                );
              })}
              {/* Autopilot sits in the grid, not in a corner: the thing it promises is that work lands
                  without being asked for, and a promise you have to go looking for isn't kept.
                  Both of these are grid tiles like any other, so the flow screen hides them too. */}
              {!flowFor && <AutopilotTile />}

              {/* Blank tile: start a brand-new topic/chat in any folder. */}
              {!flowFor && <button onClick={() => setPicker(true)} title="Start a new topic in a folder"
                className="group flex flex-col items-center justify-center gap-1.5 rounded-[1.4rem] border border-dashed border-white/15 p-4 text-neutral-500 transition-colors hover:border-[var(--sakura)]/50 hover:text-[var(--sakura)]">
                <span className="text-2xl leading-none transition-transform group-hover:scale-110">＋</span>
                <span className="text-xs font-medium">New topic</span>
              </button>}
            </div>
          )}
        </div>
      </div>
      )}

      {/* draggable divider (persists panel width, and snaps the bento to the rail) */}
      {proj && <div onMouseDown={() => { pendingW.current = panelW; setDragging(true); }} onDoubleClick={() => setRail((v) => !v)}
        title={railed ? "Drag right to bring the bento back (or double-click)" : "Drag to resize · drag left to collapse the bento"}
        className="group/div relative hidden w-1.5 shrink-0 cursor-col-resize bg-white/[0.06] transition-colors hover:bg-[var(--sakura)]/60 md:block">
        {/* The handle. Every other way to switch views was something you had to already know: drag the
            divider to an invisible threshold, double-click a 6px strip, find ⌘B, or recognise a header
            icon. This is the one that's just *there*, on the seam between the two things it swaps —
            the same place Notion/Linear/VS Code put it, so it needs no learning.

            Deliberately always visible (dim), not hover-only: hover-only would hide it behind the very
            6px target that was already too small to find. It brightens on approach instead.

            stopPropagation on pointer-down is load-bearing — without it a click here also starts the
            parent's drag, and a double-click would fire the parent's toggle a second time, undoing it.

            Hidden mid-drag: it sits exactly where the cursor is, and a button flickering under a drag
            reads as breakage. Transitions only (no infinite animation) — a permanently animating
            element costs a fixed per-frame tax whatever its size, see KNOWLEDGE.md §12. */}
        {!isDragging && (
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setRail((v) => !v); }}
            title={railed ? "Show the bento board  (⌘B)" : "Collapse to the bento strip  (⌘B)"}
            aria-label={railed ? "Show the bento board" : "Collapse to the bento strip"}
            // z-20, deliberately BELOW the rail's own z-30 overlay. When the strip is hovered it slides
            // its names out to 208px — straight over this spot — and a chevron floating on top of that
            // panel would sit across the project chips. Ordering it under means the rail simply covers
            // it while open, which is also correct by intent: the expanded rail has its own way out, so
            // the handle has nothing to offer until you leave. Nothing to plumb between components.
            // Anchored at the seam's midline and extending RIGHT (no -translate-x-1/2), rather than
            // straddling it. Centred, a 20px pill spans 49–69px while the collapsed strip owns 0–56 —
            // so its left third rendered clipped behind the rail's own background. Growing rightward
            // puts it on the chat side of the seam in both modes, which is also where the eye expects a
            // panel handle, and it never underlaps the bento column at any width.
            className="absolute left-1/2 top-1/2 z-20 flex h-9 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-r-full border border-l-0 border-white/15 bg-neutral-800/95 text-neutral-400 opacity-40 shadow-lg transition-[opacity,color,border-color,transform] duration-150 hover:border-[var(--sakura)]/60 hover:text-neutral-100 hover:opacity-100 group-hover/div:opacity-100"
          >
            {/* Points where the bento is GOING, not where it is: right = it comes back, left = it tucks
                away. Chevron rather than the header's panel glyph because at 20px wide a direction is
                readable and a panel pictogram is not. */}
            {railed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>}

      {/* Right: chat SIDE PANEL. `flex-1` rather than a second percentage — the rail's width is in px,
          and 100%-minus-a-percentage can't express "everything the rail didn't take". */}
      {/* Same reason as the tile above, and this one is worse: at 768x800 it is the largest blurred
          surface in the app, and it hosts the think-dots and activity shimmer of every open pane — so
          a single bouncing dot invalidated ~614k pixels of blur every frame. It sits BESIDE the grid as
          a flex sibling, never over it, so there was never anything behind it but the page gradient. */}
      <div className={`min-h-0 bg-neutral-900/50 w-full ${railed ? "md:flex-1 md:w-auto" : "md:w-[var(--rw)]"} ${proj ? "flex flex-col" : "hidden"} ${isDragging ? "" : "transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"}`}>
        {proj && (
          <>
            {/* ── Panel chrome: a tab row that never moves, details that reveal BENEATH it ─────────
                The identity header — icon, project name, repo path, tech icons, counts — is read once
                a session and then occupies ~46px forever, so it collapses to nothing and slides back
                on hover (or on keyboard focus, or pinned).
                It reveals BELOW the tabs, not above them, and that ordering is the whole fix. Above,
                every reveal pushed the tab row down by the header's full height — so the row you were
                aiming at slid out from under the cursor at the exact moment hovering it triggered the
                reveal, and the click landed on the wrong tab or on nothing. The tabs are the part you
                operate, so they get the fixed position; chrome that is merely nice to have expands
                downward into space that nothing is anchored to.
                Still one `group`, so reaching anywhere in the chrome reveals the header. */}
            <div className="group/chrome relative shrink-0 border-b border-white/10">
              {/* The permanent row: every pane as a tab, then the view switch and the panel controls.
                  The tabs render in BOTH views — in grid view none is lit, and clicking one is how you
                  drop back into reading that pane. One row that never moves beats two that swap. */}
              {/* The row's vertical padding lives on the SCROLLER, not here. `overflow-x-auto` clips at
                  the padding box, so those 6px are the only place the selected tab's tail can hang
                  without being cut off — and keeping it symmetric means `items-center` still aligns the
                  tabs with the ＋/esc controls beside them. Total row height is unchanged. */}
              <div className="flex items-center gap-1 pl-2 pr-14">
                <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {panes.map((pn, i) => {
                    const s = pn.sid ? proj.sessions.find((x) => x.id === pn.sid) : undefined;
                    const la = pn.sid ? liveAct[pn.sid] : undefined;
                    // Server-keyed activity wins wherever it exists; the pane's own stream only fills the
                    // gap before a session id exists (see `paneAct`), so the two can never disagree.
                    const act = la ? { busy: la.busy, phase: la.phase as ActivityPhase, label: la.label } : paneAct[pn.key];
                    const phase = act?.phase || "idle";
                    // `awaiting` is blocked on YOU — it gets the loudest colour and NO motion, same rule
                    // as `.activity-idle`: animating next to "waiting for your approval" claims work is
                    // happening when nothing moves until you click.
                    const running = !!act?.busy && phase !== "awaiting";
                    const wants = !!act?.busy && phase === "awaiting";
                    const tint = PHASE_TINT[phase] || PHASE_TINT.thinking;
                    const on = i === focusPane;
                    return (
                      // A div wrapping two buttons, not one button with a nested ✕: a button inside a
                      // button is invalid HTML, and the browser's recovery is to drop the inner one —
                      // so the close target would have selected the tab instead of closing it.
                      <div key={pn.key}
                        // ── FILL means selected. TINT means working. One channel each ────────────────
                        // These are orthogonal facts and they used to share both channels — border
                        // colour and background wash — so the tab could only express one of them.
                        // Worse, they shared a HUE: `PHASE_TINT.thinking` is literally `var(--sakura)`,
                        // the accent selection uses, so "reading this one" was `sakura @60/10%` and
                        // "thinking" was `sakura @55/9%`. Five percent of border alpha is not a
                        // distinction, and `TOOL_TINT.exec`/`ask` are that same pink again. Recolouring
                        // the phase map was the wrong lever — those tints are shared with the tiles and
                        // the transcript, and would collide again on the next accent — so selection
                        // moves off colour instead: it is the only FILLED tab, and the only one with a
                        // tail. A working tab is outlined and tinted, never filled.
                        className={`group/tab relative flex min-w-0 shrink items-center gap-1.5 rounded-lg border py-1 pl-2 pr-1 text-[11px] transition-colors ${
                          on ? "border-[var(--sakura)] bg-[var(--sakura)]/[0.18] text-neutral-50"
                            // An unfocused tab is `text-neutral-500` on a hairline border — i.e. it reads
                            // as disabled, which is wrong for the one that's mid-turn. Tinting the border
                            // and the label (not just the dot) is what makes a running chat findable in a
                            // glance at the row.
                            : running || wants ? "text-neutral-200 hover:text-neutral-100"
                            : "border-white/10 text-neutral-500 hover:border-white/25 hover:text-neutral-300"}`}
                        // color-mix rather than an `#rrggbbaa` concat: PHASE_TINT holds `var(--sakura)`
                        // for `thinking`, and appending an alpha suffix to a var() reference yields an
                        // invalid colour that silently drops the border entirely.
                        style={!on && (running || wants) ? {
                          borderColor: `color-mix(in srgb, ${tint} 55%, transparent)`,
                        } : undefined}
                        // Middle-click closes, as it has on every browser tab for twenty years. On
                        // mousedown rather than auxclick: auxclick fires after the middle button has
                        // already armed the scroll-anchor cursor, so it's too late to preventDefault it.
                        onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closePane(i); } }}>
                        <button onClick={() => { setPaneView("tabs"); setActivePane(i); }}
                          title={`${s ? titleOf(s) : "New chat"}  (⌥${i + 1})${act?.label ? ` — ${act.label}` : ""}`}
                          className="flex min-w-0 flex-1 items-center gap-1.5">
                          <span className={`shrink-0 tabular-nums text-[9px] ${on ? "text-[var(--sakura)]" : "text-neutral-600"}`}>⌥{i + 1}</span>
                          {/* The slot is ALWAYS rendered, even at rest. Mounting the dot on the first
                              busy frame shifted the label 12px sideways every time a turn started or
                              ended — on the tab you were about to click.
                              Colour carries the phase (thinking / tool / awaiting / retrying), so the
                              row answers "what is it doing", not merely "is something happening".
                              Only a genuinely running turn animates — same rule as the bento tiles, and
                              for the same measured reason (a permanent pulse costs a frame loop forever);
                              at rest this is a static grey dot with no animation attached. */}
                          <span className="relative flex h-1.5 w-1.5 shrink-0 items-center justify-center">
                            {running && <span className="tab-live-ring absolute inset-0 rounded-full" style={{ background: tint }} />}
                            <span className="h-1.5 w-1.5 rounded-full transition-colors" style={{ background: tint, opacity: act?.busy ? 1 : 0.3 }} />
                          </span>
                          <span className="truncate">{s ? titleOf(s) : "New chat"}</span>
                        </button>
                        {/* Always rendered, only sometimes visible. Revealing it on hover ALONE would
                            widen the tab at the moment you reached for it and slide the label out from
                            under the cursor — the same mis-click that moved the header peek below this
                            row. Reserving the width costs 18px per tab, at a hard maximum of four. */}
                        <button onClick={() => closePane(i)}
                          title={panes.length === 1 ? "Close this chat (⌥W) — closes the panel; the session keeps running" : "Close this chat (⌥W) — the session keeps running"}
                          className={`shrink-0 rounded px-1 leading-none transition-opacity hover:bg-white/15 hover:text-neutral-100 ${
                            on ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100"}`}>✕</button>
                        {/* The tab-wide half of the running signal (globals.css). Outside the label
                            button on purpose: it spans the whole tab, close box included, so it reads
                            as a property of the chat rather than of its title. */}
                        {running && <span className="tab-run-sweep pointer-events-none" style={{ ["--run-tint" as string]: tint }} />}
                        {/* The tail. Only in tabs view — `focusPane` is null in grid, where nothing is
                            lit because you are reading all four and there is no "this one" to point at. */}
                        {on && <span className="tab-caret pointer-events-none" aria-hidden />}
                      </div>
                    );
                  })}
                </div>
                {/* One switch for the whole panel, replacing the per-pane ⤢. A maximise button on each
                    pane asked "which of these do you want bigger" four times over; this asks "how do you
                    want to read" once, which is the actual decision. */}
                {panes.length > 1 && (
                  <div className="flex shrink-0 items-center rounded-lg border border-white/10 p-0.5" title="Read one chat at a time (⌥1–4), or watch all of them at once (⌥0)">
                    {([["tabs", "tabs"], ["grid", "grid"]] as const).map(([k, label]) => (
                      <button key={k} onClick={() => setPaneView(k)}
                        className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors ${
                          paneView === k ? "bg-[var(--sakura)] text-white" : "text-neutral-500 hover:text-neutral-300"}`}>
                        {k === "grid" && <Grid2x2 className="h-2.5 w-2.5" />}{label}
                      </button>
                    ))}
                  </div>
                )}
                {/* Add a chat to the mix: a blank one, or any of the topic's other sessions. */}
                <div className="relative shrink-0">
                  {/* The only place ⌥⇧T is named: reopen lives next to add because "put it back" and
                      "open another" are the same reach, and a shortcut nobody is told about is one
                      nobody uses. */}
                  <button onClick={() => setAddMenu((v) => !v)} disabled={panes.length >= MAX_PANES} title="Add a chat — ⌥⇧T reopens the last one you closed"
                    className="rounded-lg border border-[var(--sakura)]/40 px-2 py-1 text-[11px] text-[var(--sakura)] transition-colors hover:bg-[var(--sakura)]/10 disabled:opacity-40">＋</button>
                  {addMenu && (
                    <>
                      <div className="fixed inset-0 z-20" onClick={() => setAddMenu(false)} />
                      {/* z-30, above the hiding header's z-20. This menu lives INSIDE `group/chrome`, so
                          moving the pointer onto it counts as hovering the chrome and unfurls the header
                          panel — which, at the same z-20 and later in DOM order, painted over the menu's
                          top 57px. That is the first row ("New blank chat"), so the menu opened with its
                          most-used item already unclickable. The suppression below stops the unfurl; this
                          raise is what makes the stacking correct regardless of it. */}
                      <div className="absolute right-0 top-full z-30 mt-1 max-h-96 w-72 overflow-y-auto rounded-xl border border-white/10 bg-neutral-900 p-1 shadow-2xl">
                        <button onClick={() => addPane()} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/10"><span className="text-[var(--sakura)]">＋</span> New blank chat</button>
                        {proj.sessions.some((s) => !panes.some((pn) => pn.sid === s.id)) && <div className="my-1 border-t border-white/10" />}
                        {[...proj.sessions].sort((a, b) => b.lastActivity - a.lastActivity).filter((s) => !panes.some((pn) => pn.sid === s.id)).map((s) => (
                          <button key={s.id} onClick={() => addPane(s.id, s.cwd)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/10">
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.active ? "#4ade80" : TIER_TINT[s.tier] }} />
                            <span className="min-w-0 flex-1"><span className="block truncate text-xs">{titleOf(s)}</span><span className="block truncate text-[10px] text-neutral-500">{goalOf(s)} · {ago(s.lastActivity)}</span></span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
                <button onClick={closePanel} title="Close this project (esc)" className="shrink-0 rounded-md px-2 py-1 text-xs text-neutral-500 transition-colors hover:bg-white/10">esc ✕</button>
              </div>

              {/* The grid-rows 0fr→1fr trick, not max-height: it animates to the content's REAL height,
                  so the header can't be clipped by a guessed max nor leave dead space under a short one.
                  Positioning depends on WHY it's open, because the two cases want opposite things.
                  Hover is a peek: absolute, so it floats over the first rows of the transcript and its
                  reveal moves nothing — displacing every control below it is exactly the bug this is
                  fixing, and re-introducing it one element lower would be no better. Pinned is a
                  decision to keep it: static, so it reserves its own space and never sits on the text
                  you pinned it in order to read alongside. */}
              <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${
                headerPinned ? "grid-rows-[1fr]"
                  // While the add-chat menu is open, the hover peek is OFF. The menu is a descendant of
                  // `group/chrome`, so opening it and reaching for a row is itself a hover of the chrome
                  // — the peek would unfurl behind the menu every single time you used it. A peek is for
                  // when you want the header; here you have already said you want the chat list, and
                  // `focus-within` has to go too or focusing the menu re-triggers it.
                  : `absolute inset-x-0 top-full z-20 grid-rows-[0fr] ${addMenu ? "" : "group-hover/chrome:grid-rows-[1fr] group-focus-within/chrome:grid-rows-[1fr]"}`}`}>
                <div className="overflow-hidden">
                  {/* pr-14, not px-4: the notification bell is fixed to the viewport's top-right corner
                      and would otherwise sit on top of these controls. Reserving the gutter keeps the
                      two apart without the bell having to know anything about this panel.
                      Opaque background + border: it now overlays the transcript rather than occupying
                      its own space, so it has to be readable against whatever text is behind it. */}
                  <div className="flex items-center gap-3 border-b border-white/10 bg-neutral-900 py-2 pl-4 pr-14 shadow-lg">
                    {/* Title, repo link (full + clickable) and tech icons — one scrollable row so a long
                        repo path stays complete without pushing the counts off-screen. */}
                    <div className="flex min-w-0 flex-1 items-center gap-3 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                      <button onClick={closePanel} className="group flex shrink-0 items-center gap-2 rounded-lg px-1 py-0.5 text-sm transition-colors hover:bg-white/10">
                        <ProjectIcon name={proj.name} icon={topicIcons[proj.name]} /><span className="font-semibold">{proj.name}</span>
                      </button>
                      <AttachBar inline cwd={proj.cwd} project={proj.name} />
                    </div>
                    <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-[11px] text-neutral-400">{panes.length}/{MAX_PANES} open · {proj.sessions.length} chats</span>
                    {/* Auto-hiding chrome is only tolerable if you can stop it. Pinning is the escape
                        hatch for "I'm reading this repo path and it keeps sliding away". */}
                    <button onClick={() => setHeaderPinned((v) => !v)} title={headerPinned ? "Unpin — let this header hide again" : "Pin this header open"}
                      className={`shrink-0 rounded-md px-1.5 py-1 text-[11px] transition-colors ${headerPinned ? "text-[var(--sakura)]" : "text-neutral-600 hover:text-neutral-300"}`}>
                      {headerPinned ? "📌" : "📍"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
            {/* Up to 4 chats in a 2×2 grid — like managing windows on a foldable. With one focused it
                becomes a single cell: the others are still HERE, just `display:none` (see `collapsed`),
                which keeps their EventSource attached and their streamed turns intact. Unmounting them
                would tear down four live connections every time you zoomed into one. */}
            {/* Tighter in grid view, on purpose: grid view exists to show you all four at once, so every
                px of gap and padding is px not spent on the thing it's for. 8px gaps and 8px of panel
                padding cost ~24px of each column's width and height in a 2×2 — at four panes that was
                most of a line of transcript per pane, spent on air. Tabs view has one pane and can
                afford the breathing room. */}
            <div className={`grid min-h-0 flex-1 ${focusPane != null ? "gap-2 p-2" : "gap-1 p-1"}`}
              style={{ gridTemplateColumns: focusPane != null || panes.length <= 1 ? "1fr" : "repeat(2, minmax(0,1fr))", gridAutoRows: "minmax(0, 1fr)" }}>
              {panes.map((pane, idx) => (
                // Keyed by pane.key PLUS switchGen (not sessionId): the "own live turn just got a real
                // session id" transition (onLive below) must NOT remount — that would tear down the
                // in-flight EventSource/turns mid-stream for no reason. An explicit user pick of a
                // DIFFERENT existing session (onPick below) SHOULD remount — see onPick's comment.
                <ChatColumn key={`${pane.key}:${pane.switchGen || 0}`} paneKey={pane.key} sessionId={pane.sid} sessions={proj.sessions} cwd={pane.cwd || proj.cwd} isolated={!!pane.cwd} idx={idx} count={panes.length} showTools={showTools} agentsHere={cwdAgentCount[pane.cwd || proj.cwd] || 0}
                  collapsed={focusPane != null && focusPane !== idx} focused={focusPane === idx}
                  // "Give this pane the room it needs" — used by the side slot when it's too cramped to
                  // open here. It selects the pane AND switches to tabs, since tabs view is the only
                  // place a browser or file preview has room to be worth opening.
                  onFocus={() => { setPaneView("tabs"); setActivePane(idx); }}
                  // Opening the flow from a chat raises the canvas in the BENTO column, and un-rails the
                  // bento if it was collapsed — otherwise the click would appear to do nothing at all.
                  onOpenFlow={(sid) => { if (!sid) return; setRail(false); setFlowFor({ project: proj.name, sid }); }}
                  openSids={panes.map((p) => p.sid).filter(Boolean)}
                  onPick={(nid) => setPanes((p) => p.map((x, j) => (j === idx ? { ...x, sid: nid, switchGen: (x.switchGen || 0) + 1 } : x)))}
                  onLive={(sid) => setPanes((p) => p.map((x, j) => (j === idx && x.sid !== sid ? { ...x, sid } : x)))}
                  // Lets this pane's tab show its phase before the session id exists — see `paneAct`.
                  onBusy={reportPaneAct}
                  // Same path as the tab's ✕ and ⌥W, so all three agree about which tab gains focus
                  // afterwards and all three feed the ⌥⇧T stack.
                  onClose={() => closePane(idx)} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Out-of-pane alerts (deploys, worktree builds). Distinct from the per-pane notify() calls,
          which are transient by design — these have bodies worth re-reading.

          Anchored to the VIEWPORT, not to the bento. It used to sit in the bento header with
          `ml-auto`, i.e. right-aligned inside a column whose width is a user preference — so it slid
          770px left the moment a project opened (measured: x=992 → x=222), and vanished outright in
          rail mode, because that header isn't rendered at all there. A control you reach for by
          muscle memory cannot live in a container that moves; alerts belong to the app, not to the
          panel you happen to have open.

          z-[60] is deliberate: above the panel/bento headers (z-20/z-30) so it's always clickable,
          below the lightbox and folder picker (z-[90]/z-[100]) so a modal still covers it. */}
      <div className="fixed right-3 top-2.5 z-[60]"><NotificationBell /></div>

      {picker && <FolderPicker onPick={startTopic} onClose={() => setPicker(false)} recents={recentTopics} />}
    </div>
  );
}

// Absolute paths to image files, mentioned anywhere in a message. Must stay in step with
// IMAGE_PATH in lib/agent/images.ts, which is what decides which of these actually get sent to the
// model — a path that renders here but isn't inlined there (or vice versa) is a lie either way.
const IMAGE_REF = /(?:^|[\s(])"(\/[^"]+\.(?:png|jpe?g|gif|webp))"|(?:^|[\s(])(\/[^\s"'()]+\.(?:png|jpe?g|gif|webp))(?=[\s)]|$)/gi;

/** Thumbnails for the images a turn refers to. Covers pasted screenshots and folder-picker
 *  attachments identically, because both are just a path in the text by the time they land here. */
const ImageRefs = memo(function ImageRefs({ text }: { text: string }) {
  const paths = useMemo(() => {
    if (!text) return [];
    const out: string[] = [];
    // Group 1 is the quoted form, group 2 the bare one — exactly one is set per match.
    for (const m of text.matchAll(IMAGE_REF)) { const p = m[1] || m[2]; if (p && !out.includes(p)) out.push(p); }
    return out.slice(0, 5);
  }, [text]);
  if (paths.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {paths.map((p) => (
        <a key={p} href={`/api/fs/image?path=${encodeURIComponent(p)}`} target="_blank" rel="noreferrer"
          title={p} className="block overflow-hidden rounded-lg border border-white/10 transition-colors hover:border-white/30">
          {/* A path can point at something deleted (pastes are pruned after 24h) or unreadable. Drop the
              whole chip rather than leaving a broken-image glyph in the transcript. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/fs/image?path=${encodeURIComponent(p)}`} alt={p.split("/").pop() || "image"}
            // Small on purpose: four panes share this grid, and an attachment is a reminder of what
            // you sent, not the subject of the pane. Click through for full size.
            className="max-h-20 w-auto object-contain"
            onError={(e) => { const el = e.currentTarget.closest("a"); if (el) el.style.display = "none"; }} />
        </a>
      ))}
    </div>
  );
});

// One message in the transcript. Extracted and memoised for one reason: a streaming reply updates the
// LAST turn's text ~30×/second, and re-rendering the whole list on every token means re-walking every
// earlier turn's tool rows, badges and images too. `Markdown` was already memoised, which hid how much
// of the cost sat around it. With the volatile props confined to the live row, everything above it is
// prop-identical between renders and React skips it outright.
type LiveBits = { notices: Notice[]; activity: ActivityState; elapsed: number; busy: boolean };
// The created/changed hints under a message. Every write in the turn, de-duplicated — Claude often
// applies several Edits to one file in a single turn, and five identical chips for one file is worse
// than none. Reads are excluded (see writtenBy): a chip per file merely looked at would bury the ones
// that actually changed.
const FileChips = memo(function FileChips({ tools, onOpen }: { tools: AgentToolCall[]; onOpen: (p: string) => void }) {
  const written = useMemo(() => {
    const seen = new Map<string, { path: string; name: string; verb: string }>();
    for (const t of tools) {
      const w = writtenBy(t);
      // First write wins the verb: created-then-edited in one turn is still a creation.
      if (w && !seen.has(w.path)) seen.set(w.path, w);
    }
    return [...seen.values()];
  }, [tools]);
  if (!written.length) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {written.map((w) => {
        const tint = w.verb === "created" ? "#1f8a5c" : "#c47f18";
        return (
          <button key={w.path} onClick={() => onOpen(w.path)} title={`${w.verb} · ${w.path}`}
            className="flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition-colors hover:bg-white/[0.06]"
            style={{ borderColor: tint + "55", background: tint + "12" }}>
            <FileText className="h-3 w-3 shrink-0" style={{ color: tint }} />
            <span className="font-mono text-[10.5px]" style={{ color: tint }}>{w.verb}</span>
            <span className="min-w-0 truncate font-mono text-[10.5px] text-neutral-300">{w.name}</span>
          </button>
        );
      })}
    </div>
  );
});

/** The shared side slot's tab strip. Only rendered when both panels have something to show. */
/** The three session controls — the brake, Plan vs Code, and the approval level.
 *
 *  Extracted for exactly one reason: a cramped pane folds this whole row into a single `code · bypass`
 *  pill, and the pill's fold-out has to be THE controls, not a second set of them. The approval level
 *  is the most dangerous thing in this UI to be wrong about (see `perm` in ChatColumn); two renderings
 *  of it, drifting apart, is the failure mode worth spending a component to make impossible.
 */
function ModeControls({ hold, onHold, planning, onPlan, perm, onPerm }: {
  hold: boolean; onHold: (v: boolean) => void;
  planning: boolean; onPlan: (v: boolean) => void;
  perm: Exclude<AgentMode, "plan">; onPerm: (m: Exclude<AgentMode, "plan">) => void;
}) {
  return (
    <>
      {/* The brake. It lived in the flow panel's header, which is gone — and it is a SESSION control
          (like Plan/Code and the approval level), not a property of a view, so this row is where it
          always belonged. Armed, the server parks the next tool call instead of auto-approving it;
          the pane's own permission prompt is then what you answer. */}
      {/* Padded as `border p-0.5` around an inner `px-2 py-0.5` rather than padded directly, so its box
          metrics are identical to a one-option Segmented. Styled the short way it sat 4px shorter than
          the two controls beside it, which is the kind of difference you see without being able to
          name — the row looked misaligned rather than misjudged. */}
      <button onClick={() => onHold(!hold)}
        title={hold ? "Release — stop parking tool calls at the gate" : "Pause after the current step — park the next tool call for review"}
        className={`flex shrink-0 items-center rounded-lg border p-0.5 transition-colors ${
          hold ? "border-[#c47f18]/60 bg-[#c47f18]/15 text-[#c47f18]" : "border-white/10 text-neutral-400 hover:text-neutral-200"}`}>
        <span className="rounded-md px-2 py-0.5 text-[10px] font-medium">{hold ? "▶ release" : "⏸ pause"}</span>
      </button>
      {/* Plan vs Code — default Code. Plan proposes without applying. */}
      <Segmented size="sm" title="Plan proposes changes first; Code executes"
        value={planning} onChange={onPlan}
        options={[{ value: false, label: "Code" }, { value: true, label: "Plan" }] as const} />
      {/* Approval level (only meaningful in Code mode). "bypass" auto-runs everything — hence `good`,
          the one tone that isn't the accent: it must not read as an ordinary selection. These were
          three loose bordered pills next to two bordered boxes, so one row carried three different
          container shapes; as a segment group the row has one. */}
      <Segmented size="sm" disabled={planning} value={perm} onChange={onPerm}
        options={(["default", "acceptEdits", "bypassPermissions"] as const).map((m) => ({
          value: m, label: PERM_LABEL[m], title: MODE_HINT[m],
          tone: m === "bypassPermissions" ? ("good" as const) : undefined,
        }))} />
    </>
  );
}

function SlotTabs({ slot, onPick, fileCount }: { slot: "browser" | "file"; onPick: (s: "browser" | "file") => void; fileCount: number }) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-white/10 bg-black/20 px-1.5 py-1">
      {([["browser", "Browser", Chrome], ["file", "Files", FileText]] as const).map(([id, label, Icon]) => (
        <button key={id} onClick={() => onPick(id)}
          className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] transition-colors ${
            slot === id ? "bg-white/10 text-neutral-100" : "text-neutral-500 hover:text-neutral-300"}`}>
          <Icon className="h-3 w-3" />{label}
          {id === "file" && fileCount > 0 && <span className="text-[9px] tabular-nums text-neutral-500">{fileCount}</span>}
        </button>
      ))}
    </div>
  );
}

const TurnRow = memo(function TurnRow({ turn: t, showTools, shots, onOpenShot, onOpenFile, live, sameSpeaker }: {
  turn: RenderTurn;
  showTools: boolean;
  /** Previous row was the same role — suppress the repeated speaker label. Derived at the call site
   *  (a plain boolean) so TurnRow's memo comparison stays shallow. */
  sameSpeaker: boolean;
  shots: BrowserState["shots"];
  onOpenShot: (i: number) => void;
  /** Stable identity required — TurnRow is memoised, and a fresh closure here would defeat it for
   *  every row on every render. Supplied as a useCallback by ChatColumn. */
  onOpenFile: (path: string) => void;
  /** Non-null only for the one row that is currently streaming. */
  live: LiveBits | null;
}) {
  return (
          // Inline style, not a class: `space-y-*` on the parent writes margin-top via `& > * + *`,
          // whose specificity beats any utility class this element could carry. An inline declaration
          // is the only thing that reliably wins, and it's also the only place the density-derived
          // --turn-gap can be arithmetic'd.
          <div style={sameSpeaker ? { marginTop: "calc(var(--turn-gap, 1.5rem) * -0.55)" } : undefined}
            className={`flex flex-col ${t.role === "user" ? "items-end" : "items-start"}`}>
            {/* Only when the speaker CHANGES. One assistant turn commonly renders as several rows (a
                paragraph, a tool run, another paragraph), and labelling each one stacked five
                identical CLAUDE headers down a single reply — the label stopped separating speakers
                and became texture. Suppressed, the run reads as one utterance, which is what it is. */}
            {!sameSpeaker && (
              <span className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-[0.09em] text-neutral-500">{t.role === "user" ? "You" : "Claude"}</span>
            )}
            <div className={t.role === "user"
              ? "max-w-[85%] rounded-2xl border border-white/15 px-4 py-3 text-[15px] leading-[1.65] text-neutral-100 [overflow-wrap:anywhere]"
              : "w-full text-[15px] leading-[1.75] text-neutral-100/95 [overflow-wrap:anywhere]"}>
              {t.role === "assistant" && t.thinking && <ThoughtBlock text={t.thinking} live={!!t.streaming && !t.text} />}
              {t.text && <Markdown text={t.text} />}
              {/* Images the turn REFERS TO, rendered from their paths. Deliberately derived from the
                  text rather than from message content: `claude-sessions.ts` keeps only text blocks
                  when it rebuilds a user turn from disk, so an inline image block would render live
                  and then vanish on the next reload. A path survives, so this survives. It also means
                  a pasted screenshot and a folder-picker attachment display identically, with one
                  renderer and no second source of truth. */}
              <ImageRefs text={t.text} />
              {/* What this turn actually did to the filesystem, as chips you can open.
                  Deliberately OUTSIDE the `showTools` gate below: "which files changed" is the
                  outcome of a turn, not tool noise, and it's the one thing worth seeing even when
                  the tool details are collapsed. A path in a JSON blob is not a preview. */}
              <FileChips tools={t.tools} onOpen={onOpenFile} />
              {/* Stays visible for the WHOLE turn. It used to collapse to a 2px caret as soon as any
                  text existed, so a long tool run after the first paragraph looked like a dead pane. */}
              {live && (
                <div className={`flex flex-col gap-1.5 ${t.text ? "mt-2" : ""}`}>
                  <NoticeStrip notices={live.notices} />
                  <ActivityLine busy={live.busy} activity={live.activity} elapsed={live.elapsed} notices={live.notices} />
                </div>
              )}
              {showTools && t.tools.map((tool, j) => {
                const cat = toolCategory(tool.name);
                const tint = TOOL_TINT[cat];
                const Icon = TOOL_ICON[cat];
                // Result content, not just the input — a browser tool's screenshot lives here, and any
                // tool's text result is now worth showing instead of just what was asked of it.
                const images = tool.output?.blocks.filter((b): b is Extract<ToolOutputBlock, { type: "image" }> => b.type === "image") || [];
                const textOut = tool.output?.blocks.find((b): b is Extract<ToolOutputBlock, { type: "text" }> => b.type === "text");
                return (
                  <details key={tool.id || j} className="mt-2 rounded-lg border-l-2 bg-black/40 px-2.5 py-1.5 text-xs" style={{ borderLeftColor: tint + "80", borderTop: "1px solid rgba(255,255,255,0.06)", borderRight: "1px solid rgba(255,255,255,0.06)", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    <summary className="flex cursor-pointer select-none items-center gap-1.5 text-neutral-400">
                      <Icon className="h-3 w-3 shrink-0" style={{ color: tint }} strokeWidth={2.25} />
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: tint + "1e", color: tint }}>{tool.name}</span>
                      <span className="min-w-0 flex-1 truncate text-neutral-500">{activityLabel(tool.name, tool.input)}</span>
                      {/* Per-call outcome: without it every tool in the transcript looks in-flight. */}
                      {tool.done
                        ? <span className="shrink-0 text-[10px]" style={{ color: tool.ok ? "#4ade80" : "#ef7c7c" }}>{tool.ok ? "✓" : "✗"}{tool.ms != null ? ` ${fmtElapsed(tool.ms)}` : ""}</span>
                        : <span className="shrink-0 text-[10px] text-neutral-600">running…</span>}
                    </summary>
                    {/* Browser calls get Claude Code's compact one-field summary instead of a wall of
                        input JSON (`Claude in Chrome[navigate] example.com`). The JSON is still one
                        click away — this row is inside a <details> — but the default view stays
                        scannable across a 30-action QA pass. */}
                    {cat === "browser" && browserArg(tool.name, tool.input) && (
                      <p className="mt-1.5 font-mono text-[11px] text-neutral-400">
                        <span className="text-neutral-500">{browserVerb(tool.name)}</span> {browserArg(tool.name, tool.input)}
                      </p>
                    )}
                    <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-neutral-400">{JSON.stringify(tool.input, null, 2)}</pre>
                    {textOut && (
                      <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-neutral-500">{textOut.text}</pre>
                    )}
                    {images.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {images.map((img, k) => {
                          // These used to be <a href="data:…" target="_blank">, which Chrome silently
                          // refuses to navigate to (top-level data: URLs blocked since v60) — the link
                          // never worked. Route them into the same lightbox as the panel instead,
                          // matching them up by identity so it opens on the right frame.
                          const at = shots.findIndex((s) => s.id === `${tool.id || ""}:${k}` || (!!img.data && s.data === img.data));
                          return (
                            <button key={k} onClick={() => onOpenShot(at >= 0 ? at : shots.length - 1)}
                              disabled={!shots.length} title="Open full size">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={`data:${img.mediaType};base64,${img.data}`} alt="" className="h-24 rounded border border-white/10 object-cover transition-opacity hover:opacity-80" />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </details>
                );
              })}
            </div>
          </div>
  );
});

// `view` swaps the pane's BODY (transcript ↔ step graph) and nothing else. Everything around it —
// the session menu, the composer, Plan/Code, the approval pills, the browser panel — is shared by
// construction, so the two views can't drift on the things that actually execute code. That is also
// why Flow isn't its own route: a second copy of the send/steer/stop wiring is a second place for the
// permission model to be subtly wrong.
/**
 * The state line for an isolated chat: which checkout it is in, and the way back out of it.
 *
 * The merge button exists because the autopilot — which already merges finished worktrees, resolves
 * the mechanical conflicts and prunes the trees (§13) — is **off by default** and rewrites git history
 * unattended. Isolation that only works when an always-on agent is switched on would be isolation
 * nobody can trust, so the manual path is the guarantee and the autopilot is the convenience. Both go
 * through `bin/task.mjs merge`, so there is one definition of "ready" and one set of gates.
 *
 * Refusals are shown verbatim rather than translated. `task.mjs` refuses for concrete, fixable reasons
 * — the base is dirty, the build failed, someone is working in the tree — and a paraphrase would strip
 * exactly the part that tells you what to do next.
 */
function IsolatedBar({ cwd, busy }: { cwd: string; busy: boolean }) {
  const [state, setState] = useState<"idle" | "merging" | "done">("idle");
  const [msg, setMsg] = useState("");
  const task = cwd.split("/").filter(Boolean).pop() || "";
  const merge = async () => {
    setState("merging"); setMsg("");
    try {
      const d = await (await fetch("/api/worktree", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "merge", cwd }),
      })).json();
      setState(d?.ok ? "done" : "idle");
      setMsg(String(d?.message || (d?.ok ? "merged" : "merge refused")));
    } catch (e) {
      setState("idle"); setMsg(String((e as Error)?.message || e));
    }
  };
  return (
    <div className="mx-auto mb-1 flex max-w-full items-center gap-1.5 rounded-full border border-[#6cc4a1]/30 bg-[#6cc4a1]/10 px-3 py-1 text-[11px] text-[#6cc4a1]">
      <GitBranch className="h-3 w-3 shrink-0" />
      <span className="shrink-0">isolated in <code className="text-[10px]">{task}</code> — nothing here can overwrite another chat</span>
      {/* Never mid-turn: `task.mjs merge` builds the tree and moves the branch, and doing that under a
          running agent is the collision this whole feature exists to avoid. */}
      <button onClick={merge} disabled={busy || state === "merging" || state === "done"}
        title={busy ? "Wait for this turn to finish" : "Verify, build and merge this chat's work back into the base branch"}
        className="ml-1 shrink-0 rounded-full border border-[#6cc4a1]/40 px-1.5 py-0.5 text-[10px] transition-colors hover:bg-[#6cc4a1]/15 disabled:opacity-40">
        {state === "merging" ? "merging…" : state === "done" ? "merged ✓" : "merge back"}
      </button>
      {msg && <span className="min-w-0 truncate text-[10px] text-neutral-400" title={msg}>{msg}</span>}
    </div>
  );
}

function ChatColumn({ paneKey, sessionId, sessions, cwd: cwdProp, isolated, idx, count, showTools, agentsHere, openSids, collapsed, focused, onFocus, onOpenFlow, onPick, onLive, onBusy, onClose }: {
  paneKey: string; sessionId: string; sessions: SessionMeta[]; cwd: string;
  /** This chat has its own git worktree (see `addPane`), so nothing it writes can collide. */
  isolated?: boolean;
  idx: number; count: number; showTools: boolean; agentsHere: number; openSids: string[]; collapsed?: boolean; focused?: boolean; onFocus: () => void; onOpenFlow: (sid: string) => void; onPick: (id: string) => void; onLive: (sid: string) => void; onBusy: (key: string, act: { phase: ActivityPhase; label: string; busy: boolean }) => void; onClose: () => void;
}) {
  // Seed from the shared cache so re-opening a project paints its transcripts instantly (no reload flash).
  const [detail, setDetail] = useState<Detail | null>(() => (sessionId ? transcriptCache.get(sessionId) ?? null : null));
  const [menu, setMenu] = useState(false);
  const [modeOpen, setModeOpen] = useState(false); // the folded session-controls pill, in a cramped pane
  // Key the agent by the SESSION (once it has an id), not the pane. That's what lets ANY pane showing a
  // running session stream it live — and lets a pane reattach after a project switch / refresh — rather
  // than streaming only in the exact pane that started it. Blank chats use their pane key until they get
  // an id, at which point the server has aliased the session to `live:<id>` so nothing is orphaned.
  const effectiveKey = sessionId ? "live:" + sessionId : paneKey;
  // A pane that STARTED blank and just went live needs its in-progress draft carried from the paneKey's
  // storage slot to the new live:<sessionId> slot BEFORE useSetting's own "load from storage" effect
  // fires for that new key below — otherwise, if this exact session id happens to already have an old
  // stored draft from a past visit, that effect would silently overwrite whatever the user is mid-typing
  // right now with the stale leftover. Guarded to run (a) only once per sessionId and (b) only for a pane
  // that was actually new at mount — a pane opened directly on an EXISTING session must never do this,
  // or it would clobber that session's real saved draft with irrelevant paneKey-slot leftovers.
  const wasNewAtMountRef = useRef(!sessionId); // captured once at mount, same test as `isNew` below
  const migratedDraftForRef = useRef<string | null>(null);
  if (wasNewAtMountRef.current && sessionId && migratedDraftForRef.current !== sessionId) {
    migratedDraftForRef.current = sessionId;
    try {
      const cur = localStorage.getItem("bento:draft:" + paneKey);
      if (cur) localStorage.setItem("bento:draft:live:" + sessionId, cur); // only if there's actually
      // something in-progress to carry over — an empty draft (the common case: already sent, box
      // cleared) must never stomp a real pre-existing draft under the session's own key.
    } catch { /* ignore */ }
  }
  // Draft text survives closing/reopening a topic or switching panes — it's persisted (like `perm`
  // below) instead of plain useState, which used to reset to "" every time ChatColumn unmounted.
  // Keyed by the same effectiveKey as the agent so the draft follows a session, not a pane slot.
  const [input, setInput] = useSetting<string>("draft:" + effectiveKey, "");
  const [attachOpen, setAttachOpen] = useState(false); // file-attach picker
  const [planning, setPlanning] = useState(false); // Plan vs Code — default Code
  // Approval level in Code mode; persisted so your last choice (incl. bypass) becomes the default.
  // PER SESSION, with the last choice as the seed for the next new chat. It used to be one global key
  // while `changeMode()` applies per session on the SERVER — so setting bypass in one chat flipped
  // every other chat's badge, and the badge you were reading could be describing a session other than
  // the one actually executing. A permission level is the most dangerous thing in this UI to be wrong
  // about, so it follows the conversation, not the window.
  // Bypass is the default on this box — see DEFAULT_PERMISSION_MODE in lib/agent/manager.ts. The
  // server defaults the same way, so a pane with no stored preference and a session started outside
  // the UI agree instead of one of them quietly asking for approvals.
  const [permDefault, setPermDefault] = useSetting<Exclude<AgentMode, "plan">>("permMode", "bypassPermissions");
  const [perm, setPerm] = useSetting<Exclude<AgentMode, "plan">>("permMode:" + effectiveKey, permDefault);
  const scrollRef = useRef<HTMLDivElement>(null);
  const agent = useAgent(effectiveKey);
  const isNew = !sessionId;
  // On mount for an existing session, attach: if it's live on the server (whoever started it) we stream
  // it; if not, the server replies `detached` and we fall back to the on-disk view. Runs once per mount,
  // so a project switch / refresh reattaches to a still-running session and resumes its stream.
  const attachedRef = useRef(false);
  useEffect(() => {
    if (attachedRef.current) return;
    attachedRef.current = true;
    if (sessionId) agent.attach(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // When a blank chat goes live and gets a real session id, tell the parent so the pane (and its
  // persisted layout) tracks it — the next refresh then reopens the real session, not a blank.
  useEffect(() => { if (agent.sessionId && agent.sessionId !== sessionId) onLive(agent.sessionId); }, [agent.sessionId, sessionId, onLive]);
  // Report this pane's phase up to the tab strip. Only consulted while the pane has no session id —
  // once it has one, the 1.5s `/api/agent/live` poll is authoritative and this is ignored.
  useEffect(() => {
    onBusy(paneKey, { phase: agent.activity.phase, label: agent.activity.label, busy: agent.busy });
  }, [paneKey, agent.activity.phase, agent.activity.label, agent.busy, onBusy]);
  // ...and hand it BACK if a continue was adopted optimistically and then rejected. `onLive` is
  // one-way — it only fires on a truthy id — so use-agent giving the id back on error was not enough
  // on its own: the parent kept `pane.sid`, and a refused continue still left the pane re-pointed at
  // the conversation it had just been refused (measured: the pane retitled itself to the target chat
  // while showing "folder does not exist"). Scoped to adoptions THIS pane made via continue, so a pane
  // opened directly on a session is never reset by it.
  const adoptedViaContinueRef = useRef(false);
  useEffect(() => {
    if (adoptedViaContinueRef.current && !agent.sessionId && sessionId) {
      adoptedViaContinueRef.current = false;
      setResumedFrom(null); // the seam would otherwise claim context that was never loaded
      onLive("");
    }
  }, [agent.sessionId, sessionId, onLive]);
  // Poll the on-disk transcript for history — but stop once this pane is driving the session live
  // (then the live turns are authoritative and the poll would just fight the stream). Skip the state
  // update when nothing changed, so an idle chat doesn't re-render every 2.5s.
  const sigRef = useRef("");
  // History pages fetched on demand, kept SEPARATE from `detail` because the 2.5s poll replaces `detail`
  // wholesale — merging older turns into it would mean every poll silently discarded them.
  const [older, setOlder] = useState<{ turns: Turn[]; start: number } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => {
    if (isNew || agent.live) return;
    let a = true;
    // Paint the cached copy immediately on (re)mount / session switch, then refresh in the background.
    const cached = transcriptCache.get(sessionId);
    if (cached) { setDetail(cached); sigRef.current = `${cached.turns.length}:${cached.turns.at(-1)?.text.length || 0}`; }
    else { setDetail(null); sigRef.current = ""; }
    const load = () => fetch(`/api/bento/session/${sessionId}`).then((r) => r.json()).then((d) => {
      if (!a || !d) return;
      const sig = `${d.turns?.length || 0}:${d.turns?.at(-1)?.text?.length || 0}`;
      if (sig === sigRef.current) return;
      sigRef.current = sig; cacheTranscript(sessionId, d); setDetail(d);
    }).catch(() => {});
    load(); const iv = setInterval(load, 2500); return () => { a = false; clearInterval(iv); };
  }, [sessionId, isNew, agent.live]);
  const cur = sessions.find((s) => s.id === sessionId);
  // A pane resuming an EXISTING session must run in THAT session's own launch directory — `--resume` is
  // scoped to the folder the transcript is filed under (see lib/claude-sessions.ts), so handing the CLI a
  // sibling's cwd makes it fail with "No conversation found with session ID". `cwdProp` is the topic's
  // aggregate cwd (whichever session sorted first), and a topic collapses on basename(cwd) — so ~/work/api
  // and ~/personal/api share one topic whose cwd belongs to only one of them. Prefer the resumed session's
  // own cwd; fall back to the topic cwd only for a blank/new pane that has no session of its own yet.
  const cwd = (sessionId && cur?.cwd) || cwdProp || sessions[0]?.cwd || "";
  const proj = sessions[0]?.project || cwd.split("/").filter(Boolean).pop() || "";
  // Fetched history sits in front of the polled window. Drop anything at or past the window's lower
  // bound so a page and the tail can't double-render the same turn if the window shifted between fetches.
  const windowStart = detail?.start ?? 0;
  const olderTurns = older ? older.turns.filter((t) => (t.off ?? 0) < windowStart) : [];
  const fileTurns = [...olderTurns, ...(detail?.turns || [])];
  // Unified render model: on-disk history until this pane goes live, then the streamed turns.
  const source: RenderTurn[] = agent.live ? agent.turns : fileTurns;
  // A turn survives the "hide tool noise" filter if it SAID something — or if it CHANGED something.
  //
  // The second clause is not a nicety. Measured on a real 63-turn session: 5 files were written and
  // not one of those turns carried assistant text, so every one of them was filtered out here and the
  // created/changed chips rendered exactly zero times. The panel still listed the files, which made it
  // worse — the transcript silently disagreed with the panel about whether anything had happened.
  const allVisible = showTools ? source : source.filter((t) => t.text.trim() || t.streaming || t.tools.some((x) => writtenBy(x)));
  // Lazy render: only the most recent `limit` messages (older revealed on demand). Rendering a long
  // transcript's worth of Markdown up front is a big cost; the tail is what the user actually reads.
  const [limit, setLimit] = useState(40);
  // Reset both on session switch. `limit` used to persist across switches, so opening a short chat after
  // expanding a long one rendered hundreds of messages at once for no reason.
  useEffect(() => { setOlder(null); setLimit(40); }, [sessionId]);
  const hiddenCount = Math.max(0, allVisible.length - limit);
  const visible = hiddenCount ? allVisible.slice(-limit) : allVisible;
  // TWO different "there's more" conditions, deliberately behind one button: turns already fetched but
  // not yet rendered (instant, no network), and turns still on disk below the window (one request). The
  // old button only knew the first, so it vanished at the window edge and read as "start of conversation".
  const earliestStart = older ? older.start : windowStart;
  const moreOnDisk = !agent.live && earliestStart > 0;
  const loadOlder = () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    fetch(`/api/bento/session/${sessionId}?before=${earliestStart}`)
      .then((r) => r.json())
      .then((d: Detail) => {
        const got: Turn[] = d?.turns || [];
        // Even an empty page must advance `start`, or the button would re-request the same offset forever.
        setOlder((p) => ({ turns: [...got, ...(p?.turns || [])], start: d?.start ?? 0 }));
        setLimit((n) => n + Math.max(got.length, 1)); // reveal what just arrived instead of hiding it
      })
      .catch(() => {})
      .finally(() => setLoadingOlder(false));
  };
  const chats = [...sessions].sort((a, b) => b.lastActivity - a.lastActivity);

  // `claude --continue` parity. A blank pane used to start a session that could see none of the
  // project's history — you'd ask a follow-up in a fresh chat and Claude had no idea what you meant.
  // The pane now offers to continue the topic's most recent conversation instead.
  //
  // Sessions already open in another pane are skipped, and that's a correctness guard rather than
  // tidiness: `resume` makes the CLI append to that conversation's JSONL, so two panes driving one id
  // means two subprocesses interleaving writes into one file. The server refuses it outright
  // (sendMessage) — this just avoids offering what would be rejected.
  //
  // The `s.cwd === cwd` test is NOT redundant with "same topic". A topic is keyed on
  // basename(cwd) (see `project` in lib/claude-sessions.ts), so ~/work/api and ~/personal/api collapse
  // into one topic whose `cwd` is just whichever session sorted first. Without this, a blank pane could
  // resume a conversation recorded in one directory while the SDK runs it in another — same history,
  // wrong CLAUDE.md, wrong relative paths. `claude --continue` is explicitly scoped to the current
  // directory, and so is this.
  const continueTarget = isNew ? chats.find((s) => s.cwd === cwd && !openSids.includes(s.id)) || null : null;
  // Persisted, because it's a decision about THIS pane that must outlive a remount: a project switch or
  // refresh remounts ChatColumn, and an ephemeral useState would quietly revert "start fresh" back to
  // continuing — re-attaching context the user had explicitly declined.
  const [continueOn, setContinueOn] = useSetting<boolean>("continue:" + paneKey, true);
  // Which conversation this pane actually continued, kept for the in-chat marker. It has to be state,
  // not derived: the moment the resumed turn goes live the pane adopts that session id, `isNew` flips
  // false and `continueTarget` becomes null — so anything derived would vanish exactly when the marker
  // is supposed to appear.
  const [resumedFrom, setResumedFrom] = useState<SessionMeta | null>(null);

  const effectiveMode: AgentMode = planning ? "plan" : perm; // Plan overrides the approval level
  const submit = () => {
    const text = input.trim();
    if (!text || !cwd) return;
    // A turn already running is no longer a reason to drop the message. The SDK's streaming-input mode
    // exists for exactly this: the CLI accepts a message mid-turn, queues it, and runs it as its own turn
    // when the current one ends — which is what makes "actually, also…" and mid-flight corrections
    // possible instead of making you wait out work you've already changed your mind about.
    if (agent.busy) { agent.queueMessage(text, { cwd, mode: effectiveMode }); setInput(""); return; }
    ensureNotifyPermission(); // lazy — a real user gesture, which browsers want for this prompt
    const continuing = !sessionId && continueOn ? continueTarget : null;
    if (continuing) adoptedViaContinueRef.current = true; // so a rejected continue can be handed back
    agent.send(text, { cwd, mode: effectiveMode, resume: sessionId || continuing?.id || undefined, seed: fileTurns.map((t) => ({ role: t.role, text: t.text, tools: t.tools })) });
    if (continuing) setResumedFrom(continuing);
    setInput("");
  };
  // Both toggles flip local UI state immediately (optimistic — feels instant), then revert it if the
  // server-side changeMode() call turns out to have failed, so a network blip can't leave the toggle
  // showing a mode (e.g. "bypass") that the live session never actually switched to.
  const setPlan = (on: boolean) => {
    const prev = planning;
    setPlanning(on);
    agent.changeMode(on ? "plan" : perm).then((ok) => { if (!ok) setPlanning(prev); });
  };
  const setPermLevel = (m: Exclude<AgentMode, "plan">) => {
    const prev = perm;
    setPerm(m);
    setPermDefault(m); // seed the next NEW chat only — never retroactively re-mode an existing one
    if (!planning) agent.changeMode(m).then((ok) => { if (!ok) setPerm(prev); });
  };
  // Follow the stream — but only while the reader is actually AT the bottom.
  //
  // This used to slam `scrollTop = scrollHeight` on every token, which meant scrolling up to re-read
  // something during a live turn yanked you back down a few milliseconds later, every time. The fix
  // every mature chat UI converges on: treat "pinned to the bottom" as state the user owns. They leave
  // it by scrolling away, they return by scrolling back (or with the button below) — and nothing else
  // moves the viewport for them.
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  pinnedRef.current = pinned;
  const BOTTOM_SLOP = 72; // px — a hair of tolerance so a fractional scrollHeight doesn't unpin you
  const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLOP;
  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    setPinned(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinnedRef.current) return;
    // Straight assignment, not scrollTo({behavior:"smooth"}): this fires on every token, and a smooth
    // scroll that restarts 30×/second never arrives anywhere. Smooth belongs to the deliberate jump.
    el.scrollTop = el.scrollHeight;
    // `agent.queued.length` is a dep because queued bubbles are appended AFTER `visible` and so change
    // the scroll height without changing any of the other four — queue a message while pinned to the
    // bottom and it would otherwise land just below the fold, which reads as it not having sent.
  }, [visible.length, source[source.length - 1]?.text.length, agent.pending, agent.busy, agent.queued.length]);
  // Focus mode hides the other panes with `display:none` rather than unmounting them (so their streams
  // survive) — but a display:none box has no layout, and the browser does NOT restore its scrollTop
  // when it comes back. Left alone, every trip into a focused pane and out again would dump the other
  // three at the top of their rendered window and unpin them, because atBottom() then reads false.
  // Save on the way out, restore on the way in — and honour `pinned` over the saved offset, since a
  // pane that was following the reply has almost certainly grown while it was hidden.
  const parkedScroll = useRef<number | null>(null);
  useIsoLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (collapsed) { parkedScroll.current = el.scrollTop; return; }
    if (parkedScroll.current == null) return;
    el.scrollTop = pinnedRef.current ? el.scrollHeight : parkedScroll.current;
    parkedScroll.current = null;
  }, [collapsed]);

  // The session, folded into a journey — ONE derivation, read by both the strip and the canvas so they
  // cannot disagree about what exists. Was two: the strip scanned raw TodoWrite input while the panel
  // called buildFlow, which is how a TaskCreate-tracked turn ended up with a flow and no way to open
  // it. Nothing server-side needed — TodoWrite's input already flows through `source` like any other
  // tool. No narratives here on purpose: the strip shows counts and the live goal, both of which are
  // rules-derived and must be right *while* a turn runs, which is exactly when narration has nothing.
  const flowJourney = useMemo(() => buildJourney(source), [source]);

  // The browser tool (Playwright MCP, see manager.ts). Everything the panel shows — URL, title,
  // console counts, network rows, the screenshot filmstrip, the action log — is folded out of the tool
  // results already streaming in, by lib/browser-view.ts. No extra event plumbing, and the docked
  // panel, the lightbox and the pop-out window all read the same derivation so they can't disagree.
  const browser = useMemo(() => deriveBrowserState(source), [source]);
  const lastTool = source[source.length - 1]?.tools.at(-1);
  const browserBusy = !!lastTool && isBrowserTool(lastTool.name) && !lastTool.done;
  const browserActionLabel = browserBusy ? activityLabel(lastTool!.name, lastTool!.input) : browser.shots.at(-1)?.action;
  // Collapsing the panel has to OUTLIVE the pane. This was `useState(false)`, which dies with the
  // component — and switching topics unmounts the whole chat column, so every trip away and back
  // re-opened a panel that had been deliberately closed. `browser.everUsed` latches true forever once
  // a browser tool has run in a session, so the panel came back on *every* return, not just the first.
  //
  // Global, like the two settings below it, because collapsed-vs-open is the same category of thing as
  // stacked-vs-side and the split width: a statement about how you want the UI laid out, not about one
  // conversation. It is deliberately NOT the per-session `permMode:<id>` shape — that pattern exists to
  // stop one chat's *permission level* describing another's, which is a correctness problem. This is a
  // preference, and making it per-session would mean every NEW chat pops the panel open again, which is
  // the annoyance itself.
  const [browserPanelHidden, setBrowserPanelHidden] = useSetting("browserHidden", false);
  // Layout is a per-user preference, not per-pane state: 300px side-by-side (the old hardcoded width)
  // is unusable in a 3- or 4-pane grid, so both the split and the side/stacked choice persist.
  const [browserStacked, setBrowserStacked] = useSetting("browserStacked", false);
  const [browserW, setBrowserW] = useSetting("browserWidth", 42);
  const [browserDrag, setBrowserDrag] = useState(false);
  const paneRef = useRef<HTMLDivElement>(null);
  // How much room this pane actually has — the S and the H of the revamp. Everything below reads `d`
  // (what's true of the box) or `dc` (what the box may SPEND on chrome right now). See lib/density.ts.
  const d = useDensity(paneRef);
  // ...and E: the pane you are typing in is the one you're in, so it gets a tier back. Cramped, that's
  // the difference between a folded mode pill and the full Plan/Code + approval row — the controls
  // reappear exactly when you reach for them, and recede the moment you go back to reading. Focus, not
  // hover: hover fires on the way to somewhere else, and a control row that flickers past the cursor is
  // worse than one that stays folded.
  const [composing, setComposing] = useState(false);
  const dc = composing ? looser(d) : d;
  const roomy = atLeast(dc, "snug"); // chrome gets its own rows
  // The pill and its fold-out only exist in the cramped branch. Growing out of that branch (resize, or
  // focusing the composer) must take the fold-out with it, or `modeOpen` sits latched true and the next
  // return to a cramped size pops a menu nobody asked for.
  useEffect(() => { if (roomy) setModeOpen(false); }, [roomy]);
  const browserPaneRef = useRef<HTMLDivElement>(null); // the panel whose width the drag paints
  const pendingBrowserW = useRef(browserW);
  useEffect(() => {
    if (!browserDrag) return;
    // Same discipline as the bento divider: paint each frame straight to the DOM, commit once on
    // mouseup. Going through `setBrowserW` per mousemove re-rendered the whole pane — transcript,
    // browser panel and all — AND, because it's a `useSetting`, wrote to localStorage on every pixel
    // of travel. A synchronous storage write inside a pointer handler is the textbook way to make a
    // drag stutter.
    //
    // Measured against the PANE, not the window — each chat column is its own grid cell, so a
    // window-relative calculation (the way the bento's own divider works) would be wrong here.
    const move = (e: MouseEvent) => {
      const r = paneRef.current?.getBoundingClientRect();
      if (!r || r.width < 80) return;
      const pct = Math.min(75, Math.max(22, Math.round(((r.right - e.clientX) / r.width) * 100)));
      pendingBrowserW.current = pct;
      if (browserPaneRef.current) browserPaneRef.current.style.width = `${pct}%`;
    };
    const up = () => { setBrowserDrag(false); setBrowserW(pendingBrowserW.current); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserDrag]);
  // null = closed. Index into browser.shots.
  const [lightbox, setLightbox] = useState<number | null>(null);

  // ---- the side slot: browser OR file, never both -----------------------------------------------
  // Both panels want the same place (beside the chat, drag-resizable) and a pane is already as narrow
  // as 1/4 of the window. Two independently-openable side panels would leave the transcript unreadable
  // and give the drag handle two meanings, so they SHARE one slot and one width, and opening a file
  // switches the slot rather than adding to it.
  const files = useMemo(() => deriveFileState(source), [source]);
  // Which file the panel is showing. Set by a chip in the transcript or the panel's own rail; null
  // means "whatever was touched most recently", which is almost always what you want.
  const [filePath, setFilePath] = useState<string | null>(null);
  const [slot, setSlot] = useSetting<"browser" | "file">("sidePanel", "browser");
  const openFile = useCallback((p: string) => {
    setFilePath(p);
    setSlot("file");
    setBrowserPanelHidden(false); // the slot is shared, so un-hiding it is what makes the file visible
  }, [setSlot, setBrowserPanelHidden]);

  const canShowBrowser = browser.everUsed;
  const canShowFile = files.everUsed;
  // Fall back rather than render an empty panel: a session that only touched files should not show a
  // blank browser slot just because "browser" is the persisted default.
  const activeSlot: "browser" | "file" | null =
    slot === "file" && canShowFile ? "file"
    : slot === "browser" && canShowBrowser ? "browser"
    : canShowFile ? "file" : canShowBrowser ? "browser" : null;
  // A browser preview or a file diff docked beside a 380px-wide transcript is two unreadable columns
  // instead of one readable one, so below `snug` the slot doesn't open at all — and the header's reopen
  // button (see below) becomes "expand this pane", which is the only place the panel CAN fit. Nothing is
  // lost or silently dropped: the button still shows the error/file count, and one click gets you there.
  const roomForSlot = atLeast(d, "snug");
  const showSidePanel = !!activeSlot && !browserPanelHidden && roomForSlot;
  const showBrowserPanel = showSidePanel && activeSlot === "browser";
  // Toolbar controls can't touch the browser directly (there's no server-side handle on it — see
  // browser-view.ts), so they ask the agent, exactly the way Claude Code models navigation as a tool
  // call. Sending while a turn is in flight would be dropped, hence the `busy` guard at the call site.
  // Session-scoped browser allowlist, Bento's version of Claude Code's "Allow all actions on {host} for
  // this session". The SDK has no domain-rule concept, so this is enforced here: while a host is
  // allowed, matching browser prompts auto-approve. Deliberately component state — it dies with the
  // pane, and is never persisted, so a permission grant can't outlive the thing you granted it for.
  const [browserAllowHost, setBrowserAllowHost] = useState<string | null>(null);
  const autoAllowedId = useRef<string | null>(null);
  useEffect(() => {
    const p = agent.pending;
    if (!p || !browserAllowHost || autoAllowedId.current === p.id) return;
    if (!isBrowserTool(p.toolName)) return;
    // A prompt with no URL of its own acts on the page the browser is already showing, so fall back to
    // the current page's host — otherwise every click after the initial navigate would still prompt.
    const host = hostOf((p.input as { url?: string })?.url) || hostOf(browser.url);
    if (host !== browserAllowHost) return;
    autoAllowedId.current = p.id;
    agent.respond("allow");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.pending, browserAllowHost, browser.url]);

  const askBrowser = (text: string) => {
    if (!cwd || agent.busy) return;
    agent.send(text, { cwd, mode: effectiveMode, resume: sessionId || undefined, seed: fileTurns.map((t) => ({ role: t.role, text: t.text, tools: t.tools })) });
  };

  // Away-tab notifications: tell the user when a background pane finishes, or needs them, while
  // they're looking at another tab/app. Each transition (busy→idle, a fresh permission/ask prompt)
  // fires once, not on every render — the refs below track "have I already notified for this state".
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !agent.busy && !agent.error) notify(`${proj || "Minami"} — done`, "Claude finished the turn");
    wasBusy.current = agent.busy;
  }, [agent.busy, agent.error, proj]);
  const notifiedPendingId = useRef<string | null>(null);
  useEffect(() => {
    if (agent.pending && agent.pending.id !== notifiedPendingId.current) {
      notifiedPendingId.current = agent.pending.id;
      notify(`${proj || "Minami"} needs approval`, `wants to use ${agent.pending.toolName}`);
    }
  }, [agent.pending, proj]);
  const notifiedAskId = useRef<string | null>(null);
  useEffect(() => {
    if (agent.ask && agent.ask.id !== notifiedAskId.current) {
      notifiedAskId.current = agent.ask.id;
      notify(`${proj || "Minami"} has a question`, agent.ask.questions[0]?.question || "");
    }
  }, [agent.ask, proj]);

  // What this pane is doing, in one line — the same content whether it sits in the full control row or
  // in the folded utility bar. Derived once so the two layouts can't disagree about a live session.
  // The streaming row in the transcript already carries a full ActivityLine, ~40px above this one and
  // saying the identical words ("taking a screenshot · 0s" twice on screen). The control row is the
  // FALLBACK — it matters when the transcript's copy isn't there (scrolled away, or a reattach before
  // the first snapshot lands), which is exactly the condition the safety net below `visible.map` uses.
  // When the transcript has it, this end of the row says the one thing the transcript doesn't: the
  // session is live and in which mode.
  const transcriptHasActivity = agent.busy && !!visible[visible.length - 1]?.streaming;
  const statusEl = agent.stopping ? <span className="flex items-center gap-1 text-red-400"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400" />stopping…</span>
    : agent.error ? <span className="truncate text-red-400">{agent.error.slice(0, 44)}</span>
    : transcriptHasActivity ? <><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />{planning ? "plan mode" : "live"}</>
    : agent.busy || agent.activity.phase !== "idle" ? <ActivityLine compact busy={agent.busy} activity={agent.activity} elapsed={agent.elapsed} />
    : agent.live ? <><span className="h-1.5 w-1.5 rounded-full bg-green-500" />{planning ? "plan mode" : "live"}</> : <>ready</>;

  // The slot is reachable from the header whenever it isn't showing — either because it was hidden by
  // hand, or because this pane is too small to hold it. The two cases need different buttons: one
  // reopens, the other has to make room first.
  const slotHidden = !!activeSlot && (browserPanelHidden || !roomForSlot);
  const openSlot = (which: "browser" | "file") => {
    setSlot(which);
    setBrowserPanelHidden(false);
    if (!roomForSlot) onFocus(); // no room here — take the panel, which is where the room is
  };

  return (
    // `collapsed` is display:none, NOT unmounted — see the grid in BentoHome. A collapsed pane keeps
    // streaming, keeps its draft, keeps its scroll position, and costs one style bit.
    <DensityContext.Provider value={d}>
    <div ref={paneRef} className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border bg-neutral-900/40 ${collapsed ? "hidden " : ""}${focused ? "border-[var(--sakura)]/30" : "border-white/10"} ${browserDrag ? "select-none" : ""} ${count === 3 && idx === 2 && !focused ? "col-span-2" : ""}`}>
      {/* The header is chrome about the pane, not content in it, so it is the first thing to thin out.
          Sized off `d` rather than `dc`: the title bar must not twitch every time the composer takes
          focus — only the footer, which is what you're reaching for, is allowed to move.

          `focused` means tabs view with this pane as the single visible one — and in that view the lit
          tab immediately above already carries this exact title. So the icon, the title and the goal
          line are three restatements of something on screen 30px higher, costing a two-line row of the
          only column showing a transcript. When focused, all of it collapses to the ⌄ switcher (which
          is a control, not a label, and has no other home). Grid view keeps the full title: there the
          panes have no lit tab, and an unlabelled cell in a 2×2 is unidentifiable. */}
      <div className={`relative flex items-center gap-2 border-b border-white/[0.07] ${
        focused ? "px-2 py-1" : atLeast(d, "snug") ? "px-4 py-2" : atLeast(d, "tight") ? "px-3 py-1.5" : "px-2 py-1"}`}>
        {!focused && atLeast(d, "tight") && <ProjectIcon name={proj} />}
        <button onClick={() => setMenu((v) => !v)}
          title={focused ? `${isNew ? "New chat" : cur ? titleOf(cur) : ""} — switch chat` : undefined}
          className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-white/10">
          {!focused && (
            <span className="min-w-0">
              <span className={`block truncate font-semibold ${atLeast(d, "snug") ? "text-[13px]" : "text-[12px]"}`}>{isNew ? "New chat" : cur ? titleOf(cur) : "…"}</span>
              {/* The goal line goes first. It's the pane's *category* — true all session, read once, and
                  the tab strip and the bento tile both still say it. Two lines of title above a
                  three-line transcript was the single worst ratio in the four-pane layout. */}
              {atLeast(d, "snug") && <span className="block truncate text-[10px] text-neutral-500">{isNew ? proj : cur ? goalOf(cur) : ""}</span>}
            </span>
          )}
          <span className="text-neutral-500">⌄</span>
        </button>
        {/* Reopen the shared side slot. Two buttons rather than one, because "show the browser" and
            "show the files" are different intents and the slot has to know which one you meant. */}
        {canShowBrowser && slotHidden && (
          <button onClick={() => openSlot("browser")} title={roomForSlot ? "Show browser view" : "Expand this chat to show the browser view"}
            className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-neutral-500 transition-colors hover:bg-white/10 ${count === 1 && !canShowFile ? "ml-auto" : ""}`}>
            <Chrome className="h-3.5 w-3.5" />
            {/* A hidden panel shouldn't hide a broken page — surface the error count on the reopen button. */}
            {browser.consoleErrors > 0 && <span className="text-[9px] tabular-nums text-[#ef7c7c]">{browser.consoleErrors}</span>}
          </button>
        )}
        {canShowFile && slotHidden && (
          <button onClick={() => openSlot("file")} title={roomForSlot ? "Show files touched in this chat" : "Expand this chat to show the files it touched"}
            className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-neutral-500 transition-colors hover:bg-white/10 ${count === 1 ? "ml-auto" : ""}`}>
            <FileText className="h-3.5 w-3.5" />
            <span className="text-[9px] tabular-nums">{files.files.length}</span>
          </button>
        )}
        {/* The maximise button that used to sit here is gone: it asked "do you want THIS one bigger"
            once per pane, when the real decision is made once for the panel. That switch now lives in
            the tab row (see the panel chrome), and the tab itself is how you choose a pane. What's left
            here is close, which genuinely is per-pane. */}
        {count > 1 && <button onClick={onClose} title="Close this chat (⌥W) — the session keeps running; ⌥⇧T reopens it" className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-xs text-neutral-500 transition-colors hover:bg-white/10">✕</button>}
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
      {/* Messages + composer share the row with the browser panel (when active) instead of stacking —
          "side panel next to the chat", not inline in the transcript or a full takeover. */}
      <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div ref={scrollRef}
        // Passive by default in React 19; this only reads geometry, so it never blocks the scroll.
        onScroll={(e) => { const on = atBottom(e.currentTarget); if (on !== pinnedRef.current) setPinned(on); }}
        // Padding and the gap between turns are chrome too — 24px of dead margin around a 146px
        // transcript is a tenth of the pane spent on nothing. They shrink with the box, never to zero:
        // messages still need a gutter to read as separate messages.
        //
        // `[&>*]:max-w-3xl` caps the MEASURE, not the pane. A line of prose stops being readable past
        // roughly 75 characters — the eye loses its place on the return sweep — and a single maximised
        // chat on a 1600px display was running paragraphs the full width of the column. The cap sits on
        // the children rather than this element so the scrollbar and the scroll area stay full-bleed at
        // the pane's edge; only the content is centred inside them.
        // Unconditional on purpose: it needs no view check because it can only ever bind when there IS
        // excess width. In grid view, or with the side panel open, a column is already narrower than the
        // cap and the rule does nothing at all.
        className={`relative min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable] [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-3xl ${
          // --turn-gap mirrors the space-y value so a row that continues the SAME speaker can pull
          // itself back up by a fraction of it (see TurnRow). It has to be a variable rather than a
          // second set of classes because the pull is applied by the child, which can't know which of
          // the four density branches this element took.
          atLeast(d, "roomy") ? "space-y-6 [--turn-gap:1.5rem] px-5 py-5"
          : atLeast(d, "snug") ? "space-y-5 [--turn-gap:1.25rem] px-4 py-4"
          : atLeast(d, "tight") ? "space-y-4 [--turn-gap:1rem] px-3.5 py-3"
          : "space-y-3 [--turn-gap:0.75rem] px-3 py-2"}`}>
        {/* ── which checkout is this chat writing in ────────────────────────────────────────────
            Two agents in one folder is a silent-data-loss condition, and the dashboard is the only
            thing on the box that can see both. It used to say exactly that and stop, which made it a
            warning you could do nothing about without leaving for a CLI — so it fired for months and
            changed nothing. A blank second chat now gets its own worktree the moment it is created,
            and this line reports which of the two states you are in rather than only the bad one.
            The warning still fires for chats that were already running, and for the shared folder,
            which is genuinely still shared.

            ABOVE the three-way body below, not inside it: an isolated chat is usually BLANK when you
            most need to be told where it will write — the empty "New chat in …" state is the moment
            before you type the instruction, and the old placement only rendered once a transcript
            existed, i.e. after the first turn had already run somewhere. */}
        {isolated ? (
          <IsolatedBar cwd={cwdProp} busy={agent.busy} />
        ) : agentsHere > 1 ? (
          <div className="mx-auto mb-1 flex items-center gap-1.5 rounded-full border border-[#e0a33e]/30 bg-[#e0a33e]/10 px-3 py-1 text-[11px] text-[#e0a33e]">
            <span>⚠</span>
            <span>{agentsHere} agents are live in this folder — they share one branch and will overwrite each other</span>
          </div>
        ) : null}
        {!agent.live && isNew ? (
          <div className="mx-auto mt-16 max-w-sm text-center text-neutral-500">
            <p className="text-2xl">{continueTarget && continueOn ? "⟲" : "✳"}</p>
            <p className="mt-2 text-sm font-medium text-neutral-300">{continueTarget && continueOn ? "Continuing an earlier chat" : `New chat in ${proj}`}</p>
            {/* Stated BEFORE the first message, not after: whether Claude can see the earlier
                conversation changes how you'd word the message you're about to type.
                Deliberately NOT phrased as "where you left off" / "your last chat": the candidate pool
                is filtered by the date-window chip and by isTrivial, so the target is the most recent
                chat AMONG THOSE SHOWN, which isn't always the genuinely latest one. Naming the chat and
                its age is the honest version — it's checkable, and the claim can't go stale. */}
            {continueTarget && continueOn ? (
              <p className="mt-1 text-xs">
                Picks up <span className="text-neutral-400">“{continueTarget.title}”</span> ({ago(continueTarget.lastActivity)} ago) with its full context.{" "}
                <button onClick={() => setContinueOn(false)} className="text-[var(--sakura)] underline decoration-dotted underline-offset-2 hover:opacity-80">Start fresh instead</button>
              </p>
            ) : (
              <p className="mt-1 text-xs">
                Type below to start a live Claude Code session in <code className="text-[11px] text-neutral-400">{cwd || proj}</code>.{" "}
                {continueTarget && <button onClick={() => setContinueOn(true)} className="text-[var(--sakura)] underline decoration-dotted underline-offset-2 hover:opacity-80">Continue last chat</button>}
              </p>
            )}
          </div>
        ) : visible.length === 0 ? (
          agent.busy ? <ActivityLine busy={agent.busy} activity={agent.activity} elapsed={agent.elapsed} notices={agent.notices} /> : (!isNew && !detail ? <p className="text-sm text-neutral-500">Loading transcript…</p> : null)
        ) : (
        <>
        {/* What Claude can actually see is never left implicit. Once this pane resumes a conversation
            it adopts that session id and reconcile() pulls the whole transcript in from disk — so
            without a seam you'd be reading messages you never sent in this pane and guessing whether
            the model remembers them. It does. */}
        {resumedFrom && (
          <div className="flex items-center gap-2 text-[10px] text-neutral-500">
            <span className="h-px flex-1 bg-white/10" />
            <span className="shrink-0">⟲ continued “{resumedFrom.title}”</span>
            <span className="h-px flex-1 bg-white/10" />
          </div>
        )}
        {(hiddenCount > 0 || moreOnDisk) && (
          <button
            onClick={() => (hiddenCount > 0 ? setLimit((n) => n + 60) : loadOlder())}
            disabled={loadingOlder}
            className="mx-auto block rounded-full border border-white/10 px-3 py-1 text-[11px] text-neutral-400 transition-colors hover:border-white/25 hover:text-neutral-200 disabled:opacity-50"
          >
            {loadingOlder ? "Loading earlier messages…"
              : hiddenCount > 0 ? `Show ${Math.min(hiddenCount, 60)} earlier ${hiddenCount === 1 ? "message" : "messages"}`
              : "Load earlier messages from disk"}
          </button>
        )}
        {visible.map((t, i) => (
          <TurnRow
            key={i} turn={t} showTools={showTools} shots={browser.shots} onOpenShot={setLightbox} onOpenFile={openFile}
            sameSpeaker={i > 0 && visible[i - 1].role === t.role}
            // Only the LAST row needs the live indicator, so only it receives props that change on
            // every token. Every earlier row gets a prop set that is identical between renders, and
            // React.memo skips it entirely — which is the entire point of the extraction.
            live={t.streaming && i === visible.length - 1
              ? { notices: agent.notices, activity: agent.activity, elapsed: agent.elapsed, busy: agent.busy }
              : null}
          />
        ))}
        {/* Safety net: a turn is in flight but no visible turn is carrying the indicator (reattach
            mid-turn before the snapshot lands, or the streaming turn scrolled out of the window).
            The rule is that a busy pane ALWAYS animates somewhere. */}
        {agent.busy && !(visible[visible.length - 1]?.streaming) && (
          <div className="flex flex-col gap-1.5">
            <NoticeStrip notices={agent.notices} />
            <ActivityLine busy={agent.busy} activity={agent.activity} elapsed={agent.elapsed} notices={agent.notices} />
          </div>
        )}
        {/* What you've said that hasn't run yet — in the log, where you said it.
            It renders AFTER `visible` rather than inside it because it is not a turn: `turns` is
            rebuilt wholesale from disk on every `result` (see reconcile), and a message that hasn't
            run isn't on disk, so anything spliced into that array is wiped the moment the running
            turn ends. Driven straight off `agent.queued` — the server's mirror of the CLI's own
            queue — it survives every reconcile, and on `started` it hands over to a real user turn
            (see the `started` case in lib/use-agent.ts). */}
        {agent.queued.map((q) => (
          <div key={q.uuid} className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-md border border-dashed border-[#c47f18]/45 bg-[#c47f18]/[0.07] px-3 py-2">
              <div className="mb-0.5 flex items-center gap-1.5 text-[9px] font-medium uppercase tracking-wider text-[#c47f18]">
                {/* Dashed border + a clock, not a spinner: nothing is happening to this message yet,
                    and animating it would claim work that hasn't started. */}
                <Clock className="h-2.5 w-2.5" />queued
              </div>
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-neutral-300">{q.text}</p>
            </div>
          </div>
        ))}
        </>
        )}
      </div>

      {/* Claude's AskUserQuestion — a real choice UI. */}
      {agent.ask && (
        // Keyed by the prompt's own id so a SECOND AskUserQuestion arriving before the first is answered
        // (Claude can issue parallel tool calls) remounts AskCard instead of reusing its internal `qi`
        // question-index state against a `questions` array that may now be shorter — without this,
        // `questions[qi]` can go out of bounds and crash the render (no error boundary catches it).
        <AskCard key={agent.ask.id} questions={agent.ask.questions} onAnswer={agent.answerAsk} />
      )}

      {/* Tool-permission prompt (default mode) — Claude is paused until the user decides.
          Browser calls get the Claude Code treatment: a plain-English verb phrase plus the host, e.g.
          "Claude wants to fill in a form on localhost:3000", with a session-scoped "allow everything on
          this host" escape hatch. Approving one click at a time is unusable for a QA pass, and a raw
          `mcp__playwright__browser_click` + JSON blob tells you nothing about WHERE it's clicking. */}
      {/* A HELD prompt in Flow view is already answerable in the canvas's review drawer, alongside the
          step that raised it — which is the whole point of holding it. Rendering this card too would
          put two Approve buttons for one decision on screen. Every other prompt still lands here, so
          a Flow pane in `default` mode is no less answerable than a Chat one. */}
      {agent.pending && (() => {
        const pendingHost = isBrowserTool(agent.pending.toolName)
          ? hostOf((agent.pending.input as { url?: string })?.url) || hostOf(browser.url)
          : null;
        return (
        <div className="mx-4 mb-2 rounded-xl border border-[var(--sakura)]/40 bg-[var(--sakura)]/[0.06] px-3 py-2.5">
          {pendingHost ? (
            <p className="text-xs text-neutral-200">
              Claude wants to <span className="font-semibold text-[var(--sakura)]">{browserVerb(agent.pending.toolName)}</span>
              {" on "}<span className="font-mono text-[11px] font-semibold text-neutral-100">{pendingHost}</span>
            </p>
          ) : (
            <p className="text-xs text-neutral-200">Claude wants to use <span className="font-semibold text-[var(--sakura)]">{agent.pending.toolName}</span></p>
          )}
          <pre className="mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/40 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-neutral-400">{permPreview(agent.pending.toolName, agent.pending.input)}</pre>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button onClick={() => agent.respond("allow")} className="rounded-lg bg-[var(--sakura)] px-3 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90">Approve</button>
            {pendingHost && (
              <button onClick={() => { setBrowserAllowHost(pendingHost); agent.respond("allow"); }}
                title={`Auto-approve every browser action on ${pendingHost} until this pane is closed`}
                className="rounded-lg border border-[var(--sakura)]/50 px-3 py-1 text-xs text-[var(--sakura)] transition-colors hover:bg-[var(--sakura)]/10">
                Allow all on {pendingHost}
              </button>
            )}
            <button onClick={() => agent.respond("deny")} className="rounded-lg border border-white/15 px-3 py-1 text-xs text-neutral-300 transition-colors hover:bg-white/10">Deny</button>
            <span className="ml-auto text-[10px] text-neutral-500">
              {browserAllowHost ? `auto-allowing browser actions on ${browserAllowHost}` : "acceptEdits mode auto-approves file edits"}
            </span>
          </div>
        </div>
        );
      })()}

      {/* The way back. Only rendered while the reader has scrolled away, and it says whether anything
          arrived while they were up there — without it, "stop following" is a trap you have to scroll
          out of by hand. Sits above the composer rather than floating over the transcript, so it can't
          cover the text you scrolled up to read. */}
      {!pinned && (
        <button onClick={jumpToLatest}
          className="mx-auto -mb-1 flex translate-y-0 items-center gap-1.5 rounded-full border border-white/15 bg-neutral-900/90 px-3 py-1 text-[11px] text-neutral-300 shadow-lg backdrop-blur transition-[transform,background-color] hover:-translate-y-0.5 hover:bg-neutral-800/90">
          <span className="text-[9px]">▼</span>
          {agent.busy ? "following the reply" : "jump to latest"}
        </button>
      )}

      {/* The footer is the half of the pane the revamp is really about: header + flow strip + mode row
          + composer came to ~160px of the ~354px a four-pane grid gives each column.
          `onFocusCapture`/`onBlurCapture` are what make it breathe — see `composing` above. */}
      <div className={`border-t border-white/10 ${roomy ? "px-4 py-3" : "px-3 py-2"}`}>
        {roomy ? (
          // The flow door is a CHIP on the control row, never its own row.
          //
          // It used to be a full-width strip above this row — ~42px with its margin, permanently, in
          // every pane. That was affordable when the grid was the default view and the strip only
          // appeared in a large pane; with tabs-first, the pane you're reading is always `roomy`, so
          // "the roomy treatment" stopped meaning "occasionally" and started meaning "always".
          //
          // Nothing is lost but the running-step title, and that is already said by the activity line
          // at the other end of this same row. Two doors, ONE destination still holds — this chip and
          // the switch on the bento tile raise the same canvas.
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <ModeControls hold={agent.hold} onHold={agent.setHold} planning={planning} onPlan={setPlan} perm={perm} onPerm={setPermLevel} />
            <FlowStrip journey={flowJourney} busy={agent.busy} onOpen={() => onOpenFlow(agent.sessionId || sessionId)} />
            <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[10px] text-neutral-500">{statusEl}</span>
          </div>
        ) : atLeast(dc, "tight") ? (
          // Cramped: the flow strip's row and the control row become ONE 22px bar. Nothing is removed —
          // the strip becomes a chip and the six controls fold into a pill that states the two things
          // you'd actually check at a glance (plan-vs-code, and the approval level) and opens the real
          // controls on click. ~54px of the pane handed back to the transcript.
          <div className="relative mb-1.5 flex items-center gap-1.5">
            <FlowStrip journey={flowJourney} busy={agent.busy} onOpen={() => onOpenFlow(agent.sessionId || sessionId)} />
            <button onClick={() => setModeOpen((v) => !v)} title="Session controls — pause, Plan vs Code, approval level"
              className={`flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${
                modeOpen ? "border-white/25 text-neutral-200" : "border-white/10 text-neutral-500 hover:border-white/25 hover:text-neutral-300"}`}>
              {/* Held and bypass keep their colour even folded. A pane that is parking every tool call,
                  or auto-approving every one of them, may not say so in the same grey as everything
                  else — the whole point of folding is that what stays must still be readable at a
                  glance, and those two are the states you must never misread. */}
              {agent.hold && <span className="text-[#c47f18]">⏸</span>}
              <span className={planning ? "text-[var(--sakura)]" : ""}>{planning ? "plan" : "code"}</span>
              {!planning && <span className={perm === "bypassPermissions" ? "text-green-400" : ""}>· {PERM_LABEL[perm]}</span>}
              <span className="text-neutral-600">⌄</span>
            </button>
            <span className="ml-auto flex min-w-0 items-center gap-1.5 text-[10px] text-neutral-500">{statusEl}</span>
            {modeOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setModeOpen(false)} />
                {/* Opens UPWARD: it hangs off the composer, which is already at the bottom of the pane,
                    so downward would render it outside the pane's `overflow-hidden` box. */}
                <div className="absolute bottom-full left-0 z-20 mb-1 flex flex-wrap items-center gap-1.5 rounded-xl border border-white/10 bg-neutral-900 p-2 shadow-2xl">
                  <ModeControls hold={agent.hold} onHold={agent.setHold} planning={planning} onPlan={setPlan} perm={perm} onPerm={setPermLevel} />
                </div>
              </>
            )}
          </div>
        ) : null /* micro: even the bar goes. Focusing the composer brings it straight back (`dc`), and
                    a turn in flight still animates in the transcript, so "is it working" is never lost. */}
        {/* Preview what's attached BEFORE sending. Same component, same path-detection as the
            transcript — so a pasted screenshot, a picked file, and the message you eventually send all
            agree by construction rather than by three code paths staying in sync. */}
        <div className="px-1"><ImageRefs text={input} /></div>
        {/* The queued MESSAGES now render in the transcript, where you said them. What stays here is
            only the part that is about this control rather than about the conversation: what will
            happen when the current turn ends. Without a word here the alternative reading of a message
            that visibly went nowhere is "my send didn't work". */}
        {agent.queued.length > 0 && (
          <span className="px-1 pb-1 text-[10px] text-neutral-600">
            {agent.queued.length === 1 ? "1 message queued — runs next, when this turn ends" : `${agent.queued.length} messages queued — they run in order, when this turn ends`} · Stop skips ahead
          </span>
        )}
        {/* The E in SHE, and it is scoped to THIS row on purpose. Focus here — you are about to send
            something — and the pane spends a tier back: the folded pill unfolds into the real Plan/Code
            and approval controls, which is the one moment before Enter when what mode you're in is the
            thing you most need to see. The mode pill itself is deliberately NOT inside this row, or
            clicking it would expand the footer out from under its own popover. */}
        <div className={`flex items-end gap-2 rounded-xl border bg-white/[0.03] transition-colors ${roomy ? "px-3 py-2" : "px-2.5 py-1.5"} ${agent.busy ? "border-white/10 opacity-70" : "border-white/15 focus-within:border-[var(--sakura)]/60"}`}
          onFocusCapture={() => setComposing(true)}
          // relatedTarget is where focus is GOING. Without this test, tabbing from the textarea to the
          // send/stop buttons beside it would collapse the controls mid-gesture and move the button out
          // from under the cursor — and with queueing there are now TWO buttons over there to reach.
          onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setComposing(false); }}>
          {atLeast(dc, "tight") && (
            <button onClick={() => setAttachOpen(true)} disabled={!cwd} title="Attach a file (inserts its path for Claude to read)"
              className="shrink-0 self-end rounded-md px-1 py-1 text-neutral-500 transition-colors hover:text-neutral-200 disabled:opacity-30">📎</button>
          )}
          <Composer
            value={input} onChange={setInput} onSubmit={submit}
            // "Message Claude in minami-dashboard…" wraps to three lines in a narrow pane, and the
            // composer's own comment (see Composer.tsx) records that the browser lays out the
            // placeholder for real — so a long one isn't just ugly, it's what the empty box is sized by.
            // The busy label stays as-is: "Queue a follow-up" is already short, and what it says is the
            // single most important thing about a busy composer now that typing into one isn't a no-op.
            placeholder={agent.busy ? "Queue a follow-up…" : atLeast(d, "snug") ? `Message Claude in ${proj}…` : "Message Claude…"} />
          {/* Stop is no longer the ONLY thing you can do mid-turn, so it stops being the button that
              replaces Send. Two independent controls now: queue-send appears whenever there's text to
              send (busy or not), and Stop appears whenever a turn is in flight. Both visible at once is
              the point — mid-flight steering is "queue the correction, then stop the work it corrects",
              and that's two clicks that must not fight over one slot. */}
          {agent.busy && (
            <button onClick={agent.stop} disabled={agent.stopping} title="Stop this turn (anything queued still runs)"
              className="shrink-0 rounded-lg bg-red-500/90 px-2.5 py-1 text-xs font-medium text-white transition-opacity enabled:hover:opacity-90 disabled:opacity-50">
              {agent.stopping ? "⋯" : "■"}
            </button>
          )}
          <button onClick={submit} disabled={!input.trim() || !cwd}
            title={agent.busy ? "Queue this for after the current turn" : "Send"}
            className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium text-white transition-opacity enabled:hover:opacity-90 disabled:opacity-30 ${agent.busy ? "bg-[#c47f18]/90" : "bg-[var(--sakura)]"}`}>
            {agent.busy ? "＋↵" : "↵"}
          </button>
        </div>
      </div>
      </div>
      {showSidePanel && !browserStacked && (
        <>
        <div onMouseDown={() => { pendingBrowserW.current = browserW; setBrowserDrag(true); }} title="Drag to resize"
          className="group relative w-1 shrink-0 cursor-col-resize bg-white/[0.07] transition-colors hover:bg-[#5ec8f8]/40">
          <span className="absolute inset-y-0 -left-1 -right-1" />
        </div>
        <div ref={browserPaneRef} className="flex min-h-0 shrink-0 flex-col" style={{ width: `${browserW}%` }}>
          {/* Tabs only when there's a genuine choice — a session that never opened a browser shouldn't
              pay a row of chrome to be told so. */}
          {canShowBrowser && canShowFile && <SlotTabs slot={activeSlot!} onPick={setSlot} fileCount={files.files.length} />}
          {activeSlot === "browser" ? (
            <BrowserPanel
              state={browser} busy={browserBusy} actionLabel={browserActionLabel} cwd={cwd}
              live={!!cwd && !agent.busy} stacked={false}
              onOpenShot={setLightbox} onAsk={askBrowser}
              onClose={() => setBrowserPanelHidden(true)}
              onToggleLayout={() => setBrowserStacked(true)}
              onPopOut={() => window.open(`/browser/${sessionId || "live"}?cwd=${encodeURIComponent(cwd)}`, `browser-${sessionId}`, "width=1100,height=880")}
            />
          ) : (
            <FilePanel
              state={files} cwd={cwd} stacked={false} activePath={filePath} onPick={setFilePath}
              onClose={() => setBrowserPanelHidden(true)}
              onToggleLayout={() => setBrowserStacked(true)}
            />
          )}
        </div>
        </>
      )}
      </div>
      {showSidePanel && browserStacked && (
        <div className="flex min-h-0 shrink-0 flex-col" style={{ flexBasis: "45%" }}>
          {canShowBrowser && canShowFile && <SlotTabs slot={activeSlot!} onPick={setSlot} fileCount={files.files.length} />}
          {activeSlot === "browser" ? (
            <BrowserPanel
              state={browser} busy={browserBusy} actionLabel={browserActionLabel} cwd={cwd}
              live={!!cwd && !agent.busy} stacked
              onOpenShot={setLightbox} onAsk={askBrowser}
              onClose={() => setBrowserPanelHidden(true)}
              onToggleLayout={() => setBrowserStacked(false)}
              onPopOut={() => window.open(`/browser/${sessionId || "live"}?cwd=${encodeURIComponent(cwd)}`, `browser-${sessionId}`, "width=1100,height=880")}
            />
          ) : (
            <FilePanel
              state={files} cwd={cwd} stacked activePath={filePath} onPick={setFilePath}
              onClose={() => setBrowserPanelHidden(true)}
              onToggleLayout={() => setBrowserStacked(false)}
            />
          )}
        </div>
      )}
      {lightbox !== null && browser.shots.length > 0 && (
        <BrowserLightbox
          shots={browser.shots} index={Math.min(lightbox, browser.shots.length - 1)} cwd={cwd}
          onIndex={setLightbox} onClose={() => setLightbox(null)}
        />
      )}
      {attachOpen && <FolderPicker pickFiles start={cwd} onClose={() => setAttachOpen(false)}
        // Quote a path containing spaces. Unquoted it is ambiguous to every reader of this text —
        // Claude, the thumbnail matcher, and the inliner all stop at the first space — and the most
        // common file anyone attaches on a Mac is "Screen Shot … .png".
        onPick={(p) => { const q = /\s/.test(p) ? `"${p}"` : p; setInput((v) => (v ? v.replace(/\s*$/, " ") : "") + q + " "); setAttachOpen(false); }} />}
    </div>
    </DensityContext.Provider>
  );
}

