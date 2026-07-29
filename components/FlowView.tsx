"use client";

// The Flow view: a live control tower for the turn in flight.
//
// Not an archive. The graph is the plan Claude is executing RIGHT NOW — one node per TodoWrite item,
// drawn down a vertical spine, children fanning right — and the reason it exists is the three buttons
// on a held node: Approve, Steer, Abort. Watching without being able to intervene is what the chat
// view already does.
//
// The brake is server-side (setHold in lib/agent/manager.ts): while armed, canUseTool parks the next
// tool call instead of auto-approving it. Everything here is a view over data the pane already has —
// see lib/flow-model.ts for why that's a derivation and not a second pipeline.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background, BackgroundVariant, Controls, MiniMap, Position, ReactFlow,
  useNodesInitialized, useReactFlow,
  type Edge, type Node, type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ChevronRight, CircleDot, FileDiff, Pause, Play, Sparkles, Users } from "lucide-react";
import { buildFlow, type FlowTool, type FlowTurn } from "@/lib/flow-model";
import { activityLabel, type PermissionPrompt } from "@/lib/use-agent";

// Same semantic key as /architecture's ModuleGraph, so the two canvases read as one system: rose is
// the surface you're looking at, cyan the running side, violet the logic, amber the outside world.
const STATUS = {
  in_progress: { tint: "#c4486a", label: "running" },   // sakura — the live one
  completed: { tint: "#1f8a5c", label: "done" },
  pending: { tint: "#4e5665", label: "queued" },
} as const;
const HELD_TINT = "#c47f18"; // amber — stopped, waiting on a human

const NODE_W = 300;
const COL_X = 40;      // the spine
const CHILD_X = COL_X + NODE_W + 56;
const CHILD_W = 250;
const ROW_GAP = 22;

const clamp = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A held tool call is identified by the tool it's parked on — the model has no id for it, and the
 *  step it belongs to is simply whichever one is running. */
function heldStepKey(turn: FlowTurn | undefined): string | null {
  if (!turn) return null;
  const running = turn.steps.find((s) => s.status === "in_progress");
  return (running || turn.steps[turn.steps.length - 1])?.key ?? null;
}

