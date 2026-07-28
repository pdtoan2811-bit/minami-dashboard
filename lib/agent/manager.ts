/* eslint-disable @typescript-eslint/no-explicit-any */
// Server-only: drives LIVE Claude Code sessions via @anthropic-ai/claude-agent-sdk (Phase 2).
//
// Each panel in the Bento chat gets one long-lived `query()` running in streaming-input mode, so the
// user can keep sending messages into the same session (like the CLI). We hold the query iterator
// alive across HTTP requests in an in-memory registry, broadcast its output to the browser over SSE,
// and pause on `canUseTool` until the user approves/denies a tool — the permission prompt.
//
// The SDK uses the machine's existing Claude Code login (no API key) and persists every session to
// ~/.claude/projects/<enc-cwd>/<id>.jsonl exactly like the CLI, so the rest of Bento keeps working.
//
// Safety: only "default" | "acceptEdits" | "plan" permission modes are ever passed to the SDK.
// "bypassPermissions" is intentionally impossible to select — see safeMode().
import { query } from "@anthropic-ai/claude-agent-sdk";
import { activityLabel, inputFromPartial, phaseLabel, type ActivityPhase, type ActivityState, type LiveTask, type LiveTool } from "./labels";

// "bypassPermissions" auto-approves every tool with no prompt — powerful but dangerous. It's opt-in
// (the user has to pick it), never the shipped default. Everything else is clamped to "default".
export type AllowedMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
const ALLOWED: AllowedMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
export const safeMode = (m?: string): AllowedMode => (ALLOWED.includes(m as AllowedMode) ? (m as AllowedMode) : "default");

// Events pushed to the browser over SSE.
export type AgentQuestion = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string; preview?: string }[] };
export type AgentEvent =
  | { t: "init"; sessionId: string; model?: string }
  | { t: "delta"; text: string } // streaming assistant text token(s)
  | { t: "thinking"; text: string } // streaming reasoning token(s) — see the `thinking` option below
  | { t: "snapshot"; busy: boolean; partial: string; partialThinking: string; activity: ActivityState } // sent on (re)subscribe: the in-flight turn's state
  | { t: "detached" } // no live session exists for this key — client should fall back to the on-disk view
  | { t: "tool"; name: string; input: unknown; id?: string } // a tool call started (live feedback)
  | { t: "tool_end"; id: string; name: string; ok: boolean; ms: number } // its result came back
  | { t: "activity"; activity: ActivityState } // REPLACE semantics: the whole live-activity state
  | { t: "notice"; kind: "retry" | "compact" | "task" | "limit" | "denied" | "aborted"; text: string } // non-fatal, worth showing
  | { t: "permission"; id: string; toolName: string; input: unknown } // waiting on the user
  | { t: "ask"; id: string; questions: AgentQuestion[] } // Claude's AskUserQuestion tool
  | { t: "result"; subtype: string; costUsd?: number } // turn finished
  | { t: "busy"; busy: boolean }
  | { t: "error"; message: string };

type Decision = { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string };
type Pending = { resolve: (d: Decision) => void; toolName: string; input: unknown };
type Sub = (ev: AgentEvent) => void;

type Session = {
  key: string;
  cwd: string;
  q: any | null; // the SDK Query (async generator + control methods)
  queue: any[]; // SDKUserMessage objects waiting to feed the input generator
  waiter: (() => void) | null; // resolves the generator's pending await when a message arrives
  closed: boolean;
  busy: boolean;
  sawText: boolean; // has the current turn streamed any assistant text yet? (for paragraph breaks)
  partial: string; // text of the assistant message currently streaming — replayed on reconnect so a
                   // refreshed client picks the sentence back up where it left off (reset per message)
  partialThinking: string; // same, for the reasoning stream
  sessionId: string | null; // the real Claude Code session id (for resume + file reconcile)
  subs: Set<Sub>;
  pending: Map<string, Pending>; // outstanding permission prompts
  idleTimer: ReturnType<typeof setTimeout> | null;

  // ---- live activity (see lib/agent/labels.ts) ----
  phase: ActivityPhase;
  phaseSince: number;
  note: string | null; // transient detail that outranks the phase label
  liveTools: Map<string, LiveTool & { startedAt: number }>; // tool_use_id → in-flight tool call
  liveTasks: Map<string, LiveTask>; // task_id → running subagent / background task
  toolBufs: Map<number, { id: string; name: string; buf: string }>; // block index → streaming tool input
};

