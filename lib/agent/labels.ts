// Shared (server + client) vocabulary for "what is Claude doing right now".
//
// The live activity state is derived on the SERVER (lib/agent/manager.ts) so that it survives a
// browser refresh — it rides along in the reconnect snapshot — and so the inline transcript
// indicator and the composer status line can never disagree. The client only renders it.
//
// This file must stay free of "use client" / node-only imports: both sides import it.

export type ActivityPhase =
  | "idle" // no turn in flight
  | "spawning" // cold-starting the SDK process for this pane's FIRST message — distinct from
  // `thinking` so a fresh chat doesn't read as identically "stuck" to a slow mid-turn tool call
  | "thinking" // reasoning, or between tool calls with nothing else to show
  | "responding" // streaming answer text
  | "tool" // one or more tool calls in flight
  | "awaiting" // blocked on the user (permission prompt / AskUserQuestion)
  | "retrying" // the API call failed retryably and is backing off
  | "compacting"; // the context is being auto-compacted

/** A tool call that has started and not yet returned its result. */
export type LiveTool = { id: string; name: string; label: string; parentId?: string | null };
/** A running subagent (Task tool) or background task. */
export type LiveTask = { id: string; description: string; agent?: string; lastTool?: string; toolUses?: number };

/** One entry of the agent's TodoWrite plan. Rendered as a live checklist — see TodoChecklist in
 *  app/page.tsx. Sourced straight from a TodoWrite tool call's `input.todos`, which is already
 *  REPLACE-semantics (each call carries the whole current list), so the UI just needs the latest one. */
export type TodoItem = { content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string };

/** A single block of a tool's RESULT (as opposed to its input, which is all the UI showed before).
 *  Text is length-capped; images carry their base64 payload so screenshots (browser tool, etc.) can
 *  render inline. Kept intentionally small/serializable — this rides over SSE and into localStorage. */
export type ToolOutputBlock = { type: "text"; text: string } | { type: "image"; mediaType: string; data: string };
export type ToolOutput = { blocks: ToolOutputBlock[]; truncated?: boolean };

const OUTPUT_MAX_TEXT = 4000;
const OUTPUT_MAX_IMAGES = 4;

/** Turn an SDK tool_result's `content` (string, or an array of Anthropic/MCP content blocks) into the
 *  small serializable shape the UI renders. Defensive about shape: MCP servers speak `{data,mimeType}`,
 *  the Anthropic API speaks `{source:{data,media_type}}` — accept either. Used both live (manager.ts,
 *  as results stream in) and on disk (claude-sessions.ts, re-parsing the JSONL), so behavior can't drift
 *  between "watching it happen" and "reloaded the transcript" — same function, same caps, either path. */
export function summarizeToolResult(content: unknown): ToolOutput | undefined {
  if (content == null) return undefined;
  if (typeof content === "string") {
    if (!content.trim()) return undefined;
    const truncated = content.length > OUTPUT_MAX_TEXT;
    return { blocks: [{ type: "text", text: truncated ? content.slice(0, OUTPUT_MAX_TEXT) : content }], truncated };
  }
  if (!Array.isArray(content)) return undefined;
  const blocks: ToolOutputBlock[] = [];
  let truncated = false;
  let images = 0;
  for (const raw of content) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    if (o.type === "text" && typeof o.text === "string") {
      const over = o.text.length > OUTPUT_MAX_TEXT;
      if (over) truncated = true;
      blocks.push({ type: "text", text: over ? o.text.slice(0, OUTPUT_MAX_TEXT) : o.text });
    } else if (o.type === "image") {
      const src = (o.source || o) as Record<string, unknown>;
      const data = typeof src.data === "string" ? src.data : null;
      const mediaType = (src.media_type as string) || (o.mimeType as string) || "image/png";
      if (!data) continue;
      if (images < OUTPUT_MAX_IMAGES) { blocks.push({ type: "image", mediaType, data }); images++; }
      else truncated = true;
    }
  }
  return blocks.length ? { blocks, truncated } : undefined;
}

export type ActivityState = {
  phase: ActivityPhase;
  /** One-line human summary — this is what the UI animates next to the dots. */
  label: string;
  /** How long the current phase has been running, in ms. The client turns this into a wall-clock
   *  start time (`Date.now() - elapsedMs`) so its own ticking timer stays correct across a reconnect
   *  without depending on the server and browser clocks agreeing. */
  elapsedMs: number;
  tools: LiveTool[];
  tasks: LiveTask[];
  /** Transient detail that outranks the phase label (retry attempt, compaction size). */
  note?: string;
};

export const IDLE_ACTIVITY: ActivityState = { phase: "idle", label: "", elapsedMs: 0, tools: [], tasks: [] };

