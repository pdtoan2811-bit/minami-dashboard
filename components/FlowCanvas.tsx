"use client";

// The Flow canvas — the session's journey, drawn where the bento lives.
//
// ── v4: the unit is the ASK, and the content is meaning ──────────────────────────────────────────
// v3 drew one TURN at a time, as a spine of plan steps with every tool call hanging off it as its own
// node. Two things were wrong with that, and they were the same thing twice:
//
//   1. **A turn is not a journey.** You could read one turn perfectly and still have no idea whether
//      the thing you asked for four turns ago ever finished. The pager (‹ turn 7/23 ›) made the
//      question "where am I on the way to what I wanted" impossible to even ask.
//   2. **Tool calls are not steps.** `Read · Read · Grep · Bash · Edit · Bash` is a log, not an
//      account of the work. It is maximally detailed and minimally informative — you have to re-derive
//      the meaning yourself, which is the labour the view was supposed to save.
//
// So v4 is one spine for the WHOLE SESSION, one node per thing you asked for, and each node says what
// was wanted and how it turned out. Tool calls still exist — they are two clicks deep, as evidence,
// which is the only time anyone wants them.
//
// ── two sources of the sentence, and their order matters ─────────────────────────────────────────
// The line under each node comes from `lib/flow-model.ts` (rules: "changed 3 files · 2 checks passed")
// or from `lib/flow-narrate.ts` (Haiku: "rewired the deploy gate to refuse a busy pane; timeout left
// unwired"). The narrative is strictly additive — it renders when present and the rules line renders
// when it isn't, so a box with narration off, or offline, still shows something true. Never invert
// this: a view that goes blank without a model call is a view that is broken most of the time.
//
// ── why it fetches its own transcript ────────────────────────────────────────────────────────────
// The canvas lives in page scope, the chat panes each own their own `useAgent`. Rather than reach
// across into a pane's live SSE state (two subscribers to one session, two copies of the truth), this
// reads the session's transcript over HTTP and folds it with the same model the chat uses. The JSONL
// is what the pane reconciles to anyway, so the two cannot disagree about what ran — the canvas is at
// most one poll behind, which for reviewing a journey is the right trade.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node, type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle, Check, ChevronRight, CircleDashed, CircleDot, FileDiff, HelpCircle, Loader2,
  Sparkles, Terminal, Users, X,
} from "lucide-react";
import { buildJourney, type FlowStep, type FlowTool, type Journey, type Milestone, type Narrative } from "@/lib/flow-model";
import { activityLabel } from "@/lib/use-agent";
import BrandIcon, { type Icon } from "@/components/BrandIcon";
import { loadTechIcons } from "@/lib/tech-icons";

type SourceTurn = { role: "user" | "assistant"; text: string; tools: FlowTool[]; streaming?: boolean; thinking?: string; ts?: number; cost?: number; off?: number };

// Same semantic key as /architecture's ModuleGraph, so the two canvases read as one system. `open` is
// new in v4 and deliberately amber rather than red: an abandoned step is not an error, it is a loose
// end — the distinction is the whole reason this view exists.
const TONE = {
  running: { tint: "#c4486a", label: "running" },
  done: { tint: "#1f8a5c", label: "done" },
  open: { tint: "#c47f18", label: "open" },
  question: { tint: "#6d5ae0", label: "your turn" },
} as const;
const TOOL_TINT = "#0f7f9c";

const COL_X = 40;
const NODE_W = 330;
const STEP_X = COL_X + NODE_W + 60;
const STEP_W = 290;
const RAW_X = STEP_X + STEP_W + 48;
const RAW_W = 260;

const GAP = 16;
const H_COLLAPSED = 50;
const H_RAW = 46;