// Persist the registry on globalThis so Next.js dev hot-reloads don't orphan live sessions. Sessions
// are addressable by their pane key AND (once known) by `live:<sessionId>` — the latter lets any pane
// showing that session stream it, regardless of which pane started it.
const store: Map<string, Session> = ((globalThis as any).__minamiAgentStore ||= new Map());
const SID_KEY = "live:";
// Subscribers that arrived BEFORE their session existed. The client opens the SSE stream and POSTs
// the first message back-to-back, so the GET can win the race; without this the subscriber would be
// dropped and the whole turn would stream into the void.
const waiting: Map<string, Set<Sub>> = ((globalThis as any).__minamiAgentWaiting ||= new Map());
let permCounter = 0;

function broadcast(s: Session, ev: AgentEvent) {
  for (const sub of s.subs) { try { sub(ev); } catch { /* dead client */ } }
}

// ---------------------------------------------------------------------------
// Live activity. The server is the single source of truth for "what is Claude doing right now" so
// that (a) a browser refresh mid-tool-call resumes with the right label instead of a generic
// "working…", and (b) the inline transcript indicator and the composer status line can't disagree.
// Every mutation funnels through touch(), which recomputes the label and broadcasts the full state
// (REPLACE semantics — a client that misses an event self-heals on the next one).
// ---------------------------------------------------------------------------

function activityOf(s: Session): ActivityState {
  const tools = [...s.liveTools.values()].map(({ id, name, label, parentId }) => ({ id, name, label, parentId }));
  const tasks = [...s.liveTasks.values()];
  return {
    phase: s.phase,
    label: phaseLabel(s.phase, tools, tasks, s.note),
    elapsedMs: Math.max(0, Date.now() - s.phaseSince),
    tools,
    tasks,
    ...(s.note ? { note: s.note } : {}),
  };
}

// Move to `phase` and broadcast. The elapsed clock only restarts when the phase actually changes, so
// a run of 40 text_deltas doesn't reset the "writing… 12s" timer.
function touch(s: Session, phase?: ActivityPhase, note?: string | null) {
  if (phase && phase !== s.phase) { s.phase = phase; s.phaseSince = Date.now(); }
  if (note !== undefined) s.note = note;
  broadcast(s, { t: "activity", activity: activityOf(s) });
}

// After a tool result lands (or a prompt is answered) fall back to the phase implied by what's still
// in flight, rather than leaving the finished tool's label on screen — the stale-label bug.
function settle(s: Session) {
  if (s.pending.size) return touch(s, "awaiting");
  if (s.liveTools.size || s.liveTasks.size) return touch(s, "tool");
  // No tools left: Claude is deciding what to do next. `thinking` is the honest label — text_deltas
  // will flip it to `responding` the moment an answer starts.
  touch(s, s.busy ? "thinking" : "idle");
}

function resetActivity(s: Session, phase: ActivityPhase) {
  s.liveTools.clear();
  s.liveTasks.clear();
  s.toolBufs?.clear();
  s.note = null;
  s.phase = phase;
  s.phaseSince = Date.now();
}

// Close a session that's been idle with no listeners for a while, so we don't leak CLI processes.
function scheduleIdle(s: Session) {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => { if (!s.busy && s.subs.size === 0) closeSession(s.key); }, 10 * 60 * 1000);
}

// The streaming input: yields queued user messages, then parks until send() wakes it.
async function* inputGen(s: Session): AsyncGenerator<any> {
  while (!s.closed) {
    if (s.queue.length) { yield s.queue.shift(); continue; }
    await new Promise<void>((resolve) => { s.waiter = resolve; });
  }
}

