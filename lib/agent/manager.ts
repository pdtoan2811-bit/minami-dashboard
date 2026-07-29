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
// Safety: safeMode() clamps any unrecognized string to "default" before it reaches the SDK.
// "bypassPermissions" IS a real, user-selectable mode (the composer's "bypass" toggle, see
// app/page.tsx's MODE_HINT/perm state) — auto-approves every tool, no canUseTool prompt at all.
// It's opt-in and labeled with a warning in the UI, never the shipped default.
import { query, type EffortLevel, type Options } from "@anthropic-ai/claude-agent-sdk";
import { activityLabel, inputFromPartial, phaseLabel, summarizeToolResult, type ActivityPhase, type ActivityState, type LiveTask, type LiveTool, type ToolOutput } from "./labels";
import { DASHBOARD_MODEL } from "../model-pins";

// Default model/effort for every dashboard-driven session (anh, 2026-07-29: "go on Opus 5 default
// effort"). Opus 5 is the current top-tier model (see the claude-api skill's model table); "default
// effort" means DON'T force an override — leave `effort` unset so the SDK/model's own default
// applies, rather than pinning every session to "high" the way Minami's cloud brain does (that's a
// deliberate weekly-limit lever documented in the model-routing skill; the dashboard doesn't need
// it). Opus 5's 1M-token context window is already its default at standard pricing, no beta flag or
// extra option needed. Both overridable per-deploy without a code change — set
// MINAMI_DASHBOARD_EFFORT to pin an effort level again if ever wanted.
// Sourced from lib/model-pins.ts rather than repeated here, so this session model and the model the
// dashboard *alerts on* can never disagree — a drift warning that itself reads a stale copy of the
// pin would be worse than no warning. Still overridable via MINAMI_DASHBOARD_MODEL (see that file).
const DEFAULT_MODEL = DASHBOARD_MODEL;
const DEFAULT_EFFORT = process.env.MINAMI_DASHBOARD_EFFORT as EffortLevel | undefined;

// Auto-compact trigger threshold, as a percent of the context window — mirrors the same
// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE the CLI reads from ~/.claude/settings.json's "env" block
// (currently 60 there too). Set explicitly here rather than relying on inheriting the host's
// global settings, so the dashboard's behavior doesn't depend on which machine happens to run it.
const AUTOCOMPACT_PCT = process.env.MINAMI_DASHBOARD_AUTOCOMPACT_PCT || "60";

// The browser tool (Playwright MCP), given to every session unless explicitly disabled. MCP tools are
// deferred behind tool search by default, so a chat that never touches the browser pays ~nothing extra
// for this being registered — the subprocess only spawns once Claude actually reaches for a browser_*
// tool. `--isolated` keeps the browser profile in memory (fresh per session, nothing written to disk);
// `--headless` because what's watched is the dashboard's browser panel, not an actual OS window. Runs
// via `npx` so it resolves the locally-installed `@playwright/mcp` (already in package.json) without a
// registry round-trip.
//
// `--caps=devtools` adds the video/highlight/annotate tools on top of the 24 core ones — without it,
// `browser_start_video` simply does not exist and the panel's Record button has nothing to call. Video
// is the analogue of Claude Code's `gif_creator` (which it ships with click indicators and action
// labels baked in), and a recording of a flow is a far better QA artifact than a pile of stills.
//
// Not set here, deliberately: `--output-dir`. Playwright already writes screenshots, `page-*.yml`
// snapshots and `console-*.log` into `<cwd>/.playwright-mcp/` (git-ignored), which the panel reads
// through /api/agent/browser/file. Overriding it would only move the files somewhere the client can't
// guess from `cwd`.
const BROWSER_TOOL_ENABLED = process.env.MINAMI_DISABLE_BROWSER_TOOL !== "1";
const MCP_SERVERS: NonNullable<Options["mcpServers"]> | undefined = BROWSER_TOOL_ENABLED
  ? { playwright: { command: "npx", args: ["@playwright/mcp", "--isolated", "--headless", "--viewport-size=1280x800", "--caps=devtools"] } }
  : undefined;

// The browser is headless, so the ONLY way a human sees what it's doing is a screenshot landing in the
// panel. Left to itself Claude prefers `browser_snapshot` (an accessibility tree — cheaper in tokens
// and better for deciding what to click), which is correct for the model and useless for the watcher:
// the panel sits blank while the browser is genuinely busy on a page. One line of nudge fixes that.
// Only appended when the browser tool is actually registered, so a MINAMI_DISABLE_BROWSER_TOOL=1
// session doesn't get instructions about a tool it can't see.
const BROWSER_PROMPT = `When you use the browser tools, take a screenshot after navigating and after any action that changes what's on screen. The browser is headless and a human is watching those screenshots in a live panel — an accessibility snapshot is invisible to them.`;

