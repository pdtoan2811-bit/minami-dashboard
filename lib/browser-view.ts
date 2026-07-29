// Everything the browser panel knows, derived from tool calls that ALREADY flow over SSE.
//
// Bento's browser is headless (see manager.ts), which is the whole reason this file exists. Claude
// Code's own browser integration drives your real, visible Chrome — so it needs no viewport UI at all;
// its entire surface is a status panel, a permission gate and an activity log. A headless browser has
// no window to look at, so Bento's panel has to *be* the browser window, which means reconstructing
// URL / title / console / network / history from what the Playwright MCP tools happen to report back.
//
// That reporting is richer than it looks. Every `browser_*` result is ONE text block of markdown
// sections, emitted in a fixed order (playwright-core's `Response._build()`):
//
//     ### Error              (only on failure)
//     ### Result             (tool-specific: console messages, network requests, evaluate result…)
//     ### Ran Playwright code
//     ```js
//     await page.goto('http://localhost:3000');
//     ```
//     ### Open tabs          (only when the tab count is not exactly 1)
//     ### Page
//     - Page URL: http://localhost:3000/
//     - Page Title: Minami Bento — Claude Code mission control
//     - HTTP status: 500       (only when non-2xx)
//     - Console: 1 errors, 0 warnings
//     ### Snapshot
//     - [Snapshot](.playwright-mcp/page-2026-07-28T13-34-41-131Z.yml)
//     ### Events
//     - New console entries: .playwright-mcp/console-2026-07-28T13-34-40-883Z.log#L1
//
// Two facts drive the design here:
//
//   1. `summarizeToolResult` caps each text block at OUTPUT_MAX_TEXT (4000 chars, labels.ts:36), and
//      Playwright puts everything in ONE block — so it's a head-cut. `### Page` lands before the
//      (potentially enormous) snapshot, so URL/title/console survive; `### Events` may not. Parse
//      defensively and treat every field as optional: a truncated tail must degrade to "no new
//      information", never to wrong information.
//   2. The interesting payloads are on DISK, under `<session cwd>/.playwright-mcp/` — full-resolution
//      PNGs, the `page-*.yml` accessibility snapshot, and `console-*.log` with the actual console text
//      (an action result only ever carries the console *counts*). Those paths appear in the text, so
//      capturing them here is what lets the panel show real console output and full-res screenshots
//      without asking the agent for anything extra. `.gitignore` already covers that directory.
//
// Kept pure and free of React/node imports so both the docked panel and the pop-out window render from
// the same derivation, and so it stays unit-testable.

import { activityLabel, toolCategory, type ToolOutput, type ToolOutputBlock } from "./agent/labels";

/** The shape this module needs from a tool call. Structurally compatible with `AgentToolCall`
 *  (lib/use-agent.ts) and with the disk-loaded `ToolCallRecord` — declared locally so this file stays
 *  importable from both server and client without dragging in the React hook module. */
export type BrowserToolCall = { name: string; input?: unknown; id?: string; done?: boolean; ok?: boolean; ms?: number; output?: ToolOutput };

/** One screenshot the agent took, plus the page context it was taken on. */
export type Shot = {
  /** Stable identity for React keys and lightbox selection: tool-call id + block index. */
  id: string;
  mediaType: string;
  /** Inline base64 — instant, but stripped from sessionStorage by trimOutput, so lost on reload. */
  data?: string;
  /** Filename inside the session's MCP --output-dir. Full resolution, survives a reload. */
  file?: string;
  url?: string;
  title?: string;
  /** Human label for what produced it, e.g. "clicking Submit". */
  action: string;
  toolName: string;
  /** Turn timestamp when known — AgentToolCall itself carries none. */
  at?: number;
};

export type NetRow = { method?: string; url: string; status?: number; type?: string };