const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function fmtMs(ms: number): string {
  if (!ms || ms < 0) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
// Sub-cent costs are noise on a node that already has four numbers on it, and a turn parsed before
// `Turn.cost` existed reports 0 — which is unknown, not free. Both render as nothing.
const fmtCost = (c: number): string => (c >= 0.01 ? `$${c.toFixed(2)}` : "");

/** The tone a milestone is drawn in. A finished milestone that ended by asking YOU something is not
 *  "done" in any sense the reader cares about — it is waiting, and it gets its own colour. */
function toneOf(m: Milestone): keyof typeof TONE {
  if (m.status === "running") return "running";
  if (m.narrative?.verdict === "question") return "question";
  if (m.status === "open" || m.narrative?.verdict === "open") return "open";
  if (m.narrative?.verdict === "partial") return "open";
  return "done";
}

// Heights are estimated rather than measured because React Flow positions nodes absolutely — the same
// trade v3 made. Over-estimating costs whitespace; under-estimating overlaps nodes, so every estimate
// here rounds up.
function estMilestone(m: Milestone): number {
  const lines = Math.min(2, Math.ceil(m.ask.length / 46));
  const outcome = m.narrative?.outcome || m.headline;
  // The stack row and the call preview are part of the node's height, not decoration on top of it —
  // omitting them here is how you get a spine whose nodes overlap the phases hanging beside them.
  const evidence = (m.stack.length || m.recent.length) ? 8 + (m.stack.length ? 21 : 0) + m.recent.length * 14 : 0;
  return 34 + lines * 15 + Math.ceil(Math.min(outcome.length, 132) / 44) * 14 + evidence + 20;
}
function estStep(s: FlowStep, rawOpen: boolean): number {
  const files = Math.min(s.files.length, 3);
  const checks = Math.min(s.checks.length, 3);
  return 30 + Math.ceil(Math.min(s.title.length, 90) / 38) * 14 + (s.headline ? 14 : 0)
    + files * 13 + checks * 13 + 16 + (s.tools.length ? 14 : 0) + (rawOpen ? 0 : 0);
}

function Canvas({ journey, busy, open, rawOpen, toggle, toggleRaw, techIcons }: {
  journey: Journey; busy: boolean;
  open: Set<string>; rawOpen: Set<string>;
  toggle: (k: string) => void; toggleRaw: (k: string) => void;
  techIcons: Record<string, Icon>;
}) {
  const { fitView } = useReactFlow();

  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    let y = 0;
    let prevId: string | null = null;

    journey.milestones.forEach((m) => {
      const tone = TONE[toneOf(m)];
      const isOpen = open.has(m.key);
      const id = `m:${m.key}`;
      const outcome = m.narrative?.outcome || m.headline;

      // ── the collapsed form: one dense line ──────────────────────────────────────────────────────
      // A hundred-turn session is a hundred nodes, and a hundred full-size nodes is a wall you scroll
      // past rather than read. Everything settled shrinks to its ask and its verdict; the live one is
      // open. This is the "collapse the past, expand the live" shape — the past stays *reachable*,
      // which is the part a windowed view would get wrong.
      if (!isOpen) {
        nodes.push({
          id,
          position: { x: COL_X, y },
          data: {
            live: m.status === "running",
            label: (
              <div className="flex items-center gap-2 text-left leading-tight">
                <span className="font-mono text-[9px] tabular-nums text-neutral-600">{m.index + 1}</span>
                <StatusDot status={m.status} tint={tone.tint} />
                <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-300">{clamp(m.ask, 46)}</span>
                {/* The one thing worth spending collapsed width on. A settled milestone's ask is already
                    truncated, so this is a real trade — but "which of these fifty asks was the Python
                    one" is answerable by glance with it and only by reading without it, and reading
                    fifty one-liners is the thing collapsing them was meant to avoid. */}
                <StackRow stack={m.stack} icons={techIcons} size={13} max={3} />
                {m.goals.total > 0 && (
                  <span className="shrink-0 font-mono text-[9px] tabular-nums" style={{ color: tone.tint }}>
                    {m.goals.done}/{m.goals.total}
                  </span>
                )}
                <ChevronRight className="h-3 w-3 shrink-0 text-neutral-600" />
              </div>
            ),
          },
          style: {
            width: NODE_W, padding: "7px 10px", borderRadius: 10,
            // Longhand, never `border` + `borderLeft` together: React warns that mixing shorthand and
            // non-shorthand for the same value across a re-render "can lead to styling bugs", and on a
            // node whose tint changes as a milestone settles, that re-render happens constantly.
            borderStyle: "solid", borderColor: "#2a303c", borderWidth: "1px 1px 1px 3px",
            borderLeftColor: tone.tint,
            background: "#12151c", color: "#e5e7eb",
          },
          sourcePosition: Position.Bottom, targetPosition: Position.Top, draggable: false,
        });
        if (prevId) edges.push(spineEdge(prevId, id, tone.tint, false));
        prevId = id;
        y += H_COLLAPSED + GAP;
        return;
      }

      // ── the expanded form ───────────────────────────────────────────────────────────────────────
      nodes.push({
        id,
        position: { x: COL_X, y },
        data: {
          live: m.status === "running",
          label: (
            <div className="text-left leading-tight">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[9px] tabular-nums text-neutral-600">{m.index + 1}</span>
                <StatusDot status={m.status} tint={tone.tint} />
                <span className="font-mono text-[9px] uppercase tracking-[.14em]" style={{ color: tone.tint }}>
                  {m.narrative?.verdict === "question" ? "your turn" : tone.label}
                </span>
                {m.goals.total > 0 && (
                  <span className="font-mono text-[9px] tabular-nums text-neutral-500">{m.goals.done}/{m.goals.total} goals</span>
                )}
                <ChevronRight className="ml-auto h-3 w-3 rotate-90 text-neutral-600" />
              </div>
              {/* What you asked for, verbatim-ish. The anchor of the whole node — a summary with no
                  visible ask above it is a claim you cannot check. */}
              <div className="mt-1.5 line-clamp-2 text-[11.5px] font-medium text-neutral-100">{clamp(m.ask, 150)}</div>
              {/* What happened about it. Haiku's sentence when there is one, the rules' when there isn't. */}
              {outcome && (
                <div className="mt-1 line-clamp-3 text-[10.5px] text-neutral-400">
                  {m.narrative && <Sparkles className="mr-1 inline h-2.5 w-2.5 align-[-1px] text-[#6d5ae0]" />}
                  {clamp(outcome, 160)}
                </div>
              )}
              {/* What it worked IN, and the last three things it actually did. The rest of the node is
                  a summary — these two rows are the only unmediated evidence on it, which is why they
                  sit directly above the meta row and below every claim they back up. */}
              {(m.stack.length > 0 || m.recent.length > 0) && (
                <div className="mt-2 border-t border-white/[0.07] pt-1.5">
                  {m.stack.length > 0 && (
                    <div className="mb-1 flex items-center gap-1.5">
                      <StackRow stack={m.stack} icons={techIcons} size={16} max={5} />
                    </div>
                  )}
                  <RecentCalls tools={m.recent} live={m.status === "running"} />
                </div>
              )}
              <MetaRow ms={m.ms} cost={m.cost} files={m.files.length} checks={m.checks} />
            </div>
          ),
        },
        style: {
          width: NODE_W, padding: "9px 11px", borderRadius: 12,
          borderStyle: "solid", borderColor: tone.tint, borderWidth: "1px 1px 1px 3px",
          background: "#171b24", boxShadow: `0 0 0 2px ${tone.tint}33`,
        },
        sourcePosition: Position.Bottom, targetPosition: Position.Top, draggable: false,
      });
      if (prevId) edges.push(spineEdge(prevId, id, tone.tint, m.status === "running" && busy));
      prevId = id;

      // Steps hang RIGHT of the spine, so the journey stays a readable column however much is open —
      // and they are CHAINED to each other rather than fanned from the milestone. A fan drew eight
      // elbows all leaving the same bottom handle and travelling hundreds of pixels down, which is
      // visual noise carrying no information; the chain costs nothing and states something true, which
      // is that these phases happened in this order.
      let cy = y;
      let prevStepId: string | null = null;
      m.turn.steps.forEach((s, si) => {
        const sid = `s:${m.key}:${s.key}`;
        const rawKey = `${m.key}/${s.key}`;
        const showRaw = rawOpen.has(rawKey);
        const stTint = s.status === "in_progress" ? TONE.running.tint : s.status === "completed" ? TONE.done.tint : "#4e5665";

        nodes.push({
          id: sid,
          position: { x: STEP_X, y: cy },
          data: {
            label: (
              <div className="text-left leading-tight">
                <div className="flex items-center gap-1.5">
                  <StatusDot status={s.status === "in_progress" ? "running" : s.status === "completed" ? "done" : "queued"} tint={stTint} />
                  <span className="font-mono text-[9px] uppercase tracking-[.12em]" style={{ color: stTint }}>
                    {s.synthetic ? "phase" : `goal ${si + 1}`}
                  </span>
                  {s.tools.length > 0 && (
                    <span className="ml-auto flex items-center gap-0.5 text-[9px] text-neutral-600">
                      <Terminal className="h-2.5 w-2.5" />{s.tools.length}
                      <ChevronRight className={`h-2.5 w-2.5 transition-transform ${showRaw ? "rotate-90" : ""}`} />
                    </span>
                  )}
                </div>
                <div className="mt-1 line-clamp-2 text-[11px] text-neutral-200">{clamp(s.title, 90)}</div>
                {s.headline && <div className="mt-0.5 text-[9.5px] text-neutral-500">{s.headline}</div>}
                {/* Evidence, not claims. Files it actually wrote and commands that actually returned. */}
                {s.files.slice(0, 3).map((f) => (
                  <div key={f} className="mt-0.5 flex items-center gap-1 truncate font-mono text-[9px] text-[#c47f18]">
                    <FileDiff className="h-2.5 w-2.5 shrink-0" />{f.split("/").slice(-2).join("/")}
                  </div>
                ))}
                {s.files.length > 3 && <div className="mt-0.5 text-[9px] text-neutral-600">+{s.files.length - 3} more files</div>}
                {s.checks.slice(0, 3).map((c, ci) => (
                  <div key={ci} className={`mt-0.5 flex items-center gap-1 truncate font-mono text-[9px] ${c.ok === false ? "text-[#c4486a]" : c.ok ? "text-[#1f8a5c]" : "text-neutral-500"}`}>
                    {c.ok === false ? <AlertTriangle className="h-2.5 w-2.5 shrink-0" /> : <Check className="h-2.5 w-2.5 shrink-0" />}
                    {clamp(c.label, 34)}
                  </div>
                ))}
                {s.agents.map((a, ai) => (
                  <div key={ai} className="mt-0.5 flex items-center gap-1 truncate text-[9px] text-[#1f8a5c]">
                    <Users className="h-2.5 w-2.5 shrink-0" />{clamp(a.description, 34)}
                  </div>
                ))}
                <MetaRow ms={s.t1 && s.t0 ? s.t1 - s.t0 : 0} cost={s.cost} files={0} checks={[]} />
              </div>
            ),
          },
          style: {
            width: STEP_W, padding: "7px 9px", borderRadius: 10,
            border: `1px solid ${showRaw ? stTint : "#2a303c"}`,
            background: showRaw ? "#161b24" : "#11141b", color: "#cbd2de",
            opacity: s.status === "pending" ? 0.62 : 1,
          },
          // The first phase is entered from the LEFT (off the milestone); the rest are entered from the
          // top by the phase above them. A default React Flow node has exactly ONE source handle, so
          // the chain and the raw-tool fan necessarily share it — bottom, where the chain needs it.
          sourcePosition: Position.Bottom,
          targetPosition: prevStepId ? Position.Top : Position.Left,
          draggable: false,
        });
        edges.push(prevStepId
          ? { id: `e:${prevStepId}->${sid}`, source: prevStepId, target: sid, style: { stroke: `${stTint}44`, strokeWidth: 1.2 } }
          : { id: `e:${id}->${sid}`, source: id, target: sid, type: "smoothstep", style: { stroke: `${stTint}55`, strokeWidth: 1.2 } });
        prevStepId = sid;

        const stepH = estStep(s, showRaw);
        // ── the raw log: two clicks deep, deliberately ────────────────────────────────────────────
        // This is v3's entire default view, demoted. It is the right thing to have and the wrong thing
        // to lead with: you want it exactly when a step's summary looks wrong, and never otherwise.
        if (showRaw) {
          let ry = cy;
          s.tools.forEach((t, ti) => {
            const ok = t.done === false ? null : t.ok !== false;
            const rid = `${sid}:t${ti}`;
            nodes.push({
              id: rid,
              position: { x: RAW_X, y: ry },
              data: {
                label: (
                  <div className="text-left leading-tight">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[9px] uppercase tracking-[.12em]" style={{ color: ok === false ? TONE.running.tint : TOOL_TINT }}>{t.name}</span>
                      <span className="ml-auto text-[9px] tabular-nums text-neutral-600">
                        {ok === null ? "running…" : `${ok ? "✓" : "✗"}${t.ms ? ` ${(t.ms / 1000).toFixed(1)}s` : ""}`}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[9.5px] text-neutral-500">{clamp(activityLabel(t.name, t.input), 42)}</div>
                  </div>
                ),
              },
              style: {
                width: RAW_W, padding: "6px 8px", borderRadius: 8,
                border: `1px solid ${(ok === false ? TONE.running.tint : TOOL_TINT)}44`, background: "#0e1117", color: "#9aa3b2",
              },
              sourcePosition: Position.Right, targetPosition: Position.Left, draggable: false, selectable: false,
            });
            edges.push({ id: `e:${sid}->${rid}`, source: sid, target: rid, type: "smoothstep", style: { stroke: `${TOOL_TINT}33`, strokeWidth: 1 } });
            ry += H_RAW;
          });
          cy = Math.max(cy + stepH, ry) + 10;
        } else {
          cy += stepH + 10;
        }
      });

      y = Math.max(y + estMilestone(m), cy) + GAP;
    });

    return { nodes, edges };
    // `techIcons` is a dep because the manifest lands AFTER the first render: without it the nodes are
    // memoized with an empty map and every stack row stays a lettermark for the life of the canvas.
  }, [journey, open, rawOpen, busy, techIcons]);

  // Re-frame on the thing you are most likely to be looking at: the live milestone, else the last one
  // you expanded. Fitting a session-long spine whole would scale it to unreadable — which is exactly
  // the failure v3 fixed for a ten-step plan, and a hundred-milestone journey is ten times worse.
  const focus = useMemo(() => {
    const live = nodes.find((n) => n.id.startsWith("m:") && (n.data as { live?: boolean })?.live);
    // The expanded milestone's PHASES are the reason it was expanded, so they have to be inside the
    // frame — fitting the spine node alone put the whole fan off the bottom of the canvas, which reads
    // as "clicking it did nothing much" until you think to scroll.
    const keys = live ? [live.id.slice(2)] : [...open];
    if (!keys.length) return undefined;
    const want = nodes.filter((n) => keys.some((k) => n.id === `m:${k}` || n.id.startsWith(`s:${k}:`)));
    return want.length ? want.map((n) => ({ id: n.id })) : undefined;
  }, [nodes, open]);

  useEffect(() => {
    const t = setTimeout(() => {
      fitView({ padding: 0.18, duration: 260, minZoom: 0.65, maxZoom: 1, ...(focus ? { nodes: focus } : {}) });
    }, 60);
    return () => clearTimeout(t);
  }, [nodes.length, focus, fitView]);

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    if (node.id.startsWith("m:")) return toggle(node.id.slice(2));
    // `s:<milestoneKey>:<stepKey>` — a step key can itself contain ':' only via the task#N form, which
    // cannot, so splitting on the FIRST two segments is safe. Rebuilt rather than sliced blindly.
    if (node.id.startsWith("s:")) {
      const rest = node.id.slice(2);
      const cut = rest.indexOf(":");
      if (cut > 0) toggleRaw(`${rest.slice(0, cut)}/${rest.slice(cut + 1)}`);
    }
  }, [toggle, toggleRaw]);

  return (
    <ReactFlow
      nodes={nodes} edges={edges} onNodeClick={onNodeClick}
      fitView proOptions={{ hideAttribution: true }}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable
      minZoom={0.25} maxZoom={1.6}
      className="[&_.react-flow__node]:cursor-pointer"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#242a35" />
    </ReactFlow>
  );
}