// "bypassPermissions" auto-approves every tool with no prompt — powerful but dangerous. It's opt-in
// (the user has to pick it via the composer's "bypass" toggle), never the shipped default. Any string
// outside this list (typos, stale client state) is clamped to "default" by safeMode() below.
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
  | { t: "tool_end"; id: string; name: string; ok: boolean; ms: number; output?: ToolOutput } // its result came back
  | { t: "activity"; activity: ActivityState } // REPLACE semantics: the whole live-activity state
  // non-fatal, worth showing. `agent`/`status` are only set for kind "task" — the UI renders those as
  // compact inline pills (see SubagentStrip in app/page.tsx) rather than the generic text line, so it
  // needs the subagent's type and outcome as separate fields instead of parsing the prose in `text`.
  // "restarting" is the deploy path telling every open pane that the server is about to be swapped for
  // a new build — see drainForRestart() below. It's the one notice the user gets BEFORE the disruption
  // rather than after, which is the whole point: an unexplained dead turn reads as a bug.
  | { t: "notice"; kind: "retry" | "compact" | "task" | "limit" | "denied" | "aborted" | "restarting"; text: string; agent?: string; status?: "completed" | "failed" | "stopped" }
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

// How long a session may sit with NO connected client before it's reaped. This used to be a flat 10
// minutes, which quietly broke the phone view: backgrounding a mobile tab tears down the SSE stream,
// so "no listeners" is a routine, temporary state there — not evidence the user is gone. Ten minutes
// of looking away was enough to lose the warm subprocess and come back to a `detached` pane. The
// window is now long enough to cover a normal context-switch and overridable per-deploy.
const IDLE_REAP_MS = Math.max(60_000, Number(process.env.MINAMI_IDLE_REAP_MS) || 30 * 60 * 1000);