/**
 * Coarse grouping for a tool name, used purely for UI color/iconography (chat panel tool chips, the
 * per-tool transcript block, and the bento tile's live-activity dot). Kept separate from
 * `activityLabel` because that one describes WHAT a call is doing; this one describes WHAT KIND of
 * call it is, which is the axis the UI colors by.
 */
export type ToolCategory = "read" | "write" | "exec" | "search" | "web" | "browser" | "task" | "plan" | "ask" | "skill" | "mcp" | "other";
// Any MCP server whose tool names follow the `browser_*` convention (the Playwright MCP server does,
// see manager.ts) gets its own category rather than falling into the generic "mcp" bucket — screenshots
// and live navigation read very differently from a generic tool call and deserve their own color/icon.
const BROWSER_TOOL_RE = /^mcp__[^_]+(?:_[^_]+)*__browser_/;
export function toolCategory(name: string): ToolCategory {
  switch (name) {
    case "Read": return "read";
    case "Edit": case "Write": case "NotebookEdit": return "write";
    case "Bash": case "BashOutput": return "exec";
    case "Grep": case "Glob": return "search";
    case "WebSearch": case "WebFetch": return "web";
    case "Task": case "Agent": return "task";
    case "TodoWrite": case "ExitPlanMode": return "plan";
    case "AskUserQuestion": return "ask";
    case "Skill": case "ToolSearch": return "skill";
    default:
      if (BROWSER_TOOL_RE.test(name)) return "browser";
      return name.startsWith("mcp__") ? "mcp" : "other";
  }
}

const base = (p: string) => String(p).split("/").filter(Boolean).pop() || String(p);
const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** `mcp__linear__create_issue` → `linear: create issue` */
function mcpLabel(name: string): string | null {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (!m) return null;
  return `${m[1].replace(/_/g, " ")}: ${m[2].replace(/_/g, " ")}`;
}

/**
 * A short human label for a single tool call. `input` is frequently EMPTY here: the earliest signal
 * we get for a tool is `content_block_start`, which names the tool before its arguments have
 * streamed in. So every branch must degrade to something sensible with no input, and the label is
 * recomputed once the full `assistant` message lands with the real arguments.
 */
export function activityLabel(name: string, input?: unknown): string {
  const o = (input || {}) as Record<string, unknown>;
  switch (name) {
    case "Bash":
    case "BashOutput":
      return o.command ? `run: ${clip(o.command, 48)}` : "running a command";
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return o.file_path ? `editing ${base(String(o.file_path))}` : "editing a file";
    case "Read":
      return o.file_path ? `reading ${base(String(o.file_path))}` : "reading a file";
    case "Grep":
      return o.pattern ? `searching “${clip(o.pattern, 30)}”` : "searching the code";
    case "Glob":
      return o.pattern ? `globbing ${clip(o.pattern, 30)}` : "listing files";
    case "WebSearch":
      return o.query ? `searching the web: ${clip(o.query, 34)}` : "searching the web";
    case "WebFetch":
      return o.url ? `fetching ${clip(String(o.url).replace(/^https?:\/\//, ""), 34)}` : "fetching a page";
    case "TodoWrite":
      return "updating the plan";
    case "Task":
    case "Agent":
      return o.description ? `subagent: ${clip(o.description, 34)}` : "running a subagent";
    case "Skill":
      return o.skill ? `skill: ${clip(o.skill, 30)}` : "loading a skill";
    case "ExitPlanMode":
      return "presenting the plan";
    case "AskUserQuestion":
      return "asking you a question";
    case "ToolSearch":
      return "looking up tools";
    default: {
      const browser = browserToolLabel(name, o);
      return browser || mcpLabel(name) || `using ${name}`;
    }
  }
}

/** Human labels for the Playwright browser tool's `browser_*` actions — same idea as the switch above,
 *  just keyed off the action suffix since the server prefix (`mcp__playwright__`) varies by MCP config. */