function spineEdge(from: string, to: string, tint: string, animated: boolean): Edge {
  return { id: `e:${from}->${to}`, source: from, target: to, animated, style: { stroke: tint, strokeWidth: 1.6, opacity: 0.8 } };
}

function StatusDot({ status, tint }: { status: string; tint: string }) {
  if (status === "running" || status === "in_progress") return <span className="h-2 w-2 shrink-0 animate-pulse rounded-full" style={{ background: tint }} />;
  if (status === "queued" || status === "pending") return <CircleDashed className="h-3 w-3 shrink-0" style={{ color: tint }} strokeWidth={2.2} />;
  if (status === "open") return <AlertTriangle className="h-3 w-3 shrink-0" style={{ color: tint }} strokeWidth={2.2} />;
  return <CircleDot className="h-3 w-3 shrink-0" style={{ color: tint }} strokeWidth={2.2} />;
}

/** The stack a milestone worked in, as brand icons (lib/flow-stack.ts derives the slugs from the calls
 *  themselves, so this row differs from ask to ask — unlike the topic's own AttachBar row, which would
 *  be identical on every node here and therefore say nothing).
 *
 *  `icons` arriving empty is normal for the first frame — BrandIcon falls back to a lettermark tile, so
 *  the row has its final HEIGHT immediately and the node doesn't reflow when the manifest lands. */