// Close a session that's been idle with no listeners for a while, so we don't leak CLI processes.
function scheduleIdle(s: Session) {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (s.subs.size !== 0) return; // someone (re)subscribed before the timer fired — nothing to do here;
    // subscribe() already cleared idleTimer on attach, and unsubscribe() will re-arm it later.
    if (s.pending.size) {
      // A permission/AskUserQuestion prompt was raised while this pane had no listeners (e.g. the tab
      // was closed mid-approval) and nobody's left to decide it. Left alone, canUseTool's promise never
      // resolves, which pins `busy` true forever — no `result` message can ever arrive to re-trigger
      // this same cleanup — so the session (and its SDK subprocess) would leak in the registry
      // permanently instead of being reaped like every other idle session. Auto-deny so the SDK call
      // unblocks and the turn runs to a natural (denied) conclusion instead.
      for (const [id, p] of s.pending) { p.resolve({ behavior: "deny", message: "No client connected — auto-denied after idle timeout." }); s.pending.delete(id); }
    }
    if (!s.busy) closeSession(s.key);
    // Still busy (e.g. the denial above hasn't produced a `result` yet, or a turn is genuinely still
    // running unattended) — check again rather than letting this session go unmonitored forever; the
    // "result" handler also re-arms this once the turn actually finishes, so this is just the backstop
    // for whatever falls through that path.
    else scheduleIdle(s);
  }, IDLE_REAP_MS);
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
      model: DEFAULT_MODEL,
      // Only set effort if explicitly pinned via env — omitting it lets the SDK/model default apply
      // (see the DEFAULT_EFFORT comment above; "default effort" was the explicit ask, not "high").
      ...(DEFAULT_EFFORT ? { effort: DEFAULT_EFFORT } : {}),
      // env is otherwise inherited from process.env by default (per the SDK's own doc comment) —
      // spread it explicitly so this override adds to, rather than replaces, everything the
      // subprocess already needs (PATH, HOME, ANTHROPIC_API_KEY, token-slayer's active credential).
      env: { ...process.env, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: AUTOCOMPACT_PCT },
      ...(MCP_SERVERS ? { mcpServers: MCP_SERVERS, systemPrompt: { type: "preset", preset: "claude_code", append: BROWSER_PROMPT } } : {}),
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
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
      // A permission/AskUserQuestion prompt still parked here has no one left to resolve it — the
      // query iterator has ended for good (crash, close, natural completion), so no future decide()/
      // answer() call will ever reach this session again (it's about to be deleted from `store` below).
      // Without this, the browser's dialog for that prompt is stuck forever with no working button: its
      // Allow/Deny POST does `store.get(key)` → undefined → returns false → the client only shows an
      // error, never clears `pending`/`ask` (see the "error" case in lib/use-agent.ts). Denying here
      // mirrors closeSession()'s own handling of a session closed while a prompt is outstanding.
      for (const [, p] of s.pending) p.resolve({ behavior: "deny", message: "Session ended." });
      s.pending.clear();
      resetActivity(s, "idle");
      broadcast(s, { t: "activity", activity: activityOf(s) });
      broadcast(s, { t: "busy", busy: false });
      // The query has ended for good here (crashed, closed, or the SDK's stream naturally finished) —
      // remove BOTH registry aliases now rather than relying solely on scheduleIdle, which only ever
      // gets armed after a `result` message (see handleMessage's "result" case). A session that throws
      // before its first turn ever completes (bad cwd, auth failure) never produces a `result`, so
      // without this it — and its `live:<sessionId>` alias, if `init` already fired — would sit in the
      // global `store` forever, growing it a little more on every such early failure. Identity-checked
      // (`=== s`) so this can't delete a NEWER session that's since been created under the same key.
      if (store.get(s.key) === s) store.delete(s.key);
      if (s.sessionId && store.get(SID_KEY + s.sessionId) === s) store.delete(SID_KEY + s.sessionId);
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
        // Capture the result content (text/images), not just pass/fail — this is what lets a browser
        // tool's screenshot (or any tool's actual output) show up in the transcript instead of just an
        // input JSON blob. summarizeToolResult caps size, so this stays cheap even for a chatty tool.
        const output = summarizeToolResult(b.content);
        broadcast(s, { t: "tool_end", id: t.id, name: t.name, ok: !b.is_error, ms: Date.now() - t.startedAt, output });
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
        broadcast(s, { t: "notice", kind: "task", text: `subagent ${m.status}: ${m.summary || t.description}`, agent: t.agent, status: m.status });
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
  // A session object existing (and not closed) means its SDK process is already warm — this is just
  // the next turn. Otherwise ensureSession() below is about to spin up a brand-new `query()`, which is
  // the actual ~1-2s cold start `spawning` narrates; a resumed (on-disk) conversation still pays this
  // the first time THIS pane drives it live, since the SDK process itself is new either way.
  const existing = store.get(opts.key);
  const cold = !existing || existing.closed;
  // Never let two SDK processes drive one conversation. `resume` hands the CLI a transcript to continue
  // and it appends to that same JSONL — so if the requested id is ALREADY live under a different key,
  // resuming it again gives two subprocesses interleaving writes into one file, and the transcript both
  // panes read back is corrupt in a way no reconcile can undo. The composer's continue-on-open feature
  // (see ChatColumn) already skips ids open in another pane, but that check races: a pane can go live in
  // the moment between the render that offered the id and the send that uses it. Fail loudly instead of
  // silently dropping `resume`, which would hand back a context-less session that LOOKS like it worked.
  if (opts.resume && (!existing || existing.closed)) {
    const owner = store.get(SID_KEY + opts.resume);
    if (owner && !owner.closed && owner.key !== opts.key) {
      throw new Error("That conversation is already open and running in another pane.");
    }
  }
  const s = ensureSession(opts.key, opts.cwd, safeMode(opts.mode), opts.resume);
  s.queue.push({ type: "user", message: { role: "user", content: opts.message }, parent_tool_use_id: null });
  s.busy = true;
  s.sawText = false; // fresh turn: the next text block opens the reply, no leading separator
  s.partial = "";
  s.partialThinking = "";
  // Start the indicator on the SAME tick as the send, not when the first SDK event arrives — the gap
  // is often a second or two of cold start, and a blank pane in that window reads as "nothing
  // happened, did my message send?". `spawning` vs `thinking` tells the two kinds of gap apart.
  resetActivity(s, cold ? "spawning" : "thinking");
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
  // Snapshot which prompts were ALREADY pending before we await interrupt() — a new turn can raise its
  // own permission/AskUserQuestion prompt (added to this same `pending` map) while interrupt() is still
  // resolving, if the user sends a fast follow-up message right after clicking Stop. Without this
  // snapshot, denying "whatever's in `pending` now" after the await would deny that brand-new turn's
  // prompt with a stale "Stopped by user" message it never asked for.
  const toDeny = [...s.pending.entries()];
  // Bounded: interrupt() is the SDK's own promise, and there's no guarantee it always settles (a wedged
  // subprocess pipe, e.g.) — the Stop button is the one manual escape hatch out of a stuck turn, so it
  // must never itself hang forever waiting on the very thing it's trying to unstick. On timeout we still
  // fall through and deny whatever's pending, same as the success path.
  await Promise.race([
    // Promise.resolve(...) wraps the case where interrupt itself is missing (undefined) so `.catch` is
    // always safe to call — `s.q?.interrupt?.()` alone would be `undefined.catch(...)` in that case.
    Promise.resolve(s.q?.interrupt?.()).catch(() => { /* best effort — the turn may already be finishing */ }),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]);
  for (const [id, p] of toDeny) {
    if (s.pending.get(id) === p) { p.resolve({ behavior: "deny", message: "Stopped by user." }); s.pending.delete(id); }
  }
  return true;
}