/** One `browser_*` call, for the panel's Actions tab — the analogue of Claude Code's activity log. */
export type BrowserAction = {
  id: string;
  toolName: string;
  /** Claude Code-style compact arg summary, e.g. `example.com`, `type "hello"`, `1280x800`. */
  arg: string;
  /** Plain-English verb phrase, e.g. "click", "read the page". */
  verb: string;
  label: string;
  done?: boolean;
  ok?: boolean;
  ms?: number;
  hadImage: boolean;
  at?: number;
};

export type BrowserState = {
  /** The agent has used a browser tool at least once in this transcript. */
  everUsed: boolean;
  /** No successful browser_close since the last browser call — the best "is a browser alive" signal
   *  available, since nothing tracks the MCP subprocess. Combine with `agent.live` at the call site. */
  open: boolean;
  url?: string;
  title?: string;
  httpStatus?: number;
  crashed?: boolean;
  /** Latest page-level error text, if the most recent call failed. */
  error?: string;
  /** Viewport, seeded from the MCP spawn config and updated by every browser_resize. */
  viewport?: string;
  consoleErrors: number;
  consoleWarnings: number;
  /** Console lines from an explicit browser_console_messages call. */
  consoleLines: string[];
  /** Newest `console-*.log` filename — the panel reads real console text through this. */
  consoleLog?: string;
  network: NetRow[];
  tabCount?: number;
  recording: boolean;
  shots: Shot[];
  actions: BrowserAction[];
  /** How many browser calls have happened since the newest screenshot — the "what you see is old" hint.
   *  Mirrors Claude Code's own guard: "Screen content ... changed since the last screenshot." */
  staleBy: number;
};

const EMPTY: BrowserState = {
  everUsed: false, open: false, consoleErrors: 0, consoleWarnings: 0, consoleLines: [],
  network: [], recording: false, shots: [], actions: [], staleBy: 0,
};

/** What manager.ts spawns Playwright MCP with (`--viewport-size=1280x800`). Seeded so the toolbar can
 *  show a viewport before the agent has ever resized. A user's own MCP config could differ — this is a
 *  display default, nothing depends on it being exact. */
export const DEFAULT_VIEWPORT = "1280×800";

export const isBrowserTool = (name: string) => toolCategory(name) === "browser";

/** `mcp__playwright__browser_take_screenshot` → `take_screenshot`. Prefix varies with MCP config. */
export function browserAction(name: string): string | null {
  const m = /browser_(.+)$/.exec(name);
  return m ? m[1] : null;
}

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Host for the permission prompt — `localhost:3000` keeps its port, since that IS the identity of a
 *  dev server. Claude Code treats `localhost:PORT` as a first-class permission subject for the same
 *  reason. Returns null for about:/chrome:/unparseable URLs. */
export function hostOf(url?: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.host.replace(/^www\./, "");
  } catch { return null; }
}

/**
 * Plain-English verb phrase for a browser tool, in the shape Claude Code uses for its permission
 * prompts ("Claude in Chrome wants to *fill in a form field* on example.com"). Deliberately mirrors
 * that vocabulary rather than inventing a parallel one — the wording is well-tested and reads well
 * mid-sentence, which is the only place it's ever used.
 */
export function browserVerb(name: string): string {
  switch (browserAction(name)) {
    case "navigate": return "navigate";
    case "navigate_back": return "go back";
    case "navigate_forward": return "go forward";
    case "snapshot": return "read the page";
    case "find": return "find an element";
    case "click": return "click";
    case "hover": return "hover";
    case "type": case "press_sequentially": return "type text";
    case "press_key": return "press keys";
    case "fill_form": return "fill in a form";
    case "select_option": return "select an option";
    case "drag": return "drag an element";
    case "file_upload": return "upload a file";
    case "take_screenshot": return "take a screenshot";
    case "pdf_save": return "save a PDF";
    case "evaluate": case "run_code_unsafe": return "run JavaScript";
    case "console_messages": return "read console messages";
    case "network_requests": case "network_request": return "read network requests";
    case "resize": return "resize the window";
    case "tabs": return "manage browser tabs";
    case "start_video": return "record the page";
    case "stop_video": return "stop recording";
    case "video_chapter": return "mark a chapter in the recording";
    case "annotate": return "annotate the page";
    case "wait_for": return "wait for the page";
    case "close": return "close the browser";
    case "handle_dialog": return "answer a page dialog";
    case "highlight": case "hide_highlight": return "highlight an element";
    case "drop": return "drop an element";
    case "mouse_wheel": return "scroll";
    case "start_tracing": case "stop_tracing": return "record a trace";
    default: return "use the browser";
  }
}

