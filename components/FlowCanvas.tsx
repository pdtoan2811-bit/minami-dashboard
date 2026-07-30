"use client";

// The Flow canvas — the step graph, drawn where the bento lives.
//
// ── Where this belongs, third time ───────────────────────────────────────────────────────────────
// v1 put the graph behind a per-project *view mode* picked from a hover-revealed gear: unfindable,
// and it replaced the transcript. v2 over-corrected — it threw the canvas away entirely and rebuilt
// the flow as a list inside the chat. Both missed what was actually asked for, which is this: the
// graph belongs on the LEFT, in the bento column, and a switch on a tile should **expand that tile
// into the canvas** with the grid's own motion, shifting its neighbours aside.
//
// So React Flow is back, and it is the right tool here — this IS a canvas now, with room to pan a
// wide plan. What went is the part that was actually complained about: the **minimap**, and the zoom
// controls with it. `fitView` re-frames on every plan change, which is what a minimap was standing in
// for. Scroll still zooms; drag still pans.
//
// ── Why it fetches its own transcript ────────────────────────────────────────────────────────────
// The canvas lives in page scope, the chat panes each own their own `useAgent`. Rather than reach
// across into a pane's live SSE state (two subscribers to one session, two copies of the truth), this
// reads the session's transcript over HTTP and folds it with the same `buildFlow` the chat uses. The
// JSONL is what the pane reconciles to anyway, so the two cannot disagree about what ran — the canvas
// is at most one poll behind, which for reviewing a plan is the right trade.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background, BackgroundVariant, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Edge, type Node, type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ChevronRight, CircleDot, FileDiff, Sparkles, Users, X } from "lucide-react";
import { buildFlow, type FlowTool, type FlowTurn } from "@/lib/flow-model";
import { activityLabel } from "@/lib/use-agent";

type SourceTurn = { role: "user" | "assistant"; text: string; tools: FlowTool[]; streaming?: boolean; thinking?: string };

// Same semantic key as /architecture's ModuleGraph, so the two canvases read as one system.
const STATUS = {
  in_progress: { tint: "#c4486a", label: "running" },
  completed: { tint: "#1f8a5c", label: "done" },
  pending: { tint: "#4e5665", label: "queued" },
} as const;

const NODE_W = 300;
const COL_X = 40;      // the spine
const CHILD_X = COL_X + NODE_W + 56;
const CHILD_W = 250;
const ROW_GAP = 22;

const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// NOTE: v1 drew a "held for review" state here, because it had the pane's live SSE state and could
// see a parked tool call. This component reads the transcript from disk, so it cannot — the held prompt
// is answered in the chat pane, where that state actually lives. The rendering for it is deliberately
// absent rather than present-but-unreachable.

