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
  | { t: "tool"; name: string; input: unknown } // a tool call started (live feedback)
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
  sessionId: string | null; // the real Claude Code session id (for resume + file reconcile)
  subs: Set<Sub>;
  buffer: AgentEvent[]; // recent events, replayed to a (re)connecting SSE client
  pending: Map<string, Pending>; // outstanding permission prompts
  idleTimer: ReturnType<typeof setTimeout> | null;
};

// Persist the registry on globalThis so Next.js dev hot-reloads don't orphan live sessions.
const store: Map<string, Session> = ((globalThis as any).__minamiAgentStore ||= new Map());
let permCounter = 0;

function broadcast(s: Session, ev: AgentEvent) {
  s.buffer.push(ev);
  if (s.buffer.length > 200) s.buffer.shift();
  for (const sub of s.subs) { try { sub(ev); } catch { /* dead client */ } }
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
    key, cwd, q: null, queue: [], waiter: null, closed: false, busy: false,
    sessionId: resume || null, subs: new Set(), buffer: [], pending: new Map(), idleTimer: null,
  };
  store.set(key, s);

  // Called by the SDK for any tool the user's config doesn't already auto-approve, AND for the
  // AskUserQuestion tool (Claude's clarifying question). We surface it and block until the user acts.
  const canUseTool = async (toolName: string, input: unknown): Promise<Decision> => {
    const id = "perm-" + ++permCounter;
    if (toolName === "AskUserQuestion") {
      broadcast(s, { t: "ask", id, questions: (input as { questions?: AgentQuestion[] })?.questions || [] });
    } else {
      broadcast(s, { t: "permission", id, toolName, input });
    }
    return new Promise<Decision>((resolve) => { s.pending.set(id, { resolve, toolName, input }); });
  };

  s.q = query({
    prompt: inputGen(s),
    options: {
      cwd,
      permissionMode: mode,
      canUseTool,
      includePartialMessages: true, // stream assistant text token-by-token
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
      broadcast(s, { t: "busy", busy: false });
    }
  })();

  return s;
}

function handleMessage(s: Session, m: any) {
  switch (m?.type) {
    case "system":
      if (m.subtype === "init" && m.session_id) {
        s.sessionId = m.session_id;
        broadcast(s, { t: "init", sessionId: m.session_id, model: m.model });
      }
      break;
    case "stream_event": {
      const ev = m.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        broadcast(s, { t: "delta", text: ev.delta.text });
      }
      break;
    }
    case "assistant": {
      // Text is already streamed via deltas; surface tool_use blocks for live "running X" feedback.
      const content = m.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) if (b?.type === "tool_use") broadcast(s, { t: "tool", name: b.name, input: b.input });
      }
      break;
    }
    case "result":
      s.busy = false;
      broadcast(s, { t: "result", subtype: m.subtype, costUsd: m.total_cost_usd ?? m.cost_usd });
      broadcast(s, { t: "busy", busy: false });
      scheduleIdle(s);
      break;
  }
}

// Send a user message; creates the session on first call (with resume/mode) or feeds the live one.
export function sendMessage(opts: { key: string; cwd: string; message: string; mode?: string; resume?: string }): { sessionId: string | null } {
  const s = ensureSession(opts.key, opts.cwd, safeMode(opts.mode), opts.resume);
  s.queue.push({ type: "user", message: { role: "user", content: opts.message }, parent_tool_use_id: null });
  s.busy = true;
  broadcast(s, { t: "busy", busy: true });
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
  return true;
}

export function setMode(key: string, mode?: string): void {
  const s = store.get(key);
  try { s?.q?.setPermissionMode?.(safeMode(mode)); } catch { /* not initialized yet */ }
}

export function subscribe(key: string, sub: Sub): { replay: AgentEvent[]; unsubscribe: () => void } {
  const s = store.get(key);
  if (!s) return { replay: [], unsubscribe: () => {} };
  s.subs.add(sub);
  if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
  return {
    replay: s.buffer.slice(-100),
    unsubscribe: () => { s.subs.delete(sub); if (s.subs.size === 0) scheduleIdle(s); },
  };
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
  store.delete(key);
}