function browserToolLabel(name: string, o: Record<string, unknown>): string | null {
  const m = /__browser_(.+)$/.exec(name);
  if (!m) return null;
  const action = m[1];
  const url = () => (o.url ? clip(String(o.url).replace(/^https?:\/\//, ""), 34) : null);
  const el = () => (o.element ? clip(String(o.element), 30) : null);
  switch (action) {
    case "navigate": return url() ? `browsing ${url()}` : "navigating";
    case "navigate_back": return "going back";
    case "navigate_forward": return "going forward";
    case "click": return el() ? `clicking ${el()}` : "clicking";
    case "hover": return el() ? `hovering ${el()}` : "hovering";
    case "type": return el() ? `typing into ${el()}` : "typing";
    case "press_key": case "press_sequentially": return "pressing keys";
    case "fill_form": return "filling out a form";
    case "select_option": return el() ? `selecting an option in ${el()}` : "selecting an option";
    case "take_screenshot": return "taking a screenshot";
    case "snapshot": return "reading the page";
    case "find": return "finding an element";
    case "tabs": return "managing tabs";
    case "resize": return "resizing the browser";
    case "close": return "closing the browser";
    case "drag": return "dragging";
    case "wait_for": return "waiting on the page";
    case "evaluate": return "running a script on the page";
    case "console_messages": return "reading console logs";
    case "network_requests": return "reading network requests";
    case "pdf_save": return "saving a PDF";
    case "start_video": return "recording the browser";
    case "stop_video": return "stopping the recording";
    default: return `browser: ${action.replace(/_/g, " ")}`;
  }
}

/**
 * Refine a tool label from the tool input as it STREAMS in (`input_json_delta` partial JSON), before
 * the full assistant message lands. Regex-grabs the one field that matters per tool from the partial
 * buffer, so "reading a file" becomes "reading package.json" almost immediately instead of only for
 * the blink between the complete message and a fast tool finishing. Returns null until the field lands.
 */
export function inputFromPartial(name: string, buf: string): Record<string, string> | null {
  const grab = (key: string): string | null => {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(buf);
    return m ? m[1].replace(/\\(.)/g, "$1") : null;
  };
  const one = (key: string, field: string): Record<string, string> | null => {
    const v = grab(key); return v ? { [field]: v } : null;
  };
  switch (name) {
    case "Bash": case "BashOutput": return one("command", "command");
    case "Edit": case "Write": case "NotebookEdit": case "Read": return one("file_path", "file_path");
    case "Grep": case "Glob": return one("pattern", "pattern");
    case "WebSearch": return one("query", "query");
    case "WebFetch": return one("url", "url");
    case "Task": case "Agent": return one("description", "description");
    case "Skill": return one("skill", "skill");
    default:
      if (/__browser_navigate$/.test(name)) return one("url", "url");
      if (/__browser_(click|hover|select_option)$/.test(name)) return one("element", "element");
      return null;
  }
}

/** The most informative running subagent, rendered as one line. */
function taskLabel(tasks: LiveTask[]): string {
  const t = tasks[tasks.length - 1];
  if (!t) return "working…";
  const who = t.agent ? `subagent (${t.agent})` : t.description ? `subagent: ${clip(t.description, 30)}` : "subagent";
  const more = tasks.length > 1 ? ` +${tasks.length - 1}` : "";
  const detail = t.lastTool ? ` · ${t.lastTool}` : "";
  return `${who}${more}${detail}`;
}

/**
 * Collapse the whole activity state into the single line the UI shows. Kept deliberately total:
 * every phase yields a non-empty string except `idle`, so the indicator can never render blank
 * while a turn is still in flight.
 */
export function phaseLabel(phase: ActivityPhase, tools: LiveTool[], tasks: LiveTask[], note?: string | null): string {
  if (note && (phase === "retrying" || phase === "compacting" || phase === "awaiting")) return note;
  switch (phase) {
    case "idle":
      return "";
    case "spawning":
      return "starting session…";
    case "awaiting":
      return "waiting for you";
    case "retrying":
      return "retrying…";
    case "compacting":
      return "compacting context…";
    case "responding":
      return "writing…";
    case "thinking":
      return tasks.length ? taskLabel(tasks) : "thinking…";
    case "tool": {
      // A Task/Agent call is represented by its richer LiveTask entry, so don't double-count it.
      const own = tools.filter((t) => !t.parentId && t.name !== "Task" && t.name !== "Agent");
      if (own.length > 1) return `${own.length} tools · ${own[own.length - 1].label}`;
      if (own.length === 1) return own[0].label;
      return tasks.length ? taskLabel(tasks) : "working…";
    }
    default:
      return "working…";
  }
}

/**
 * Extra reassurance layered onto the primary label once a phase has run long enough that "is this
 * stuck?" becomes a fair question — client-only concern (elapsed is a live local tick off the phase
 * clock), so it's kept separate from phaseLabel() rather than folded into the server's broadcast.
 *
 * For `spawning` this drives the whole visible label (there's no real per-step signal for SDK cold
 * start, just elapsed time, so the copy narrates a plausible sequence instead of showing a static
 * string for what's usually a 1-2s wait). For every other phase it's an ADDITIONAL aside next to the
 * existing (more specific) label, only once a task has clearly run past typical duration.
 */
export function escalationHint(phase: ActivityPhase, elapsedMs: number): string | null {
  if (phase === "idle" || phase === "awaiting") return null;
  const s = elapsedMs / 1000;
  if (phase === "spawning") {
    if (s < 1.2) return null;
    if (s < 3.5) return "loading context…";
    return "still starting — unusually slow";
  }
  if (s < 30) return null;
  if (s < 120) return "still working…";
  return "longer tasks can take a few minutes";
}