function StackRow({ stack, icons, size, max }: { stack: string[]; icons: Record<string, Icon>; size: number; max: number }) {
  if (!stack.length) return null;
  const shown = stack.slice(0, max);
  return (
    <span className="flex shrink-0 items-center gap-1" title={`worked in: ${stack.join(", ")}`}>
      {shown.map((s) => <BrandIcon key={s} slug={s} icons={icons} size={size} />)}
      {stack.length > max && <span className="font-mono text-[8px] text-neutral-600">+{stack.length - max}</span>}
    </span>
  );
}

/** The newest few tool calls, in the order they ran.
 *
 *  This is a deliberate, narrow exception to "tool calls are two clicks deep" — the rule that shaped v4
 *  and is still right for the other several hundred calls in a session. The exception earns itself on
 *  the LIVE milestone, where the question is "what is it touching right now" and the answer was
 *  previously two clicks and a guess about which phase to open; on a settled one the same three rows
 *  are the cheapest possible check that the summary above them is describing real work. Three is the
 *  whole budget — see RECENT_CALLS. */
/** The name column, short enough to leave room for the thing that actually says what happened.
 *
 *  An MCP tool's real name is `mcp__playwright__browser_navigate`, and three of those stacked read as
 *  `MCP__PLAYWRIG… / MCP__PLAYWRIG… / MCP__PLAYWRIG…` — a column of identical prefixes where the
 *  distinguishing part has been clipped off the end. The server half is already on the node as its
 *  brand icon, so this drops it and the `browser_` noun that every browser verb repeats. */
function shortToolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? m[2].replace(/^browser_/, "") : name;
}

function RecentCalls({ tools, live }: { tools: FlowTool[]; live: boolean }) {
  if (!tools.length) return null;
  return (
    <div className="flex flex-col gap-[1px]">
      {tools.map((t, i) => {
        // Same tri-state as the raw log: `null` is "still running", which is not a failure and must not
        // be drawn as one. Only the LAST call can be in flight, and only on a live milestone.
        const running = t.done === false && live && i === tools.length - 1;
        const ok = t.done === false ? null : t.ok !== false;
        return (
          <div key={t.id || `${t.name}:${i}`} className="flex items-center gap-1 leading-tight">
            <span className={`h-1 w-1 shrink-0 rounded-full ${running ? "animate-pulse" : ""}`}
              style={{ background: ok === false ? TONE.running.tint : running ? TONE.running.tint : TOOL_TINT, opacity: ok === null && !running ? 0.4 : 1 }} />
            <span className="shrink-0 font-mono text-[8.5px] uppercase tracking-[.1em]"
              // 16 rather than 14 because `take_screenshot` is 15 and was the one common verb that
              // clipped — and a clipped name is exactly the failure this shortening set out to fix.
              style={{ color: ok === false ? TONE.running.tint : TOOL_TINT }}>{clamp(shortToolName(t.name), 16)}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-neutral-500">
              {clamp(activityLabel(t.name, t.input), 40)}
            </span>
            {ok === false && <AlertTriangle className="h-2 w-2 shrink-0 text-[#c4486a]" />}
          </div>
        );
      })}
    </div>
  );
}