function Canvas({ turn, busy, open, toggle }: {
  turn: FlowTurn | undefined; busy: boolean; open: Set<string>; toggle: (k: string) => void;
}) {
  const { fitView } = useReactFlow();
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    if (!turn) return { nodes, edges };

    let y = 0;
    // The request opens the spine — a step graph with no visible ask reads as activity without a cause.
    nodes.push({
      id: "request",
      position: { x: COL_X, y },
      data: {
        label: (
          <div className="text-left leading-tight">
            <div className="font-mono text-[9.5px] uppercase tracking-[.14em] text-neutral-500">request</div>
            <div className="mt-1 line-clamp-3 text-[11.5px] text-neutral-200">{clamp(turn.request || "(continued)", 220)}</div>
          </div>
        ),
      },
      style: { width: NODE_W, padding: "9px 11px", borderRadius: 12, border: "1px solid #3a4150", background: "#12151c", color: "#e5e7eb" },
      sourcePosition: Position.Bottom, targetPosition: Position.Top,
      draggable: false, selectable: false,
    });
    y += 92;

    let prevId = "request";
    // Numbered over PLAN steps only. Counting the array position instead made the first real step read
    // "2" whenever a preamble node existed — a number that matches nothing in the plan Claude wrote.
    let n = 0;
    turn.steps.forEach((step) => {
      if (!step.synthetic) n++;
      const st = STATUS[step.status];
      const tint = st.tint;
      const isOpen = open.has(step.key);
      const id = `s:${step.key}`;
      const childCount = step.tools.length + (step.thinking ? 1 : 0) + (step.files.length ? 1 : 0) + step.agents.length;

      nodes.push({
        id,
        position: { x: COL_X, y },
        // `live` rides on the node's data purely so the fit can find it again without re-deriving.
        data: {
          live: step.status === "in_progress",
          label: (
            <div className="text-left leading-tight">
              <div className="flex items-center gap-1.5">
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {step.status === "in_progress"
                    ? <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: tint }} />
                    : <CircleDot className="h-3 w-3" style={{ color: tint }} strokeWidth={2.2} />}
                </span>
                <span className="font-mono text-[9px] uppercase tracking-[.14em]" style={{ color: tint }}>
                  {step.synthetic ? "step" : `${n} · ${st.label}`}
                </span>
                {childCount > 0 && (
                  <span className="ml-auto flex items-center gap-0.5 text-[9px] text-neutral-500">
                    <ChevronRight className={`h-3 w-3 transition-transform ${isOpen ? "rotate-90" : ""}`} />{childCount}
                  </span>
                )}
              </div>
              <div className={`mt-1 text-[11.5px] ${step.status === "completed" ? "text-neutral-400" : "text-neutral-100"} ${step.synthetic ? "font-mono text-[10.5px]" : "font-medium"}`}>
                {clamp(step.title, 110)}
              </div>
              {!isOpen && step.files.length > 0 && (
                <div className="mt-1 flex items-center gap-1 text-[9.5px] text-neutral-500">
                  <FileDiff className="h-2.5 w-2.5" />{step.files.length} file{step.files.length === 1 ? "" : "s"}
                </div>
              )}
            </div>
          ),
        },
        style: {
          width: NODE_W, padding: "9px 11px", borderRadius: 12,
          border: `1px solid ${tint}`, borderLeft: `3px solid ${tint}`,
          background: open.has(step.key) ? "#1d222d" : "#161a22",
          boxShadow: open.has(step.key) ? `0 0 0 2px ${tint}55` : "none",
          opacity: step.status === "pending" ? 0.62 : 1,
          transition: "opacity .18s, box-shadow .18s",
        },
        sourcePosition: Position.Bottom, targetPosition: Position.Top,
        draggable: false,
      });
      edges.push({
        id: `e:${prevId}->${id}`, source: prevId, target: id,
        animated: step.status === "in_progress" && busy,
        style: { stroke: step.status === "pending" ? "#333a47" : tint, strokeWidth: 1.6, opacity: step.status === "pending" ? 0.5 : 1 },
      });
      prevId = id;

      // Expand in place: children fan RIGHT off the spine, so the plan stays a readable column no
      // matter how much is unfolded. Laid out here rather than as React Flow parent nodes because a
      // parent node's height would push the whole spine apart on every expand.
      if (isOpen) {
        let cy = y;
        const child = (cid: string, body: React.ReactNode, tone: string, h: number) => {
          nodes.push({
            id: cid,
            position: { x: CHILD_X, y: cy },
            data: { label: <div className="text-left leading-tight">{body}</div> },
            style: { width: CHILD_W, padding: "7px 9px", borderRadius: 9, border: `1px solid ${tone}55`, background: "#11141b", color: "#cbd2de" },
            sourcePosition: Position.Right, targetPosition: Position.Left,
            draggable: false,
          });
          edges.push({ id: `e:${id}->${cid}`, source: id, target: cid, style: { stroke: `${tone}66`, strokeWidth: 1.2 }, type: "smoothstep" });
          cy += h;
        };

        if (step.thinking) {
          child(`${id}:why`, (
            <>
              <div className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[.12em] text-[#6d5ae0]"><Sparkles className="h-2.5 w-2.5" />reasoning</div>
              <div className="mt-1 line-clamp-4 whitespace-pre-line text-[10px] text-neutral-400">{clamp(step.thinking, 260)}</div>
            </>
          ), "#6d5ae0", 82);
        }
        step.tools.forEach((t, j) => {
          const ok = t.done === false ? null : t.ok !== false;
          child(`${id}:t${j}`, (
            <>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[9px] uppercase tracking-[.12em] text-[#0f7f9c]">{t.name}</span>
                <span className="ml-auto text-[9px] tabular-nums text-neutral-600">
                  {ok === null ? "running…" : `${ok ? "✓" : "✗"}${t.ms ? ` ${(t.ms / 1000).toFixed(1)}s` : ""}`}
                </span>
              </div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-neutral-400">{clamp(activityLabel(t.name, t.input), 46)}</div>
            </>
          ), ok === false ? "#c4486a" : "#0f7f9c", 52);
        });
        if (step.files.length) {
          child(`${id}:files`, (
            <>
              <div className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[.12em] text-[#c47f18]"><FileDiff className="h-2.5 w-2.5" />files touched</div>
              {step.files.slice(0, 5).map((f) => <div key={f} className="mt-0.5 truncate font-mono text-[10px] text-neutral-400">{f.split("/").slice(-2).join("/")}</div>)}
              {step.files.length > 5 && <div className="mt-0.5 text-[9px] text-neutral-600">+{step.files.length - 5} more</div>}
            </>
          ), "#c47f18", 30 + Math.min(step.files.length, 5) * 15);
        }
        step.agents.forEach((a, j) => {
          child(`${id}:a${j}`, (
            <>
              <div className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[.12em] text-[#1f8a5c]"><Users className="h-2.5 w-2.5" />{a.agent}</div>
              <div className="mt-0.5 line-clamp-2 text-[10px] text-neutral-400">{clamp(a.description, 90)}</div>
            </>
          ), "#1f8a5c", 56);
        });
        y = Math.max(y + 84, cy + ROW_GAP);
      } else {
        y += 84;
      }
    });

    return { nodes, edges };
  }, [turn, open, busy]);
  // Re-frame whenever the shape changes. This is what the minimap was standing in for, and it does the
  // job better: you never have to navigate back to the thing that just moved.
  // `minZoom` on the fit, not just on the canvas: a ten-step spine in a column this wide would
  // otherwise be scaled down until the labels are unreadable, which is a worse failure than needing to
  // scroll. Below 0.75 it stops shrinking and you pan instead.
  //
  // And when it CAN'T fit, what it frames matters. Fitting the whole graph then landing wherever the
  // clamped zoom happens to leave you puts the request off-screen and the live step nowhere in
  // particular. So a too-tall graph fits around the RUNNING step instead — the one thing you opened
  // this to look at — and only a graph that genuinely fits gets framed whole.
  const focusIds = useMemo(() => {
    const running = nodes.find((n) => n.id.startsWith("s:") && (n.data as { live?: boolean })?.live);
    return running ? [{ id: running.id }] : undefined;
  }, [nodes]);
  useEffect(() => {
    const t = setTimeout(() => {
      fitView({ padding: 0.16, duration: 260, minZoom: 0.75, maxZoom: 1, ...(focusIds ? { nodes: focusIds } : {}) });
    }, 60);
    return () => clearTimeout(t);
  }, [nodes.length, focusIds, fitView]);

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    if (!node.id.startsWith("s:")) return;
    toggle(node.id.slice(2));
  }, [toggle]);

  return (
    <ReactFlow
      nodes={nodes} edges={edges} onNodeClick={onNodeClick}
      fitView proOptions={{ hideAttribution: true }}
      nodesDraggable={false} nodesConnectable={false} elementsSelectable
      minZoom={0.3} maxZoom={1.6}
      className="[&_.react-flow__node]:cursor-pointer"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#242a35" />
    </ReactFlow>
  );
}