function ensureSession(key: string, cwd: string, mode: AllowedMode, resume?: string): Session {
  const existing = store.get(key);
  if (existing && !existing.closed) return existing;

  const s: Session = {
    key, cwd, q: null, queue: [], waiter: null, closed: false, busy: false, sawText: false, partial: "",
    partialThinking: "",
    sessionId: resume || null, subs: new Set(), pending: new Map(), idleTimer: null,
    phase: "idle", phaseSince: Date.now(), note: null, liveTools: new Map(), liveTasks: new Map(),
    toolBufs: new Map(),
  };
  store.set(key, s);
  // Adopt anyone who subscribed while this key had no session yet (see `waiting`), so the very first
  // events of the turn — init, the opening activity state — reach them.
  const early = waiting.get(key);
  if (early) { for (const sub of early) s.subs.add(sub); waiting.delete(key); }

  // Called by the SDK for any tool the user's config doesn't already auto-approve, AND for the
  // AskUserQuestion tool (Claude's clarifying question). We surface it and block until the user acts.
  const canUseTool = async (toolName: string, input: unknown): Promise<Decision> => {
    const id = "perm-" + ++permCounter;
    if (toolName === "AskUserQuestion") {
      broadcast(s, { t: "ask", id, questions: (input as { questions?: AgentQuestion[] })?.questions || [] });
    } else {
      broadcast(s, { t: "permission", id, toolName, input });
    }
    const p = new Promise<Decision>((resolve) => { s.pending.set(id, { resolve, toolName, input }); });
    // Claude is now blocked on a human, not working — say so, and name the tool it's waiting on.
    touch(s, "awaiting", toolName === "AskUserQuestion" ? "waiting on your answer" : `waiting on approval · ${activityLabel(toolName, input)}`);
    return p;
  };

  s.q = query({
    prompt: inputGen(s),
    options: {
      cwd,
      permissionMode: mode,
      canUseTool,
      includePartialMessages: true, // stream assistant text token-by-token
      // Ask for the reasoning summary. Without this the API defaults to display "omitted", which
      // still emits thinking blocks but with an EMPTY text field — so the pane had no way to show
      // that Claude was working during a long think. "summarized" is the only readable mode; the
      // raw chain of thought is never returned on current models.
      thinking: { type: "adaptive", display: "summarized" },
      settingSources: ["user", "project", "local"], // mirror the user's own CLAUDE.md / permissions / MCP
      ...(resume ? { resume } : {}),
    } as any,
  });

  // Consume the query for the session's lifetime, translating SDK messages into browser events.
  (async () => {
    try {
      for await (const m of s.q as AsyncIterable<any>) handleMessage(s, m);
    } catch (e: any) {
      broadcast(s, { t: "error", message: String(e?.message || e) });
    } finally {
      s.busy = false;
      s.closed = true;
      resetActivity(s, "idle");
      broadcast(s, { t: "activity", activity: activityOf(s) });
      broadcast(s, { t: "busy", busy: false });
    }
  })();

  return s;
}