/** Duration · cost · evidence counts. Renders nothing at all when nothing is known, rather than a row
 *  of zeroes — an unparsed cost and a free turn are not the same fact. */
function MetaRow({ ms, cost, files, checks }: { ms: number; cost: number; files: number; checks: { ok: boolean | null }[] }) {
  const d = fmtMs(ms), c = fmtCost(cost);
  const failed = checks.filter((k) => k.ok === false).length;
  const passed = checks.filter((k) => k.ok === true).length;
  if (!d && !c && !files && !checks.length) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2 font-mono text-[9px] tabular-nums text-neutral-600">
      {d && <span>{d}</span>}
      {c && <span>{c}</span>}
      {files > 0 && <span className="flex items-center gap-0.5"><FileDiff className="h-2.5 w-2.5" />{files}</span>}
      {passed > 0 && <span className="flex items-center gap-0.5 text-[#1f8a5c]"><Check className="h-2.5 w-2.5" />{passed}</span>}
      {failed > 0 && <span className="flex items-center gap-0.5 text-[#c4486a]"><AlertTriangle className="h-2.5 w-2.5" />{failed}</span>}
    </div>
  );
}

// How far back the canvas will page. The transcript API hands out one window at a time; a journey that
// stops at the window edge would silently misreport progress ("3 goals" when the session has 30), so it
// pages back until the session is whole or this cap is hit — and says which, rather than pretending.
const MAX_PAGES = 5;