export function FlowCanvas({ sessionId, project, busy = false, onClose }: {
  sessionId: string; project: string;
  /** Whether this session is mid-turn. Supplied by the page from /api/agent/live: the on-disk
   *  transcript has no `streaming` flag (that exists only on the live stream), so deriving it here
   *  silently pinned it to false and the running-step edge never animated. */
  busy?: boolean;
  onClose: () => void;
}) {
  const [turns, setTurns] = useState<SourceTurn[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await (await fetch(`/api/bento/session/${sessionId}`, { cache: "no-store" })).json();
        if (alive && Array.isArray(d?.turns)) setTurns(d.turns as SourceTurn[]);
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

  const flow = useMemo(() => buildFlow(turns), [turns]);
  // The newest request often has no steps yet — it may not have called a tool, or the window may start
  // mid-conversation. Showing its empty canvas is a dead end, so default to the newest turn that
  // actually HAS something to draw and let the arrows reach the rest.
  const live = useMemo(() => {
    for (let i = flow.length - 1; i >= 0; i--) if (flow[i].steps.length) return i;
    return flow.length ? flow.length - 1 : 0;
  }, [flow]);
  const shown = pinned == null ? live : Math.min(pinned, live);
  const turn = flow[shown];

  const toggle = useCallback((k: string) => setOpen((p) => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; }), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="text-[11px] font-semibold tracking-tight">{project}</span>
        <span className="text-[10px] text-neutral-500">flow</span>
        {flow.length > 1 && (
          <span className="flex items-center gap-1">
            <button onClick={() => setPinned(Math.max(0, shown - 1))} disabled={shown === 0}
              className="rounded px-1 text-[11px] text-neutral-500 transition-colors hover:text-neutral-200 disabled:opacity-30">‹</button>
            <span className="text-[10px] tabular-nums text-neutral-500">turn {shown + 1}/{flow.length}</span>
            <button onClick={() => setPinned(shown + 1 >= live ? null : shown + 1)} disabled={shown >= live}
              className="rounded px-1 text-[11px] text-neutral-500 transition-colors hover:text-neutral-200 disabled:opacity-30">›</button>
          </span>
        )}
        <span className="flex-1" />
        <span className="text-[10px] text-neutral-600">click a step to unfold it</span>
        <button onClick={onClose} title="Collapse back to the grid"
          className="rounded-lg p-1 text-neutral-500 transition-colors hover:bg-white/10 hover:text-neutral-200">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {loading && !turn ? (
          <p className="p-4 text-[11px] text-neutral-500">Reading the transcript…</p>
        ) : !turn?.steps.length ? (
          // Says WHY it's empty. "No steps" with nothing else is indistinguishable from a broken fetch.
          <p className="p-4 text-[11px] text-neutral-500">
            No steps to draw yet{turns.length ? ` — read ${turns.length} message${turns.length === 1 ? "" : "s"}, none of them ran a tool` : ""}.
          </p>
        ) : (
          // `useReactFlow()` reads from context, so it needs a provider ABOVE the component that calls
          // it — being the same component that renders <ReactFlow> is not enough, and fails at runtime
          // with "Seems like you have not used ReactFlowProvider as an ancestor".
          <ReactFlowProvider>
            <Canvas turn={turn} busy={busy} open={open} toggle={toggle} />
          </ReactFlowProvider>
        )}
      </div>
    </div>
  );
}