function handleMessage(s: Session, m: any) {
  switch (m?.type) {
    case "system":
      handleSystem(s, m);
      break;
    case "stream_event": {
      const ev = m.event;
      if (!s.toolBufs) s.toolBufs = new Map(); // guard sessions created before this field existed (hot-reload)
      // Each new assistant message means the previous one is now flushed to the JSONL, so the live
      // "partial" (used to reconstruct the in-flight message for a reconnecting client) resets.
      if (ev?.type === "message_start") { s.partial = ""; s.partialThinking = ""; }
      // Reasoning tokens. These arrive before (and between) text blocks, so they double as the
      // "Claude is still working" signal during a long think where no text has been emitted yet.
      if (ev?.type === "content_block_start" && ev.content_block?.type === "thinking") touch(s, "thinking");
      if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
        s.partialThinking += ev.delta.thinking;
        if (s.phase !== "thinking") touch(s, "thinking");
        broadcast(s, { t: "thinking", text: ev.delta.thinking });
      }
      // A new text block starting mid-turn is a separate paragraph (e.g. Claude resumes talking after
      // a tool call). The streamed deltas carry no separator, so inject one — matching how the file
      // reconcile joins text blocks — otherwise the new message glues onto the previous paragraph.
      if (ev?.type === "content_block_start" && ev.content_block?.type === "text") {
        if (s.sawText) broadcast(s, { t: "delta", text: "\n\n" }); // separator for the live single bubble
        if (s.partial) s.partial += "\n\n"; // ...and within the current message's snapshot
        touch(s, "responding");
      }
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        s.sawText = true;
        s.partial += ev.delta.text;
        if (s.phase !== "responding") touch(s, "responding");
        broadcast(s, { t: "delta", text: ev.delta.text });
      }
      // EARLIEST possible tool signal: the block opens with the tool's id and name, seconds before
      // the enclosing `assistant` message completes. Register it now (arguments haven't streamed yet,
      // so the label is name-only) and refine it when the full message lands.
      if (ev?.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        const b = ev.content_block;
        if (b.id) {
          s.liveTools.set(b.id, { id: b.id, name: b.name, label: activityLabel(b.name), parentId: m.parent_tool_use_id ?? null, startedAt: Date.now() });
          if (typeof ev.index === "number") s.toolBufs.set(ev.index, { id: b.id, name: b.name, buf: "" });
          touch(s, "tool");
        }
      }
      // The tool's arguments stream in as partial JSON. Refine the label the instant the key field
      // (file path / command / pattern) lands, so a fast tool shows "reading package.json" — not the
      // "reading a file" placeholder — for essentially its whole (brief) lifetime.
      if (ev?.type === "content_block_delta" && ev.delta?.type === "input_json_delta" && typeof ev.index === "number") {
        const tb = s.toolBufs.get(ev.index);
        if (tb) {
          tb.buf += ev.delta.partial_json || "";
          const input = inputFromPartial(tb.name, tb.buf);
          if (input) {
            const label = activityLabel(tb.name, input);
            const lt = s.liveTools.get(tb.id);
            if (lt && lt.label !== label) { lt.label = label; if (s.phase === "tool") touch(s, "tool"); }
          }
        }
      }
      if (ev?.type === "content_block_stop" && typeof ev.index === "number") s.toolBufs.delete(ev.index);
      break;
    }
    case "assistant": {
      // Text is already streamed via deltas; surface tool_use blocks for live "running X" feedback.
      // A message with parent_tool_use_id set came from INSIDE a subagent — its tools belong to that
      // task, not the top line, so they're recorded with parentId and filtered out of phaseLabel().
      const parentId = m.parent_tool_use_id ?? null;
      const content = m.message?.content;
      if (Array.isArray(content)) {
        let changed = false;
        for (const b of content) {
          if (b?.type !== "tool_use") continue;
          const label = activityLabel(b.name, b.input);
          if (b.id) {
            const prev = s.liveTools.get(b.id);
            // Refine the placeholder from content_block_start (or register, if partials were missed).
            s.liveTools.set(b.id, { id: b.id, name: b.name, label, parentId, startedAt: prev?.startedAt ?? Date.now() });
          }
          // A subagent's inner tool is the freshest thing that task is doing — surface it there.
          if (parentId) {
            const task = [...s.liveTasks.values()].find((t) => t.id === parentId) || s.liveTasks.get(parentId);
            if (task) task.lastTool = label;
          }
          broadcast(s, { t: "tool", name: b.name, input: b.input, id: b.id });
          changed = true;
        }
        if (changed) touch(s, "tool");
      }
      // `max_output_tokens` / an interrupt truncate the reply mid-word — otherwise it just looks
      // like Claude stopped talking for no reason.
      if (m.error === "max_output_tokens") broadcast(s, { t: "notice", kind: "limit", text: "hit the output-token limit — the reply was cut short" });
      if (m.aborted) broadcast(s, { t: "notice", kind: "aborted", text: "the turn was interrupted" });
      break;
    }
    case "user": {
      // Tool RESULTS come back as user messages. This is the signal that was missing entirely: without
      // it a finished tool stays in `liveTools` forever and the pane keeps animating "run: npm test"
      // long after the command exited.
      const content = m.message?.content;
      if (!Array.isArray(content)) break;
      let closed = false;
      for (const b of content) {
        if (b?.type !== "tool_result" || !b.tool_use_id) continue;
        const t = s.liveTools.get(b.tool_use_id);
        if (!t) continue;
        s.liveTools.delete(b.tool_use_id);
        broadcast(s, { t: "tool_end", id: t.id, name: t.name, ok: !b.is_error, ms: Date.now() - t.startedAt });
        closed = true;
      }
      if (closed) settle(s);
      break;
    }
    case "result":
      s.busy = false;
      s.partial = "";
      s.partialThinking = "";
      // A denied tool never produces a tool_result, so anything still open at the end of the turn is
      // finished by definition — clear it rather than let it leak into the next turn's label.
      resetActivity(s, "idle");
      if (Array.isArray(m.permission_denials) && m.permission_denials.length) {
        broadcast(s, { t: "notice", kind: "denied", text: `${m.permission_denials.length} tool call${m.permission_denials.length === 1 ? "" : "s"} denied` });
      }
      broadcast(s, { t: "activity", activity: activityOf(s) });
      broadcast(s, { t: "result", subtype: m.subtype, costUsd: m.total_cost_usd ?? m.cost_usd });
      broadcast(s, { t: "busy", busy: false });
      scheduleIdle(s);
      break;
  }
}