export function FlowCanvas({ sessionId, project, busy = false, onClose }: {
  sessionId: string; project: string;
  /** Whether this session is mid-turn. Supplied by the page from /api/agent/live: the on-disk
   *  transcript has no `streaming` flag (that exists only on the live stream), so deriving it here
   *  silently pinned it to false and the running-step edge never animated. */
  busy?: boolean;
  onClose: () => void;
}) {
  const [tail, setTail] = useState<SourceTurn[]>([]);
  const [head, setHead] = useState<SourceTurn[]>([]);   // older pages, immutable once fetched
  const [bound, setBound] = useState<number | null>(null); // byte offset of the oldest row we hold
  const [more, setMore] = useState(false);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [narratives, setNarratives] = useState<Record<string, Narrative>>({});
  const [narrating, setNarrating] = useState(false);
  const [narrateOn, setNarrateOn] = useState(true);
  // `null` means "the reader hasn't chosen yet", which is a different state from "chose nothing" and
  // has to be representable. The first version used an effect to seed the open set once the journey
  // loaded; between the poll's own state writes and React re-running that effect on every new journey
  // object, the seed and the reset raced and a freshly-opened canvas showed a spine of one-liners with
  // nothing expanded. A derived default cannot race — there is no write to lose.
  const [open, setOpen] = useState<Set<string> | null>(null);
  const [rawOpen, setRawOpen] = useState<Set<string>>(new Set());
  // Module-level cache inside lib/tech-icons, so this is one fetch for the whole app however many
  // panes mount a canvas — and it is NOT keyed on the session, because the manifest never changes.
  const [techIcons, setTechIcons] = useState<Record<string, Icon>>({});
  useEffect(() => { let a = true; loadTechIcons().then((d) => { if (a) setTechIcons(d); }); return () => { a = false; }; }, []);

  // ── what resets, and when ────────────────────────────────────────────────────────────────────
  // Only a change of SESSION resets the view. This used to live inside the poll effect below, which
  // also depends on `busy` — and `busy` flaps between tool calls on a live session, so every few
  // seconds the reader's expanded nodes were silently collapsed and the auto-expand below raced to
  // reopen them. Symptom: opening the flow on a running session showed a spine of one-liners that
  // refused to stay open. Reset is about identity, not about activity.
  const firstLoad = useRef(true);
  useEffect(() => {
    firstLoad.current = true;
    setHead([]); setBound(null); setMore(false); setPages(1);
    setOpen(null); setRawOpen(new Set()); setLoading(true);
  }, [sessionId]);

  // ── the tail poll ────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await (await fetch(`/api/bento/session/${sessionId}`, { cache: "no-store" })).json();
        if (!alive || !Array.isArray(d?.turns)) return;
        setTail(d.turns as SourceTurn[]);
        // Only the FIRST tail read establishes the paging bound. Later polls re-read the same window,
        // and letting them reset it would make the back-pager re-fetch pages already held — a ref
        // rather than reading `bound`, which is stale inside this closure.
        if (firstLoad.current) {
          firstLoad.current = false;
          setBound(d.start ?? 0);
          setMore(!!d.hasMore);
        }
      } catch { /* a canvas that can't reach the log just stays as it was */ }
      finally { if (alive) setLoading(false); }
    };
    load();
    // Fast only while something is actually running. A finished session's transcript cannot change, and
    // re-reading its JSONL every three seconds is real work in the parser for a guaranteed-identical
    // answer — so an idle canvas drops to a slow refresh that exists only to notice a NEW turn starting.
    const iv = setInterval(load, busy ? 3000 : 20_000);
    return () => { alive = false; clearInterval(iv); };
  }, [sessionId, busy]);

  // ── paging back, once, in the background ─────────────────────────────────────────────────────
  // Cascades: each page sets `bound` lower, which re-fires this effect until the session is whole or
  // MAX_PAGES is hit. History below the live tail is immutable, so a page fetched is a page finished.
  useEffect(() => {
    if (!more || bound == null || bound <= 0 || pages >= MAX_PAGES) return;
    let alive = true;
    (async () => {
      try {
        const d = await (await fetch(`/api/bento/session/${sessionId}?before=${bound}`, { cache: "no-store" })).json();
        if (!alive || !Array.isArray(d?.turns) || !d.turns.length) { setMore(false); return; }
        setHead((h) => [...(d.turns as SourceTurn[]), ...h]);
        setBound(d.start ?? 0);
        setMore(!!d.hasMore);
        setPages((p) => p + 1);
      } catch { setMore(false); }
    })();
    return () => { alive = false; };
  }, [sessionId, more, bound, pages]);

  const turns = useMemo(() => [...head, ...tail], [head, tail]);
  const journey = useMemo(() => buildJourney(turns, narratives, { busy }), [turns, narratives, busy]);

  // ── narration ────────────────────────────────────────────────────────────────────────────────
  // Cached sentences are free (a GET), so they load with the canvas. Writing new ones costs a Haiku
  // call, so it fires only when the session is idle and only for milestones that have actually
  // finished — and `asked` remembers what has already been requested, so a summariser that is off,
  // failing, or simply slower than the poll can never turn this into a loop.
  const asked = useRef<string>("");
  useEffect(() => {
    let alive = true;
    fetch(`/api/flow/${sessionId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!alive) return; setNarratives(d?.narratives || {}); setNarrateOn(d?.enabled !== false); })
      .catch(() => { /* rules-only is a fine state */ });
    return () => { alive = false; };
  }, [sessionId]);

  const missing = useMemo(
    () => journey.milestones.filter((m) => m.status !== "running" && !m.narrative).map((m) => m.key),
    [journey],
  );

  useEffect(() => {
    if (!narrateOn || busy || !missing.length || narrating) return;
    const sig = missing.join(",");
    if (asked.current === sig) return;
    asked.current = sig;
    let alive = true;
    setNarrating(true);
    fetch(`/api/flow/${sessionId}`, { method: "POST" })
      .then((r) => r.json())
      .then((d) => { if (alive && d?.narratives) setNarratives(d.narratives); })
      .catch(() => { /* leave the rules headline in place */ })
      .finally(() => { if (alive) setNarrating(false); });
    return () => { alive = false; };
  }, [sessionId, narrateOn, busy, missing, narrating]);

  // Until the reader touches anything, the open node is the live milestone — or, on a settled session,
  // the newest one. Opening onto a column of one-liners with nothing readable would make the canvas
  // look empty on arrival, and "the newest thing, expanded" is what anyone opening this wants first.
  const shown = useMemo(() => {
    if (open) return open;
    const k = journey.milestones[journey.milestones.length - 1]?.key;
    return new Set(k ? [k] : []);
  }, [open, journey]);
  // Toggles start from whatever is currently VISIBLE, including the derived default — otherwise the
  // first click on the auto-opened node would add it a second time instead of closing it.
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const toggle = useCallback((k: string) => setOpen(() => {
    const n = new Set(shownRef.current);
    n.has(k) ? n.delete(k) : n.add(k);
    return n;
  }), []);
  const toggleRaw = useCallback((k: string) => setRawOpen((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; }), []);
  const openAllLoops = useCallback(() => setOpen(() => {
    const n = new Set(shownRef.current);
    for (const l of journey.openLoops) n.add(l.key);
    return n;
  }), [journey.openLoops]);

  const pct = journey.progress.total ? Math.round((journey.progress.done / journey.progress.total) * 100) : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The header IS the "where am I" answer. Everything on it is a count of real plan items, not a
          count of nodes — see Milestone.goals for why synthesized phases are excluded. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-white/10 px-3 py-2">
        <span className="text-[11px] font-semibold tracking-tight">{project}</span>
        <span className="text-[10px] text-neutral-500">journey</span>

        {journey.progress.total > 0 && (
          <span className="flex items-center gap-1.5"
            title={journey.progress.unit === "goals"
              ? `${journey.progress.done} of ${journey.progress.total} planned steps completed across this session`
              : `${journey.progress.done} of ${journey.progress.total} requests resolved — this session never wrote a plan, so there are no goals to count`}>
            <span className="h-1 w-24 overflow-hidden rounded-full bg-white/10">
              <span className="block h-full rounded-full bg-[#1f8a5c] transition-[width] duration-500" style={{ width: `${pct}%` }} />
            </span>
            <span className="font-mono text-[10px] tabular-nums text-neutral-400">
              {journey.progress.done}/{journey.progress.total} {journey.progress.unit}
            </span>
          </span>
        )}

        {journey.openLoops.length > 0 && (
          // The whole point of the rework, in one control: things you started and never closed.
          <button onClick={openAllLoops}
            title={journey.openLoops.map((l) => `${l.ask} — ${l.steps.join("; ")}`).join("\n")}
            className="flex items-center gap-1 rounded-md border border-[#c47f18]/40 bg-[#c47f18]/10 px-1.5 py-0.5 text-[10px] text-[#e0a94a] transition-colors hover:border-[#c47f18]">
            <AlertTriangle className="h-2.5 w-2.5" />
            {journey.progress.open} open loop{journey.progress.open === 1 ? "" : "s"}
          </button>
        )}

        <span className="font-mono text-[10px] tabular-nums text-neutral-600">
          {journey.progress.unit === "goals" && `${journey.milestones.length} ask${journey.milestones.length === 1 ? "" : "s"}`}
          {fmtMs(journey.ms) && `${journey.progress.unit === "goals" ? " · " : ""}${fmtMs(journey.ms)}`}
          {fmtCost(journey.cost) && ` · ${fmtCost(journey.cost)}`}
        </span>

        {/* Says which half of the summary you are reading. A silent narrator looks identical to a
            broken one, and "why are these lines suddenly worse" is not a question worth having. */}
        {narrating ? (
          <span className="flex items-center gap-1 text-[10px] text-[#6d5ae0]"><Loader2 className="h-2.5 w-2.5 animate-spin" />summarising</span>
        ) : !narrateOn ? (
          <span className="flex items-center gap-1 text-[10px] text-neutral-600" title="MINAMI_FLOW_NARRATE=0 — showing rules-derived summaries only"><HelpCircle className="h-2.5 w-2.5" />rules only</span>
        ) : null}

        {more && pages >= MAX_PAGES && (
          <span className="text-[10px] text-neutral-600" title={`Showing the most recent ${MAX_PAGES} pages of this transcript — older turns exist on disk and are not counted above.`}>
            earlier turns not loaded
          </span>
        )}

        <span className="flex-1" />
        <span className="text-[10px] text-neutral-600">click an ask to open it · click a goal for its tool log</span>
        <button onClick={onClose} title="Collapse back to the grid"
          className="rounded-lg p-1 text-neutral-500 transition-colors hover:bg-white/10 hover:text-neutral-200">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {loading && !journey.milestones.length ? (
          <p className="p-4 text-[11px] text-neutral-500">Reading the transcript…</p>
        ) : !journey.milestones.length ? (
          // Says WHY it's empty. "No steps" with nothing else is indistinguishable from a broken fetch.
          <p className="p-4 text-[11px] text-neutral-500">
            Nothing to draw yet{turns.length ? ` — read ${turns.length} message${turns.length === 1 ? "" : "s"}, none of them a request` : ""}.
          </p>
        ) : (
          // `useReactFlow()` reads from context, so it needs a provider ABOVE the component that calls
          // it — being the same component that renders <ReactFlow> is not enough, and fails at runtime
          // with "Seems like you have not used ReactFlowProvider as an ancestor".
          <ReactFlowProvider>
            <Canvas journey={journey} busy={busy} open={shown} rawOpen={rawOpen} toggle={toggle} toggleRaw={toggleRaw} techIcons={techIcons} />
          </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}