export function FlowView({
  turns: source, busy, hold, pending, stopping, onSetHold, onRespond, onStop,
}: {
  turns: { role: "user" | "assistant"; text: string; tools: FlowTool[]; streaming?: boolean; thinking?: string }[];
  busy: boolean;
  hold: boolean;
  pending: PermissionPrompt;
  stopping: boolean;
  onSetHold: (on: boolean) => void;
  onRespond: (decision: "allow" | "deny", message?: string) => void;
  onStop: () => void;
}) {
  const flow = useMemo(() => buildFlow(source), [source]);
  // Current turn only — the answer to "how much history": one request, its plan, its steps. Older
  // turns stay reachable through the picker rather than being drawn into the same canvas, which is
  // what keeps this readable at a glance while something is actually running.
  const [turnIdx, setTurnIdx] = useState<number | null>(null);
  const live = flow.length ? flow.length - 1 : 0;
  // `null` means "follow the live turn" rather than a pinned index, so a new request doesn't strand
  // the view on the previous one — pinning only happens when the user picks a turn explicitly.
  const shown = turnIdx == null ? live : Math.min(turnIdx, live);
  const turn: FlowTurn | undefined = flow[shown];

  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [steer, setSteer] = useState("");

  const heldKey = pending?.held ? heldStepKey(turn) : null;
  // Auto-open the step that just stopped for review. The whole point is to be looking at it.
  useEffect(() => {
    if (heldKey) setOpen((prev) => (prev.has(heldKey) ? prev : new Set(prev).add(heldKey)));
  }, [heldKey]);

  const toggle = useCallback((key: string) => {
    setOpen((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }, []);

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
      const held = step.key === heldKey;
      const st = STATUS[step.status];
      const tint = held ? HELD_TINT : st.tint;
      const isOpen = open.has(step.key);
      const id = `s:${step.key}`;
      const childCount = step.tools.length + (step.thinking ? 1 : 0) + (step.files.length ? 1 : 0) + step.agents.length;

      nodes.push({
        id,
        position: { x: COL_X, y },
        data: {
          label: (
            <div className="text-left leading-tight">
              <div className="flex items-center gap-1.5">
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {step.status === "in_progress" && !held
                    ? <span className="h-2 w-2 animate-pulse rounded-full" style={{ background: tint }} />
                    : held
                      ? <Pause className="h-3 w-3" style={{ color: tint }} strokeWidth={2.6} />
                      : <CircleDot className="h-3 w-3" style={{ color: tint }} strokeWidth={2.2} />}
                </span>
                <span className="font-mono text-[9px] uppercase tracking-[.14em]" style={{ color: tint }}>
                  {held ? "held for review" : step.synthetic ? "step" : `${n} · ${st.label}`}
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
          background: selected === step.key ? "#1d222d" : "#161a22",
          boxShadow: held ? `0 0 0 3px ${tint}44` : selected === step.key ? `0 0 0 2px ${tint}55` : "none",
          opacity: step.status === "pending" ? 0.62 : 1,
          transition: "opacity .18s, box-shadow .18s",
        },
        sourcePosition: Position.Bottom, targetPosition: Position.Top,
        draggable: false,
      });
      edges.push({
        id: `e:${prevId}->${id}`, source: prevId, target: id,
        animated: step.status === "in_progress" && busy && !held,
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
  }, [turn, open, selected, busy, heldKey]);

  const onNodeClick: NodeMouseHandler = useCallback((_, node) => {
    if (!node.id.startsWith("s:")) return;
    const key = node.id.slice(2);
    setSelected((c) => (c === key ? null : key));
    toggle(key);
  }, [toggle]);

  const step = turn?.steps.find((s) => s.key === selected) || null;
  const done = turn?.steps.filter((s) => s.status === "completed").length ?? 0;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
          {/* The brake. Named for what it does to the session, not for the UI state it holds. */}
          <button
            onClick={() => onSetHold(!hold)}
            title={hold ? "Release — stop parking tool calls at the gate" : "Pause after the current step — park the next tool call for review"}
            className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              hold ? "border-[#c47f18]/60 bg-[#c47f18]/15 text-[#c47f18]" : "border-white/15 text-neutral-400 hover:border-white/30 hover:text-neutral-200"
            }`}>
            {hold ? <><Play className="h-3 w-3" />release</> : <><Pause className="h-3 w-3" />pause after step</>}
          </button>
          <button onClick={onStop} disabled={!busy || stopping}
            title="Abort the whole turn"
            className="rounded-lg border border-white/15 px-2.5 py-1 text-[11px] text-neutral-400 transition-colors enabled:hover:border-red-500/50 enabled:hover:text-red-400 disabled:opacity-30">
            {stopping ? "stopping…" : "abort"}
          </button>

          {flow.length > 1 && (
            <div className="flex items-center gap-1 rounded-lg border border-white/10 p-0.5" title="Which request to show">
              <button onClick={() => setTurnIdx(Math.max(0, shown - 1))} disabled={shown === 0}
                className="rounded-md px-1.5 py-0.5 text-[11px] text-neutral-500 transition-colors enabled:hover:text-neutral-200 disabled:opacity-25">‹</button>
              <span className="px-1 font-mono text-[10px] text-neutral-500">{shown + 1}/{flow.length}</span>
              {/* Clearing the pin (rather than setting live's index) is what makes the view resume
                  following new requests instead of freezing on whichever one is newest today. */}
              <button onClick={() => (shown + 1 >= live ? setTurnIdx(null) : setTurnIdx(shown + 1))} disabled={shown >= live}
                className="rounded-md px-1.5 py-0.5 text-[11px] text-neutral-500 transition-colors enabled:hover:text-neutral-200 disabled:opacity-25">›</button>
            </div>
          )}

          <span className="ml-auto flex items-center gap-3 font-mono text-[10px] text-neutral-500">
            {turn && <span>{done}/{turn.steps.length} steps</span>}
            {turn && !turn.planned && <span className="text-neutral-600" title="This turn never called TodoWrite — nodes are its tool calls">no plan · from tool calls</span>}
            <button onClick={() => setOpen(new Set(turn?.steps.map((s) => s.key) ?? []))} className="underline decoration-dotted underline-offset-2 hover:text-neutral-300">expand all</button>
            <button onClick={() => setOpen(new Set())} className="underline decoration-dotted underline-offset-2 hover:text-neutral-300">collapse</button>
          </span>
        </div>

        <div className="relative min-h-0 flex-1">
          {!turn ? (
            <div className="flex h-full items-center justify-center text-center text-sm text-neutral-500">
              <div>
                <p className="text-2xl">◇</p>
                <p className="mt-2">Send a request below — its plan appears here as it&apos;s built.</p>
              </div>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes} edges={edges}
              onNodeClick={onNodeClick}
              onPaneClick={() => setSelected(null)}
              defaultViewport={{ x: 40, y: 24, zoom: 1 }}
              minZoom={0.25} maxZoom={1.6}
              nodesDraggable={false} nodesConnectable={false} edgesFocusable={false}
              proOptions={{ hideAttribution: false }}
            >
              <ResetViewport turn={shown} />
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#262c39" />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable maskColor="rgba(14,16,22,.55)"
                nodeColor={(n) => (n.id.startsWith("s:") ? (turn.steps.find((s) => `s:${s.key}` === n.id)?.status === "in_progress" ? "#c4486a" : "#4e5665") : "#333a47")}
                style={{ background: "#11141b", border: "1px solid #262c39", borderRadius: 8 }} />
            </ReactFlow>
          )}
        </div>
      </div>

      {/* Review drawer. Only ever open over a held step or a deliberately selected one — a permanently
          docked panel would eat half the canvas for the 95% of the time there's nothing to decide. */}
      {(pending?.held || step) && (
        <div className="flex w-[22rem] shrink-0 flex-col overflow-y-auto border-l border-white/10 bg-neutral-900/60">
          {pending?.held && (
            <div className="border-b border-[#c47f18]/30 bg-[#c47f18]/[0.07] p-3">
              <div className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[.14em] text-[#c47f18]">
                <Pause className="h-3 w-3" />held at the gate
              </div>
              <p className="mt-1.5 text-[12px] font-medium text-neutral-100">{activityLabel(pending.toolName, pending.input)}</p>
              <p className="mt-0.5 font-mono text-[10px] text-neutral-500">{pending.toolName}</p>
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-white/10 bg-black/30 p-2 font-mono text-[9.5px] leading-relaxed text-neutral-400">
                {JSON.stringify(pending.input, null, 2).slice(0, 1200)}
              </pre>
              <Countdown expiresAt={pending.expiresAt} />
              <textarea
                value={steer} onChange={(e) => setSteer(e.target.value)}
                placeholder="Steer instead — what should it do differently?"
                className="mt-2 h-16 w-full resize-none rounded-lg border border-white/15 bg-white/[0.03] px-2 py-1.5 text-[11px] outline-none placeholder:text-neutral-600 focus:border-[var(--sakura)]/60" />
              <div className="mt-2 flex items-center gap-1.5">
                <button onClick={() => { onRespond("allow"); setSteer(""); }}
                  className="rounded-lg bg-[#1f8a5c] px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90">approve</button>
                {/* Steering IS a denial — the note goes back as the tool result, so Claude reads it and
                    course-corrects inside this same turn rather than after the step already ran. */}
                <button onClick={() => { onRespond("deny", steer.trim() || undefined); setSteer(""); }}
                  className="rounded-lg border border-[var(--sakura)]/50 px-2.5 py-1 text-[11px] font-medium text-[var(--sakura)] transition-colors hover:bg-[var(--sakura)]/10">
                  {steer.trim() ? "steer" : "skip this step"}
                </button>
              </div>
            </div>
          )}
          {step && (
            <div className="p-3">
              <div className="font-mono text-[9.5px] uppercase tracking-[.14em]" style={{ color: STATUS[step.status].tint }}>{STATUS[step.status].label}</div>
              <p className="mt-1 text-[12.5px] font-medium text-neutral-100">{step.title}</p>
              {step.detail && <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">{step.detail}</p>}
              {step.thinking && (
                <>
                  <div className="mt-3 font-mono text-[9px] uppercase tracking-[.12em] text-[#6d5ae0]">reasoning</div>
                  <p className="mt-1 whitespace-pre-line text-[11px] leading-relaxed text-neutral-400">{step.thinking}</p>
                </>
              )}
              {step.text.trim() && (
                <>
                  <div className="mt-3 font-mono text-[9px] uppercase tracking-[.12em] text-neutral-500">said</div>
                  <p className="mt-1 whitespace-pre-line text-[11px] leading-relaxed text-neutral-300">{step.text}</p>
                </>
              )}
              {step.files.length > 0 && (
                <>
                  <div className="mt-3 font-mono text-[9px] uppercase tracking-[.12em] text-[#c47f18]">files touched</div>
                  {step.files.map((f) => <p key={f} className="mt-0.5 break-all font-mono text-[10px] text-neutral-400">{f}</p>)}
                </>
              )}
              {step.tools.length > 0 && (
                <>
                  <div className="mt-3 font-mono text-[9px] uppercase tracking-[.12em] text-[#0f7f9c]">tool calls</div>
                  {step.tools.map((t, i) => (
                    <div key={t.id || i} className="mt-1.5 rounded-lg border border-white/10 bg-black/20 p-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[10px] text-neutral-300">{t.name}</span>
                        <span className="ml-auto font-mono text-[9px] text-neutral-600">{t.done === false ? "running…" : `${t.ok !== false ? "✓" : "✗"}${t.ms ? ` ${(t.ms / 1000).toFixed(1)}s` : ""}`}</span>
                      </div>
                      <pre className="mt-1 max-h-32 overflow-auto font-mono text-[9.5px] leading-relaxed text-neutral-500">{JSON.stringify(t.input, null, 2).slice(0, 700)}</pre>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Park the viewport at the top of the spine whenever the shown turn changes.
 *
 *  Deliberately a FIXED viewport rather than `fitView`, for two reasons found by measuring:
 *
 *  1. `fitView` fits against the container as it is at that instant, and this pane is a flex child
 *     that has not reached its final size when nodes finish measuring. Result: zoom 0.85, column
 *     jammed at the left edge, and it never corrects because fitView doesn't run again. Chasing it
 *     with a ResizeObserver just moves the race.
 *  2. Even when it works, fitting is wrong for this graph. The spine is a fixed-width column that
 *     grows DOWNWARD without limit — fitting a 20-step plan means zooming to ~0.3, where no node is
 *     readable. A review surface wants a constant, predictable scale you scroll through, which is
 *     also why the zoom doesn't drift as steps stream in.
 *
 *  Controls still offers fit-to-view for when you do want the whole shape at once. Rendered as a
 *  CHILD of <ReactFlow> so it sits inside the store's provider, the same way Controls and MiniMap do. */
function ResetViewport({ turn }: { turn: number }) {
  const initialized = useNodesInitialized();
  const { setViewport } = useReactFlow();
  useEffect(() => {
    if (!initialized) return;
    setViewport({ x: 40, y: 24, zoom: 1 }, { duration: 200 });
  }, [initialized, turn, setViewport]);
  return null;
}

/** Counts a held step down to its auto-release. Shown because the alternative — a hold that silently
 *  expires while you're reading — is worse than one you can see coming (HOLD_TIMEOUT_MS in
 *  lib/agent/manager.ts denies on expiry, it does not approve). */
function Countdown({ expiresAt }: { expiresAt?: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!expiresAt) return;
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const left = Math.max(0, expiresAt - Date.now());
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  return (
    <p className="mt-1.5 font-mono text-[9.5px] text-neutral-500">
      auto-denies in {m}:{String(s).padStart(2, "0")} if not reviewed
    </p>
  );
}