/**
 * Compact argument summary, following Claude Code's transcript convention of showing the ONE field that
 * matters rather than the whole input JSON: navigate shows only a hostname, type shows a clipped
 * string, resize shows `1280x800`. The full JSON stays available behind the row's expansion.
 */
export function browserArg(name: string, input?: unknown): string {
  const o = (input || {}) as Record<string, unknown>;
  const el = () => clip(o.element, 30);
  switch (browserAction(name)) {
    case "navigate": {
      const raw = String(o.url ?? "");
      return hostOf(raw) || clip(raw.replace(/^https?:\/\//, ""), 30);
    }
    case "click": case "hover": case "select_option": case "highlight": case "drag": case "drop": return el();
    case "handle_dialog": return o.accept ? "accept" : "dismiss";
    case "file_upload": {
      const p = Array.isArray(o.paths) ? o.paths : [];
      return p.length ? clip(String(p[0]).split("/").pop(), 24) : "";
    }
    case "network_request": return o.index ? `#${o.index}` : "";
    case "type": case "press_sequentially": {
      const t = clip(o.text, 15);
      return t ? `"${t}"` : el();
    }
    case "press_key": return clip(o.key, 20);
    case "find": return o.query ? `pattern: ${clip(o.query, 20)}` : "";
    case "resize": return o.width && o.height ? `${o.width}x${o.height}` : "";
    case "take_screenshot": return o.fullPage ? "full page" : o.element ? el() : "";
    case "console_messages": return clip(o.pattern, 20);
    case "network_requests": return clip(o.filter, 20);
    case "evaluate": case "run_code_unsafe": return clip(o.function || o.code, 24);
    case "tabs": return clip(o.action, 12);
    case "wait_for": return clip(o.text || o.time, 20);
    default: return "";
  }
}

/** Cheap read-only test, used to decide what plan mode can do without a prompt. Matches Claude Code's
 *  split: reading the page, finding, console, network and screenshots are read-only; anything that
 *  clicks, types, navigates or manages windows is state-changing. */
export function isReadOnlyBrowserTool(name: string): boolean {
  switch (browserAction(name)) {
    case "snapshot": case "find": case "take_screenshot": case "console_messages":
    case "network_requests": case "network_request": case "highlight": case "pdf_save":
      return true;
    default: return false;
  }
}

const textOf = (blocks?: ToolOutputBlock[]) =>
  blocks?.filter((b): b is Extract<ToolOutputBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("\n") || "";

export type ParsedResult = {
  url?: string;
  title?: string;
  httpStatus?: number;
  crashed?: boolean;
  error?: string;
  consoleErrors?: number;
  consoleWarnings?: number;
  consoleLines?: string[];
  /** Screenshot filenames inside `<cwd>/.playwright-mcp/`, in result order. */
  files?: string[];
  /** `console-*.log` in the same directory — where the actual console TEXT lives. */
  consoleLog?: string;
  /** `page-*.yml` accessibility snapshot in the same directory. */
  snapshotFile?: string;
  network?: NetRow[];
  tabCount?: number;
};

const fileName = (p: string) => p.split(/[\\/]/).pop()!.replace(/#.*$/, "");

/**
 * Pull page context out of one browser tool's result text. Everything is optional by design: a
 * truncated result, a tool that touches no page, or a future MCP version that reorders its preamble
 * should all degrade to "no new information", never to wrong information.
 */
export function parseBrowserResult(blocks?: ToolOutputBlock[]): ParsedResult {
  const text = textOf(blocks);
  if (!text) return {};
  const out: ParsedResult = {};

  const url = /^- Page URL:\s*(.+)$/m.exec(text);
  if (url) out.url = url[1].trim();
  const title = /^- Page Title:\s*(.*)$/m.exec(text);
  if (title) out.title = title[1].trim();
  const status = /^- HTTP status:\s*(\d{3})/m.exec(text);
  if (status) out.httpStatus = Number(status[1]);
  if (/^- Page status:\s*crashed/m.test(text)) out.crashed = true;

  // "### Error" through to the next section — the page-level failure, worth surfacing as a chip.
  const err = /^###\s*Error\s*\n([\s\S]*?)(?=\n###\s|\n*$)/m.exec(text);
  if (err) out.error = err[1].trim().slice(0, 300);

  // "- Console: 1 errors, 0 warnings" — either half may be absent depending on version.
  const con = /^- Console:\s*(.+)$/m.exec(text);
  if (con) {
    const e = /(\d+)\s+errors?/.exec(con[1]);
    const w = /(\d+)\s+warnings?/.exec(con[1]);
    out.consoleErrors = e ? Number(e[1]) : 0;
    out.consoleWarnings = w ? Number(w[1]) : 0;
  }

  // Screenshot filenames. Two shapes, because Playwright reports them differently depending on whether
  // a `filename` was passed: a markdown link ("- [Screenshot of viewport](./shot.png)") or, more often,
  // only inside the echoed code block ("// Screenshot viewport and save it as .playwright-mcp/page-….png"
  // plus `path: '…'`). Collect from all three and de-dupe — missing this is how the filmstrip ends up
  // with base64-only shots that vanish on reload.
  const files = new Set<string>();
  const patterns = [
    /\]\(([^)\s]+\.(?:png|jpe?g))\)/gi,        // markdown link
    /save it as\s+(\S+\.(?:png|jpe?g))/gi,      // code-block comment
    /path:\s*['"]([^'"]+\.(?:png|jpe?g))['"]/gi, // page.screenshot({ path: … })
  ];
  for (const re of patterns) for (let m = re.exec(text); m; m = re.exec(text)) files.add(fileName(m[1]));
  if (files.size) out.files = [...files];

  const clog = /(\S*console-[^\s)#]+\.log)/.exec(text);
  if (clog) out.consoleLog = fileName(clog[1]);
  const snap = /(\S*page-[^\s)#]+\.ya?ml)/.exec(text);
  if (snap) out.snapshotFile = fileName(snap[1]);

  // Console lines from an explicit browser_console_messages call — those DO land inline, under
  // "### Result", as "[ERROR] Uncaught TypeError … @ file:12".
  const lines = text.split("\n").filter((l) => /^\s*\[(ERROR|WARNING|LOG|INFO|DEBUG)\]/i.test(l));
  if (lines.length) out.consoleLines = lines.map((l) => l.trim()).slice(0, 200);

  // browser_network_requests: "[GET] http://x/api => [200] OK" (arrow and status are both optional).
  const net: NetRow[] = [];
  for (const l of text.split("\n")) {
    const m = /^\s*(?:\d+\.\s*)?\[(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\]\s+(\S+)(?:\s*=>\s*\[(\d{3})\])?/i.exec(l);
    if (m) net.push({ method: m[1].toUpperCase(), url: m[2], status: m[3] ? Number(m[3]) : undefined });
  }
  if (net.length) out.network = net.slice(0, 300);

  // browser_tabs list: "### Open tabs" followed by "- 0: (current) [Title] (url)".
  if (/###\s*Open tabs/i.test(text)) {
    const tabs = text.split("\n").filter((l) => /^\s*-\s*\d+:/.test(l)).length;
    if (tabs) out.tabCount = tabs;
  }
  return out;
}

/** A turn as far as this module cares: some tool calls, optionally timestamped. */
export type BrowserTurnLike = { tools: BrowserToolCall[]; ts?: number };

/**
 * Fold a whole transcript into one browser state. Single forward pass so that "latest wins" falls out
 * naturally for scalar fields (url, title, viewport) while shots and actions accumulate in order.
 *
 * Replaces the three ad-hoc useMemos this used to live in (app/page.tsx), so the docked panel, the
 * lightbox and the pop-out window can never disagree about what the browser is doing.
 */
export function deriveBrowserState(turns: BrowserTurnLike[]): BrowserState {
  let everUsed = false;
  const state: BrowserState = { ...EMPTY, viewport: DEFAULT_VIEWPORT, consoleLines: [], network: [], shots: [], actions: [] };
  // Tracked separately from shots.length so a screenshot that lands mid-turn resets staleness properly.
  let sinceShot = 0;
  let closed = false;

  for (const turn of turns) {
    for (const tool of turn.tools) {
      if (!isBrowserTool(tool.name)) continue;
      everUsed = true;
      const id = tool.id || `${state.actions.length}`;
      const parsed = parseBrowserResult(tool.output?.blocks);
      const images = tool.output?.blocks.filter((b): b is Extract<ToolOutputBlock, { type: "image" }> => b.type === "image") || [];
      const label = activityLabel(tool.name, tool.input);
      const o = (tool.input || {}) as Record<string, unknown>;

      if (parsed.url) state.url = parsed.url;
      if (parsed.title !== undefined) state.title = parsed.title;
      if (parsed.consoleErrors !== undefined) state.consoleErrors = parsed.consoleErrors;
      if (parsed.consoleWarnings !== undefined) state.consoleWarnings = parsed.consoleWarnings;
      if (parsed.consoleLines) state.consoleLines = parsed.consoleLines;
      if (parsed.consoleLog) state.consoleLog = parsed.consoleLog;
      if (parsed.network) state.network = parsed.network;
      if (parsed.tabCount !== undefined) state.tabCount = parsed.tabCount;
      // Page-level status is per-navigation, so let a clean result clear a stale error rather than
      // leaving a 500 chip stuck on the toolbar forever.
      if (parsed.url || parsed.httpStatus !== undefined) {
        state.httpStatus = parsed.httpStatus;
        state.crashed = parsed.crashed;
      }
      state.error = parsed.error;

      const action = browserAction(tool.name);
      if (action === "resize" && o.width && o.height) state.viewport = `${o.width}×${o.height}`;
      if (action === "start_video") state.recording = true;
      if (action === "stop_video") state.recording = false;
      if (action === "close" && tool.ok !== false) { closed = true; state.recording = false; }
      else if (action !== "close") closed = false;

      // Pair each image with a filename from the same result when the counts line up, so the lightbox
      // can prefer the full-resolution file on disk over the (downsampled, reload-lossy) base64.
      images.forEach((img, k) => {
        state.shots.push({
          id: `${id}:${k}`,
          mediaType: img.mediaType,
          data: img.data,
          file: parsed.files && parsed.files.length === images.length ? parsed.files[k] : parsed.files?.[0],
          url: parsed.url ?? state.url,
          title: parsed.title ?? state.title,
          action: label,
          toolName: tool.name,
          at: turn.ts,
        });
      });
      // A screenshot tool that reported a file but no inline image still belongs in the filmstrip —
      // that's what --image-responses=omit or an oversized capture looks like.
      if (!images.length && action === "take_screenshot" && parsed.files?.length) {
        for (const f of parsed.files) {
          state.shots.push({ id: `${id}:${f}`, mediaType: "image/png", file: f, url: parsed.url ?? state.url, title: parsed.title ?? state.title, action: label, toolName: tool.name, at: turn.ts });
        }
      }

      const gotShot = images.length > 0 || (action === "take_screenshot" && !!parsed.files?.length);
      sinceShot = gotShot ? 0 : sinceShot + 1;

      state.actions.push({
        id, toolName: tool.name, arg: browserArg(tool.name, tool.input), verb: browserVerb(tool.name),
        label, done: tool.done, ok: tool.ok, ms: tool.ms, hadImage: gotShot, at: turn.ts,
      });
    }
  }
  state.everUsed = everUsed;
  state.open = everUsed && !closed;
  state.staleBy = state.shots.length ? sinceShot : 0;
  return state;
}