export function setMode(key: string, mode?: string): void {
  try {
    const s = store.get(key);
    const p = s?.q?.setPermissionMode?.(safeMode(mode));
    // setPermissionMode() returns a promise; this call is intentionally fire-and-forget (the route
    // just wants the mode applied, not to block on it), but an un-awaited promise that later rejects
    // (e.g. the mode toggle is flipped right as the session ends) becomes an UNHANDLED REJECTION with
    // nowhere to be caught — and with no global handler, Node's default is to crash the whole process,
    // killing every open pane over one stale mode change. Attaching a no-op .catch() here keeps it
    // fire-and-forget while ensuring it can never do that.
    if (p && typeof (p as Promise<unknown>).then === "function") (p as Promise<unknown>).catch(() => { /* session likely gone — nothing to do */ });
  } catch { /* not initialized yet */ }
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

// ---------------------------------------------------------------------------
// Restart safety.
//
// Every live session lives INSIDE this Next.js server process (`store` above), and each session's SDK
// subprocess is a CHILD of it. So `bin/serve.sh` swapping in a new build — `lsof -ti tcp:3000 | xargs
// kill` — takes down every chat mid-turn, along with its MCP servers. That is the single biggest
// source of "my request got interrupted and I never touched anything": the trigger is usually a
// DIFFERENT pane finishing an edit and redeploying, so it feels random to whoever's typing.
//
// The durable fix is to stop hosting sessions in the process we redeploy (a standalone agent host,
// tracked separately). Until then these two exports let the deploy script look before it leaps:
// liveStats() so it can refuse to kill a busy turn, drainForRestart() so it warns the panes it is
// about to disconnect and gives in-flight turns a chance to land first.
// ---------------------------------------------------------------------------

export type LiveSessionInfo = { key: string; cwd: string; busy: boolean; phase: ActivityPhase; label: string; sessionId: string | null };
export type LiveStats = { sessions: number; busy: number; details: LiveSessionInfo[] };

// Dedup by identity: `store` holds each session under BOTH its pane key and `live:<sessionId>`, so a
// naive walk double-counts every session that has reached `init` and would report twice the real load.
function eachSession(): Session[] {
  const seen = new Set<Session>();
  const out: Session[] = [];
  for (const s of store.values()) {
    if (seen.has(s) || s.closed) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function liveStats(): LiveStats {
  const details = eachSession().map((s) => {
    const a = activityOf(s);
    return { key: s.key, cwd: s.cwd, busy: s.busy, phase: a.phase, label: a.label, sessionId: s.sessionId };
  });
  return { sessions: details.length, busy: details.filter((d) => d.busy).length, details };
}

// Tell every open pane the server is going down, then wait (bounded) for in-flight turns to finish.
// Deliberately does NOT close anything: the caller is about to kill the whole process anyway, and a
// session that finishes inside the window gets to write its final result to the JSONL — which is what
// the client reconciles against when it reattaches to the new build. Returns whether it went quiet.
export async function drainForRestart(timeoutMs = 60_000): Promise<{ drained: boolean; stillBusy: number; waitedMs: number }> {
  const startedAt = Date.now();
  for (const s of eachSession()) {
    broadcast(s, {
      t: "notice",
      kind: "restarting",
      text: "the dashboard server is restarting to apply a new build — this pane will reconnect on its own",
    });
  }
  // Poll rather than hook every completion path: `result`, an error, and a crashed subprocess all clear
  // `busy` through different code paths, and a 250ms poll is both simpler and impossible to leak.
  while (Date.now() - startedAt < timeoutMs) {
    const busy = eachSession().filter((s) => s.busy).length;
    if (!busy) return { drained: true, stillBusy: 0, waitedMs: Date.now() - startedAt };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { drained: false, stillBusy: eachSession().filter((s) => s.busy).length, waitedMs: Date.now() - startedAt };
}

export function closeSession(key: string): void {
  const s = store.get(key);
  if (!s) return;
  s.closed = true;
  for (const [, p] of s.pending) p.resolve({ behavior: "deny", message: "Session closed." });
  s.pending.clear();
  if (s.waiter) { const w = s.waiter; s.waiter = null; w(); }
  // close() may return a promise; guard against a later rejection going unhandled (harmless today since
  // instrumentation.ts's global handler catches it, but this keeps the same fire-and-forget-safely
  // pattern used by setMode() above instead of relying on that as the only backstop).
  try { Promise.resolve(s.q?.close?.()).catch(() => { /* already gone */ }); } catch { /* already gone */ }
  if (s.idleTimer) clearTimeout(s.idleTimer);
  // Remove BOTH the pane-key entry and the sessionId alias so neither leaks a closed session.
  store.delete(key);
  store.delete(s.key);
  if (s.sessionId) store.delete(SID_KEY + s.sessionId);
}