// System messages carry the signals that otherwise make a busy pane look dead: a retry backing off
// for 30s, an auto-compaction, and subagent progress.
function handleSystem(s: Session, m: any) {
  switch (m.subtype) {
    case "init":
      if (m.session_id) {
        s.sessionId = m.session_id;
        // Also register the session under its Claude id, so ANY pane viewing this session — not just
        // the one that started it — can subscribe/send/reattach and stream it live (the client uses
        // `live:<sessionId>` as the canonical key for an existing session).
        store.set(SID_KEY + m.session_id, s);
        broadcast(s, { t: "init", sessionId: m.session_id, model: m.model });
      }
      break;

    case "api_retry": {
      // Without this the pane sits silent for the whole backoff and reads as a hang.
      const why = m.error_status ? `HTTP ${m.error_status}` : m.error || "connection error";
      const secs = Math.round((m.retry_delay_ms || 0) / 1000);
      touch(s, "retrying", `retrying (${m.attempt}/${m.max_retries}) after ${why}${secs ? ` · ${secs}s` : ""}`);
      broadcast(s, { t: "notice", kind: "retry", text: `API ${why} — retry ${m.attempt}/${m.max_retries}` });
      break;
    }

    case "compact_boundary": {
      const md = m.compact_metadata || {};
      const pre = md.pre_tokens ? `${Math.round(md.pre_tokens / 1000)}k` : "?";
      const post = md.post_tokens ? `${Math.round(md.post_tokens / 1000)}k` : "?";
      broadcast(s, { t: "notice", kind: "compact", text: `context compacted (${md.trigger === "auto" ? "auto" : "manual"}) ${pre} → ${post}` });
      // Compaction happens mid-turn and can take a while; show it, then hand back to whatever's live.
      touch(s, "compacting", `compacting context ${pre} → ${post}`);
      settle(s);
      break;
    }

    case "task_started":
      if (m.skip_transcript) break; // ambient housekeeping — not the user's business
      s.liveTasks.set(m.task_id, {
        id: m.tool_use_id || m.task_id,
        description: m.description || m.workflow_name || "task",
        agent: m.subagent_type,
      });
      touch(s, "tool");
      break;

    case "task_progress": {
      const t = s.liveTasks.get(m.task_id);
      if (!t) break;
      // The richest live signal we get from inside a subagent: which tool it's on and how much it has
      // chewed through. Turns an opaque 3-minute "running a subagent" into real progress.
      if (m.last_tool_name) t.lastTool = activityLabel(m.last_tool_name);
      if (m.subagent_type) t.agent = m.subagent_type;
      t.toolUses = m.usage?.tool_uses;
      touch(s);
      break;
    }

    case "task_notification": {
      const t = s.liveTasks.get(m.task_id);
      s.liveTasks.delete(m.task_id);
      if (!m.skip_transcript && t) {
        broadcast(s, { t: "notice", kind: "task", text: `subagent ${m.status}: ${m.summary || t.description}` });
      }
      settle(s);
      break;
    }

    case "background_tasks_changed":
      // REPLACE semantics, per the SDK: swap the background set wholesale so a missed start/stop
      // bookend can't wedge a stale "running" indicator.
      for (const [id, t] of s.liveTasks) if (t.id.startsWith("bg:") && !m.tasks?.some((x: any) => `bg:${x.task_id}` === t.id)) s.liveTasks.delete(id);
      for (const x of m.tasks || []) {
        const id = `bg:${x.task_id}`;
        if (!s.liveTasks.has(id)) s.liveTasks.set(id, { id, description: x.description || x.task_type, agent: x.task_type });
      }
      touch(s);
      break;
  }
}

// Send a user message; creates the session on first call (with resume/mode) or feeds the live one.
export function sendMessage(opts: { key: string; cwd: string; message: string; mode?: string; resume?: string }): { sessionId: string | null } {
  const s = ensureSession(opts.key, opts.cwd, safeMode(opts.mode), opts.resume);
  s.queue.push({ type: "user", message: { role: "user", content: opts.message }, parent_tool_use_id: null });
  s.busy = true;
  s.sawText = false; // fresh turn: the next text block opens the reply, no leading separator
  s.partial = "";
  s.partialThinking = "";
  // Start the indicator on the SAME tick as the send, not when the first SDK event arrives — the gap
  // is often a second or two of cold start, and a blank pane in that window reads as "nothing
  // happened, did my message send?".
  resetActivity(s, "thinking");
  broadcast(s, { t: "busy", busy: true });
  broadcast(s, { t: "activity", activity: activityOf(s) });
  if (s.waiter) { const w = s.waiter; s.waiter = null; w(); }
  return { sessionId: s.sessionId };
}

export function decide(key: string, id: string, decision: "allow" | "deny", message?: string): boolean {
  const s = store.get(key);
  const p = s?.pending.get(id);
  if (!s || !p) return false;
  s.pending.delete(id);
  if (decision === "allow") p.resolve({ behavior: "allow", updatedInput: p.input });
  else p.resolve({ behavior: "deny", message: message || "User denied this tool call." });
  // Leave "waiting for you" behind the instant the user acts, so the pane goes back to animating.
  settle(s);
  return true;
}

// Answer an AskUserQuestion prompt: resolve the tool with the user's chosen option label(s), echoing
// the original questions back (the SDK requires it). answers = { [questionText]: label | label[] }.
export function answer(key: string, id: string, answers: Record<string, string | string[]>): boolean {
  const s = store.get(key);
  const p = s?.pending.get(id);
  if (!s || !p) return false;
  s.pending.delete(id);
  const questions = (p.input as { questions?: unknown })?.questions ?? [];
  p.resolve({ behavior: "allow", updatedInput: { questions, answers } });
  settle(s);
  return true;
}

// Stop the in-flight turn (the chat panel's Stop button). Interrupt the SDK query first — that's the
// authoritative abort, it stops token generation and any running tool — then resolve any permission /
// AskUserQuestion prompt still parked locally as denied, since interrupt() only aborts the SDK's own
// wait; OUR canUseTool promise is resolved by us and would otherwise dangle forever. The eventual
// `result` message (subtype "interrupt") that comes back through handleMessage() does the rest of the
// cleanup (busy=false, clears liveTools/liveTasks, broadcasts idle activity).
export async function stop(key: string): Promise<boolean> {
  const s = store.get(key);
  if (!s || s.closed) return false;
  try { await s.q?.interrupt?.(); } catch { /* best effort — the turn may already be finishing */ }
  for (const [, p] of s.pending) p.resolve({ behavior: "deny", message: "Stopped by user." });
  s.pending.clear();
  return true;
}

export function setMode(key: string, mode?: string): void {
  const s = store.get(key);
  try { s?.q?.setPermissionMode?.(safeMode(mode)); } catch { /* not initialized yet */ }
}

// Subscribe an SSE client. `exists` tells the route whether a live session backs this key at all (so a
// refreshed client that reattaches to a session that already ended is told to fall back to the on-disk
// view). The `replay` reconstructs the current state for a (re)connecting client: the session id, the
// in-flight turn (busy + partial text so far), and any permission/ask prompt still awaiting an answer —
// so a mid-task refresh lands you exactly where you were, pending approvals included.
export function subscribe(key: string, sub: Sub): { replay: AgentEvent[]; unsubscribe: () => void; exists: boolean } {
  const s = store.get(key);
  if (!s || s.closed) {
    // No session yet — park the subscriber so the send() that's racing this GET adopts it on create.
    // (`exists: false` still goes back to the route; only an explicit re-attach turns it into a
    // `detached` event, since on the send path the session is about to exist.)
    const set = waiting.get(key) || new Set<Sub>();
    set.add(sub);
    waiting.set(key, set);
    return {
      replay: [],
      // By the time the client disconnects, the session may have adopted this sub — drop it from both.
      unsubscribe: () => {
        const w = waiting.get(key);
        if (w) { w.delete(sub); if (!w.size) waiting.delete(key); }
        const live = store.get(key);
        if (live?.subs.delete(sub) && live.subs.size === 0) scheduleIdle(live);
      },
      exists: false,
    };
  }
  s.subs.add(sub);
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  const replay: AgentEvent[] = [];
  if (s.sessionId) replay.push({ t: "init", sessionId: s.sessionId });
  // `activity` rides along so a client that refreshed mid-tool-call resumes with the real label and a
  // correctly-offset elapsed clock, instead of falling back to a generic "working…".
  replay.push({ t: "snapshot", busy: s.busy, partial: s.partial, partialThinking: s.partialThinking, activity: activityOf(s) });
  for (const [id, p] of s.pending) {
    if (p.toolName === "AskUserQuestion") replay.push({ t: "ask", id, questions: (p.input as { questions?: AgentQuestion[] })?.questions || [] });
    else replay.push({ t: "permission", id, toolName: p.toolName, input: p.input });
  }
  return {
    replay,
    unsubscribe: () => { s.subs.delete(sub); if (s.subs.size === 0) scheduleIdle(s); },
    exists: true,
  };
}

// A snapshot of every live session's current activity, keyed by Claude sessionId — polled by the grid
// so each running Bento tile can show what it's doing (thinking / reading X / running: …).
export function liveActivity(): Record<string, { phase: ActivityPhase; label: string; busy: boolean; cwd: string }> {
  const out: Record<string, { phase: ActivityPhase; label: string; busy: boolean; cwd: string }> = {};
  const seen = new Set<Session>();
  for (const s of store.values()) {
    if (seen.has(s) || s.closed || !s.sessionId) continue; // store holds each session under 2 keys — dedup
    seen.add(s);
    const a = activityOf(s);
    // NB: no elapsedMs — it changes every poll, which would defeat the grid's change-detection and
    // re-render the whole (framer-motion) tile grid every 1.5s (lag + CPU heat).
    out[s.sessionId] = { phase: a.phase, label: a.label, busy: s.busy, cwd: s.cwd };
  }
  return out;
}

export function closeSession(key: string): void {
  const s = store.get(key);
  if (!s) return;
  s.closed = true;
  for (const [, p] of s.pending) p.resolve({ behavior: "deny", message: "Session closed." });
  s.pending.clear();
  if (s.waiter) { const w = s.waiter; s.waiter = null; w(); }
  try { s.q?.close?.(); } catch { /* already gone */ }
  if (s.idleTimer) clearTimeout(s.idleTimer);
  // Remove BOTH the pane-key entry and the sessionId alias so neither leaks a closed session.
  store.delete(key);
  store.delete(s.key);
  if (s.sessionId) store.delete(SID_KEY + s.sessionId);
}
