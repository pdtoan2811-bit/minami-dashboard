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
// Permissions: the mode is enforced by canUseTool in THIS file, not merely handed to the SDK — see
// DEFAULT_PERMISSION_MODE and the comment inside canUseTool for why (the SDK's setPermissionMode()
// accepts a mid-session change and then ignores it). safeMode() clamps any unrecognised string to
// "default", so only an explicit, recognised value can ever widen permissions.
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import pathMod from "node:path";
import { query, type EffortLevel, type Options } from "@anthropic-ai/claude-agent-sdk";
import { activityLabel, inputFromPartial, phaseLabel, summarizeToolResult, type ActivityPhase, type ActivityState, type LiveTask, type LiveTool, type ToolOutput } from "./labels";
import { DASHBOARD_MODEL } from "../model-pins";
import { releaseClaim, touchClaim, worktreeOf } from "../worktree-claim";
import { isolate, isolateMode, moveTranscriptHome } from "../worktree";

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

// The ending contract. The pane renders this block as clickable preview chips (see PreviewChips in
// the shell) — the whole point is that "where do I see the work?" stops being a follow-up question.
// Appended to EVERY dashboard session regardless of cwd, which is why it lives here and not in a
// skill: a skill loads when the model decides it's relevant, and an ending convention only works if
// it is unconditional.
const PREVIEW_PROMPT = `End every reply whose work produced something viewable — a page, a file, a document, a build, a screenshot — with a fenced code block of language \`minami-preview\` as the LAST thing in the message, containing a JSON array of previews:

\`\`\`minami-preview
[{"kind":"url","target":"http://localhost:3000","label":"the dashboard"},{"kind":"file","target":"/absolute/path/to/file.md","label":"the note"},{"kind":"cmd","target":"npm run kb","label":"open the KB"}]
\`\`\`

kind "url" = reachable from THIS machine's browser right now (verify the server is actually up before claiming it); "file" = absolute path to a file worth opening; "cmd" = a command the user runs to see it. 1-4 entries, labels under 5 words. A running localhost URL is the preview that matters most: whenever the work can be seen in a local server — a page changed, an app running, a dev server started — put that url FIRST, even if files were also written. Omit the block entirely when the turn produced nothing viewable (a question answered, a config change with nothing to look at) — an empty or speculative block is worse than none.`;

// Fan-out: propose parallel subagents for divisible work, and default to PROCEEDING — the whole
// reason this is a mode is that "shall I fan out?" as a question costs a round-trip to a user who
// already said yes by turning it on. Gated per-session (see ensureSession) so the pill can turn it
// off for surgical single-file work where a swarm is noise.
const FANOUT_PROMPT = `When a task has independently workable parts — multiple files to sweep, several questions to research, review from more than one angle — briefly state a fan-out plan (which agents, what each covers) and then IMMEDIATELY proceed with it using the Agent tool with parallel invocations; the user has pre-approved fan-out by enabling this mode, so do not wait for a yes. Stay solo only when the task is genuinely serial or trivial. The user-level "fanout" skill, if listed, has the fuller procedure.`;

// Default for panes that haven't chosen (and the send route's fallback). On by default per the
// mode's design; a box that wants opt-in instead sets MINAMI_DASHBOARD_FANOUT=0.
const DEFAULT_FANOUT = process.env.MINAMI_DASHBOARD_FANOUT !== "0";

// "bypassPermissions" auto-approves every tool with no prompt — powerful, and the configured default
// on this box (Thomas's explicit call: every prompt on a local, single-user machine is friction he
// pays for and never wanted). Override per install with MINAMI_DASHBOARD_PERMISSION_MODE.
//
// Note what is and isn't defaulted: a *missing* mode gets DEFAULT_MODE, but a mode string that isn't
// recognised (a typo, stale client state, a hand-rolled request) is still clamped to the most
// restrictive "default". Garbage input must never be able to widen permissions.
export type AllowedMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
const ALLOWED: AllowedMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
export const safeMode = (m?: string): AllowedMode => (ALLOWED.includes(m as AllowedMode) ? (m as AllowedMode) : "default");
export const DEFAULT_PERMISSION_MODE: AllowedMode =
  ALLOWED.includes(process.env.MINAMI_DASHBOARD_PERMISSION_MODE as AllowedMode)
    ? (process.env.MINAMI_DASHBOARD_PERMISSION_MODE as AllowedMode)
    : "bypassPermissions";

// Tools `acceptEdits` is meant to wave through. Everything else still asks.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** What to hand the SDK at spawn time — NOT the mode this server enforces.
 *
 *  A session born in `bypassPermissions` never calls `canUseTool` at all: the CLI resolves every tool
 *  itself and our hook is dead code for that session's whole life. That was already known (see the
 *  comment inside canUseTool) and it has two consequences that both look like bugs:
 *
 *   - the composer's approval pills can't TIGHTEN a running bypass session — `setPermissionMode()` is
 *     accepted and ignored, and our gate is never consulted, so there is nowhere left to enforce it;
 *   - the Flow view's brake can never fire, because the brake IS that gate. Measured: hold armed, the
 *     pane showing "release", and three Bash calls running through untouched.
 *
 *  So spawn permissive-but-observable — `default` makes the CLI ask us about every tool — and let
 *  canUseTool apply the real mode from `s.mode`. That is what the file header already claims happens.
 *  This does not widen anything: `default` is the most restrictive mode, and every auto-approval still
 *  has to be granted explicitly by our own gate.
 *
 *  `plan` is passed through untouched. It isn't only a permission level — it changes how the model
 *  behaves (propose, don't apply), so rewriting it to `default` would silently disable Plan mode. */
const spawnMode = (m: AllowedMode): AllowedMode => (m === "plan" ? "plan" : "default");

// Events pushed to the browser over SSE.
export type AgentQuestion = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string; preview?: string }[] };
export type AgentEvent =
  | { t: "init"; sessionId: string; model?: string }
  | { t: "delta"; text: string } // streaming assistant text token(s)
  | { t: "thinking"; text: string } // streaming reasoning token(s) — see the `thinking` option below
  | { t: "snapshot"; busy: boolean; partial: string; partialThinking: string; activity: ActivityState; hold: boolean; queued: { uuid: string; text: string }[] } // sent on (re)subscribe: the in-flight turn's state
  // Messages handed to the CLI while a turn was running, still awaiting their own turn. REPLACE
  // semantics like `activity`: the whole list every time, so a dropped event self-heals on the next one.
  | { t: "queued"; queued: { uuid: string; text: string }[] }
  // A queued message just BECAME the running turn. Carries its text because the `queued` broadcast that
  // rides alongside has already dropped it — and without the text the pane cannot put the message into
  // the transcript, which is the whole point: the reply that follows needs its question above it. See
  // handleCommandLifecycle, and §5f-bis for why this can be appended optimistically here and could not
  // be at queue time.
  | { t: "started"; uuid: string; text: string }
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
  | { t: "permission"; id: string; toolName: string; input: unknown; held?: boolean; expiresAt?: number } // waiting on the user
  | { t: "hold"; hold: boolean } // the Flow view's brake: park every tool call at the gate (REPLACE semantics)
  | { t: "ask"; id: string; questions: AgentQuestion[] } // Claude's AskUserQuestion tool
  | { t: "result"; subtype: string; costUsd?: number } // turn finished
  | { t: "busy"; busy: boolean }
  // The placement pass moved this conversation to a new folder (see relocate); the pane must adopt
  // the cwd and re-arm `resume`, exactly like a model swap's `respawned`.
  | { t: "relocated"; cwd: string; text: string }
  | { t: "error"; message: string };

type Decision = { behavior: "allow"; updatedInput?: unknown } | { behavior: "deny"; message: string };
// `timer` is only set for a HELD call (see setHold) — the auto-release backstop described there.
type Pending = { resolve: (d: Decision) => void; toolName: string; input: unknown; timer?: ReturnType<typeof setTimeout>; expiresAt?: number };
type Sub = (ev: AgentEvent) => void;

// How long a held tool call may sit at the gate before it releases itself. A parked canUseTool promise
// pins `busy` true — no `result` message can arrive while it's unresolved — and `busy` is what
// bin/deploy.sh waits on BOX-WIDE before restarting. So a hold that nobody comes back to doesn't just
// stall one pane, it starves every deploy on the machine (the deadlock documented in the minami-flow
// skill, reached there via an unanswered permission prompt). Bounded, so walking away is survivable.
//
// It expires to DENY, never allow: the entire point of the hold is that an unreviewed Edit/Bash must
// not run, and "the human never looked" is not approval. Denying also keeps the session alive — Claude
// reads the reason and carries on — where an abort would throw away the turn.
const HOLD_TIMEOUT_MS = Math.max(30_000, Number(process.env.MINAMI_HOLD_TIMEOUT_MS) || 10 * 60 * 1000);

type Session = {
  key: string;
  cwd: string;
  q: any | null; // the SDK Query (async generator + control methods)
  queue: any[]; // SDKUserMessage objects waiting to feed the input generator
  waiter: (() => void) | null; // resolves the generator's pending await when a message arrives
  /** Messages handed to the CLI while a turn was already running, still waiting their own turn.
   *
   *  This is a MIRROR of the CLI's queue, not our own holding pen: `streamInput` writes every yielded
   *  message straight down the pipe (it's a bare `for await … transport.write()` loop that doesn't wait
   *  for the turn to end), so by the time a message is in `s.queue` it's already gone. The CLI keeps it
   *  and reports its progress on the untyped `command_lifecycle` channel, keyed by the `uuid` WE stamp —
   *  which is the only reason this list can be accurate rather than guessed. See handleCommandLifecycle. */
  queued: { uuid: string; text: string; at: number }[];
  /** Backstop for the one way `queued` can lie: we hold `busy` across the gap between a turn's `result`
   *  and the next queued turn's `started` (measured at ~2ms), so a `started` that never arrives would
   *  pin the pane busy forever with no result coming to clear it. */
  queueTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
  busy: boolean;
  /** The permission mode this session is CURRENTLY under. The SDK is told too, but this is the copy
   *  the server enforces with — see canUseTool. */
  mode: AllowedMode;
  /** Flow view's brake. While true, canUseTool stops auto-approving REGARDLESS of `mode` and parks the
   *  next tool call at the gate — a real mid-flight halt with no process kill. Deliberately separate
   *  from `mode`: it's a transient supervision state the reviewer toggles, not a permission level, and
   *  conflating them would mean releasing the brake silently rewrote the session's permissions. */
  hold: boolean;
  sawText: boolean; // has the current turn streamed any assistant text yet? (for paragraph breaks)
  sawThinking: boolean; // ...same for reasoning, so the seam between thinking passes can be marked
  partial: string; // text of the assistant message currently streaming — replayed on reconnect so a
                   // refreshed client picks the sentence back up where it left off (reset per message)
  partialThinking: string; // same, for the reasoning stream
  sessionId: string | null; // the real Claude Code session id (for resume + file reconcile)
  /** The model this session was BORN with. Recorded so setModel() can tell a real change from a no-op
   *  — it is not a knob: nothing reads this to decide what runs, because by the time it is set the
   *  `query()` is already built around it. See setModel for why a change means a respawn. */
  model: string;
  /** Whether this session was BORN with the fan-out instruction in its system prompt. Creation-time
   *  only, same trap as `model`: an append can't be edited on a warm query, so setFanout() answers a
   *  mid-chat toggle the way setModel() does — teardown, and the next send resumes from disk. */
  fanout: boolean;
  /** Every file this session has WRITTEN (edit-tool targets), across all turns — the placement
   *  pass's evidence. Writes only, deliberately: a research sweep READS everywhere, and moving a
   *  chat because it grepped another repo would relocate half the box. Capped; the decision needs
   *  a pattern, not a census. */
  writePaths: string[];
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

// Resolve every parked prompt as denied. Centralised because a held call also owns a timer (see
// HOLD_TIMEOUT_MS) — resolving its promise without clearing that timer leaves a callback that fires
// minutes later and broadcasts a spurious "auto-denied" notice into a session that moved on long ago.
function denyAllPending(s: Session, message: string) {
  for (const [, p] of s.pending) { if (p.timer) clearTimeout(p.timer); p.resolve({ behavior: "deny", message }); }
  s.pending.clear();
}

function resetActivity(s: Session, phase: ActivityPhase, opts?: { keepTasks?: boolean }) {
  s.liveTools.clear();
  // A turn can END while agents it launched are still running (run_in_background) — any liveTasks
  // entry that never got its task_notification is still out there by definition, since a foreground
  // subagent always notifies before `result`. Wiping them at the turn boundary was why a reply
  // saying "waiting on C's sweep" sat next to a pane showing NOTHING about C. Teardown paths keep
  // clearing everything: when the subprocess dies, its background agents die with it.
  if (!opts?.keepTasks) s.liveTasks.clear();
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
      denyAllPending(s, "No client connected — auto-denied after idle timeout.");
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

// `model` overrides DEFAULT_MODEL for this session only, and is honoured just once — at creation,
// where `query()` is built. A warm session keeps the model it was born with, exactly as a running CLI
// session does (the same caveat lib/model-pins.ts states about account switching). Callers: the agent
// layer pins each agent's own tier, and the composer's model picker passes the pane's choice; everything
// else omits it and gets the box pin. Because it is creation-only, the picker cannot change a warm
// session by asking — it has to respawn it. See setModel().
function ensureSession(key: string, cwd: string, mode: AllowedMode, resume?: string, model?: string, fanout?: boolean): Session {
  const existing = store.get(key);
  if (existing && !existing.closed) return existing;

  const s: Session = {
    key, cwd, mode, hold: false, q: null, queue: [], queued: [], queueTimer: null, waiter: null, closed: false, busy: false, sawText: false, sawThinking: false, partial: "",
    partialThinking: "",
    sessionId: resume || null, model: model || DEFAULT_MODEL, fanout: fanout ?? DEFAULT_FANOUT, writePaths: [], subs: new Set(), pending: new Map(), idleTimer: null,
    phase: "idle", phaseSince: Date.now(), note: null, liveTools: new Map(), liveTasks: new Map(),
    toolBufs: new Map(),
  };
  store.set(key, s);
  // Stake the worktree the moment the session exists, not on its first turn. `liveActivity()` — the
  // other half of the occupancy signal — skips sessions that have no `sessionId` yet, and the SDK only
  // reports one after a ~1-2s cold start. An autopilot tick landing inside that window would find the
  // tree unoccupied by BOTH signals and merge it out from under a pane that had just opened. No-op
  // unless `cwd` is inside a worktree; see lib/worktree-claim.ts.
  touchClaim(cwd, key);
  // Claim the resumed id NOW, not when the SDK's `init` arrives with it. The `live:<id>` alias is what
  // sendMessage's two-writers guard consults, and init lands only after the ~1-2s cold start — so
  // registering it there left a window where a SECOND pane resuming the same conversation saw no owner,
  // passed the guard, and spawned a rival subprocess appending to the same JSONL. That is the precise
  // corruption the guard exists to prevent, and it was reachable by two blank panes continuing the same
  // chat within a second of each other. handleSystem re-sets this key on init (same session, same value
  // in the resume case), and teardown is identity-checked, so claiming early costs nothing.
  if (resume) store.set(SID_KEY + resume, s);
  // Adopt anyone who subscribed while this key had no session yet (see `waiting`), so the very first
  // events of the turn — init, the opening activity state — reach them.
  const early = waiting.get(key);
  if (early) { for (const sub of early) s.subs.add(sub); waiting.delete(key); }

  // Called by the SDK for any tool the user's config doesn't already auto-approve, AND for the
  // AskUserQuestion tool (Claude's clarifying question). We surface it and block until the user acts.
  const canUseTool = async (toolName: string, input: unknown): Promise<Decision> => {
    // Placement evidence, recorded before ANY decision branch — this hook is the one point every
    // tool call passes through regardless of mode (the server enforces bypass itself, so a bypass
    // session still lands here). Only edit-tool targets count; see `writePaths` on the type.
    if (EDIT_TOOLS.has(toolName) && s.writePaths.length < 200) {
      const p = (input as { file_path?: string; notebook_path?: string }) || {};
      const target = p.file_path || p.notebook_path;
      if (typeof target === "string" && target.startsWith("/")) s.writePaths.push(target);
    }
    // The mode is enforced HERE, not just handed to the SDK at spawn time. `setPermissionMode()` on a
    // running query is accepted and then silently ignored by the CLI — measured: flip a warm session to
    // bypassPermissions, it answers ok, and the very next Bash write still raises a prompt. Since this
    // hook IS the gate the CLI consults (a session *born* in bypass never calls it at all), deciding
    // here is what makes the composer's pills mean something on a session that's already running.
    // AskUserQuestion is exempt on purpose: it isn't a permission, it's Claude asking the human a
    // question, and auto-answering it would silently discard the question.
    //
    // `s.hold` short-circuits the auto-approve branches below. That ordering is the whole feature: on
    // this box the mode is `bypassPermissions`, so without the hold check the very next line returns
    // "allow" and there is no moment at which a reviewer could intervene. Checking the brake FIRST is
    // what turns a bypass session into a step-through one, and releasing it restores bypass exactly —
    // no permission state was rewritten to get here.
    if (toolName !== "AskUserQuestion" && !s.hold) {
      if (s.mode === "bypassPermissions") return { behavior: "allow", updatedInput: input as Record<string, unknown> };
      if (s.mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input as Record<string, unknown> };
    }
    const id = "perm-" + ++permCounter;
    // A held call is one the session would otherwise have run unattended, so it gets the auto-release
    // backstop (HOLD_TIMEOUT_MS) that an ordinary, deliberately-requested approval prompt does not.
    const held = toolName !== "AskUserQuestion" && s.hold;
    const expiresAt = held ? Date.now() + HOLD_TIMEOUT_MS : undefined;
    if (toolName === "AskUserQuestion") {
      broadcast(s, { t: "ask", id, questions: (input as { questions?: AgentQuestion[] })?.questions || [] });
    } else {
      broadcast(s, { t: "permission", id, toolName, input, held, expiresAt });
    }
    const p = new Promise<Decision>((resolve) => {
      const entry: Pending = { resolve, toolName, input, expiresAt };
      if (held) {
        entry.timer = setTimeout(() => {
          // Identity-checked: by now this id may have been resolved and the map entry replaced.
          if (s.pending.get(id) !== entry) return;
          s.pending.delete(id);
          resolve({ behavior: "deny", message: `Not reviewed within ${Math.round(HOLD_TIMEOUT_MS / 60000)} minutes — the step was held for human review and auto-denied. Ask before retrying it.` });
          broadcast(s, { t: "notice", kind: "denied", text: "a held step timed out waiting for review — auto-denied" });
          settle(s);
        }, HOLD_TIMEOUT_MS);
      }
      s.pending.set(id, entry);
    });
    // Claude is now blocked on a human, not working — say so, and name the tool it's waiting on.
    touch(s, "awaiting", toolName === "AskUserQuestion" ? "waiting on your answer" : `${held ? "held for review" : "waiting on approval"} · ${activityLabel(toolName, input)}`);
    return p;
  };

  s.q = query({
    prompt: inputGen(s),
    options: {
      cwd,
      // What the SDK is TOLD is not what this server enforces — see spawnMode() for why handing it the
      // real mode makes both the composer's pills and the Flow view's brake unenforceable.
      permissionMode: spawnMode(mode),
      canUseTool,
      includePartialMessages: true, // stream assistant text token-by-token
      // Ask for the reasoning summary. Without this the API defaults to display "omitted", which
      // still emits thinking blocks but with an EMPTY text field — so the pane had no way to show
      // that Claude was working during a long think. "summarized" is the only readable mode; the
      // raw chain of thought is never returned on current models.
      thinking: { type: "adaptive", display: "summarized" },
      settingSources: ["user", "project", "local"], // mirror the user's own CLAUDE.md / permissions / MCP
      model: model || DEFAULT_MODEL,
      // Only set effort if explicitly pinned via env — omitting it lets the SDK/model default apply
      // (see the DEFAULT_EFFORT comment above; "default effort" was the explicit ask, not "high").
      ...(DEFAULT_EFFORT ? { effort: DEFAULT_EFFORT } : {}),
      // env is otherwise inherited from process.env by default (per the SDK's own doc comment) —
      // spread it explicitly so this override adds to, rather than replaces, everything the
      // subprocess already needs (PATH, HOME, ANTHROPIC_API_KEY, token-slayer's active credential).
      env: { ...process.env, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: AUTOCOMPACT_PCT },
      // The append is unconditional now (the preview contract applies to every session); only the
      // browser nudge stays tied to the browser tool actually being registered, and only the fan-out
      // instruction to the pill. mcpServers rides separately — it was only ever bundled with
      // systemPrompt because both were born in the same MCP_SERVERS spread.
      systemPrompt: {
        type: "preset", preset: "claude_code",
        append: [PREVIEW_PROMPT, ...(s.fanout ? [FANOUT_PROMPT] : []), ...(MCP_SERVERS ? [BROWSER_PROMPT] : [])].join("\n\n"),
      },
      ...(MCP_SERVERS ? { mcpServers: MCP_SERVERS } : {}),
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
      denyAllPending(s, "Session ended.");
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
    case "command_lifecycle":
      handleCommandLifecycle(s, m);
      break;
    case "stream_event": {
      const ev = m.event;
      if (!s.toolBufs) s.toolBufs = new Map(); // guard sessions created before this field existed (hot-reload)
      // Each new assistant message means the previous one is now flushed to the JSONL, so the live
      // "partial" (used to reconstruct the in-flight message for a reconnecting client) resets.
      if (ev?.type === "message_start") { s.partial = ""; s.partialThinking = ""; }
      // Reasoning tokens. These arrive before (and between) text blocks, so they double as the
      // "Claude is still working" signal during a long think where no text has been emitted yet.
      // A second thinking block is a second *pass* — Claude reasoning again after a tool result came
      // back. The deltas carry no seam, so the client would glue "I'll check X" onto "so X was wrong"
      // as one paragraph; mark it the way text blocks are marked and let the pane draw the divider.
      // Gated on sawThinking (set by the deltas, not the block) because some setups open thinking
      // blocks with an empty body — see the `thinking` option below — and an empty pass must not
      // earn a divider. A trailing seam with nothing after it is dropped client-side.
      if (ev?.type === "content_block_start" && ev.content_block?.type === "thinking") {
        if (s.sawThinking) {
          if (s.partialThinking) s.partialThinking += "\n---\n"; // ...unless it'd lead the snapshot
          broadcast(s, { t: "thinking", text: "\n---\n" });
        }
        touch(s, "thinking");
      }
      if (ev?.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
        s.partialThinking += ev.delta.thinking;
        s.sawThinking = true;
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
    case "result": {
      s.partial = "";
      s.partialThinking = "";
      if (Array.isArray(m.permission_denials) && m.permission_denials.length) {
        broadcast(s, { t: "notice", kind: "denied", text: `${m.permission_denials.length} tool call${m.permission_denials.length === 1 ? "" : "s"} denied` });
      }
      // The turn is over either way, so the transcript reconciles now — but this is NOT necessarily the
      // end of the session's work: a queued follow-up starts within ~2ms. Keeping `busy` true across
      // that gap is what stops Stop→Send→Stop flickering on every queued message, and it's the honest
      // state (something IS about to run). `command_lifecycle: started` takes it from here.
      const handover = s.queued.length > 0;
      broadcast(s, { t: "result", subtype: m.subtype, costUsd: m.total_cost_usd ?? m.cost_usd });
      if (handover) {
        // Phase, not idle: the pane should read as still working, because it is.
        resetActivity(s, "thinking");
        broadcast(s, { t: "activity", activity: activityOf(s) });
        holdForQueue(s);
        break;
      }
      s.busy = false;
      // A denied tool never produces a tool_result, so anything still open at the end of the turn is
      // finished by definition — clear it rather than let it leak into the next turn's label. Tasks
      // are the exception (see resetActivity): survivors are background agents still working, and
      // the phase says so — `tool`, not `idle`, keeps the status line honest about a fleet in
      // flight. Their eventual task_notification settles the session to true idle.
      resetActivity(s, s.liveTasks.size ? "tool" : "idle", { keepTasks: true });
      broadcast(s, { t: "activity", activity: activityOf(s) });
      broadcast(s, { t: "busy", busy: false });
      scheduleIdle(s);
      // The one moment a chat can change folders: the turn is over, nothing is queued, nothing is
      // parked. Fire-and-forget — the pass re-checks those guards after its own awaits.
      void placementPass(s).catch(() => { /* placement is an optimisation, never a failure */ });
      break;
    }
  }
}

// The CLI's own queue, mirrored. `command_lifecycle` is an UNTYPED passthrough from the claude binary —
// it appears in neither the SDK's typings nor its bundle — so it's feature-detected off the
// `msg_lifecycle_v1` capability on system/init rather than assumed. Shape, confirmed by probing a live
// session (docs/KNOWLEDGE.md §5g):
//
//   { type: "command_lifecycle", command_uuid: <the uuid WE stamped>, state: "queued" | "started"
//     | "completed" | "cancelled", uuid: <event id>, session_id }
//
// `command_uuid` echoing our own stamp is the whole reason this feature can be honest: without it the
// only way to know a queued message had begun would be to infer it from turn boundaries, and batch
// coalescing (the CLI may merge several queued messages into ONE turn) makes that inference wrong.
function handleCommandLifecycle(s: Session, m: any) {
  const id = m?.command_uuid;
  if (!id) return;
  const i = s.queued.findIndex((q) => q.uuid === id);

  // `started` is the real turn boundary for a queued message — the point sendMessage deliberately did
  // NOT do its turn-start bookkeeping, because back then this message was a follow-up to a turn that
  // still owned the streaming buffers. Do it now.
  if (m.state === "started") {
    if (s.queueTimer) { clearTimeout(s.queueTimer); s.queueTimer = null; }
    // Every message flows through this channel, including the one that started its turn immediately —
    // so only treat it as a queued handover if we were actually tracking it as queued.
    if (i === -1) return;
    // Read the text BEFORE the splice — this is the last moment the server holds it. The pane needs it
    // to write the message into the transcript; after this it exists only on disk, and it does not get
    // there until this turn ends.
    const started = s.queued[i];
    s.queued.splice(i, 1);
    s.busy = true;
    s.sawText = false;
    s.sawThinking = false;
    s.partial = "";
    s.partialThinking = "";
    resetActivity(s, "thinking");
    broadcast(s, { t: "started", uuid: started.uuid, text: started.text });
    broadcast(s, { t: "queued", queued: s.queued.map((q) => ({ uuid: q.uuid, text: q.text })) });
    broadcast(s, { t: "busy", busy: true });
    broadcast(s, { t: "activity", activity: activityOf(s) });
    return;
  }

  // `cancelled` can arrive for a message we never see run (an interrupt with cancel_queued, or the CLI
  // dropping it). `completed` for a queued id we still hold means its turn ran without us seeing
  // `started` — coalesced into another message's turn — so drop it either way rather than leaving a
  // phantom entry in the tray forever.
  if ((m.state === "cancelled" || m.state === "completed") && i !== -1) {
    s.queued.splice(i, 1);
    broadcast(s, { t: "queued", queued: s.queued.map((q) => ({ uuid: q.uuid, text: q.text })) });
    if (!s.queued.length && !s.busy) settleQueueGap(s);
  }
}

// Called when a turn ends with messages still queued. The CLI starts the next one within a couple of
// milliseconds, so going idle here and back to busy on `started` would flicker Stop→Send→Stop on every
// queued message. Hold busy instead — but arm a backstop, because if `started` never comes there is no
// result left to arrive and clear it.
const QUEUE_HANDOVER_MS = 20_000;
function holdForQueue(s: Session) {
  if (s.queueTimer) clearTimeout(s.queueTimer);
  s.queueTimer = setTimeout(() => {
    s.queueTimer = null;
    if (!s.queued.length) return; // the handover happened after all
    // The queue never started. Report it rather than sitting on a lie: the messages are gone as far as
    // we can tell, and the pane needs to be usable again.
    s.queued = [];
    broadcast(s, { t: "queued", queued: [] });
    broadcast(s, { t: "notice", kind: "aborted", text: "a queued message never started — it may have been dropped" });
    settleQueueGap(s);
  }, QUEUE_HANDOVER_MS);
}

// Land the session in a clean idle state after a queue handover failed or emptied out.
function settleQueueGap(s: Session) {
  s.busy = false;
  resetActivity(s, "idle");
  broadcast(s, { t: "activity", activity: activityOf(s) });
  broadcast(s, { t: "busy", busy: false });
  scheduleIdle(s);
}

// System messages carry the signals that otherwise make a busy pane look dead: a retry backing off
// for 30s, an auto-compaction, and subagent progress.
function handleSystem(s: Session, m: any) {
  switch (m.subtype) {
    case "init":
      if (m.session_id) {
        // Drop the alias we claimed at spawn time if the SDK came back with a DIFFERENT id than the one
        // we resumed. With `forkSession` unset that shouldn't happen (resume continues the same id), but
        // a stale alias is not a harmless leak: teardown only ever deletes the FINAL sessionId, so the
        // orphan would outlive the session and make the two-writers guard reject that conversation as
        // "already open" forever. Identity-checked so it can't delete a newer session's claim.
        if (s.sessionId && s.sessionId !== m.session_id && store.get(SID_KEY + s.sessionId) === s) {
          store.delete(SID_KEY + s.sessionId);
        }
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
        since: Date.now(),
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
export function sendMessage(opts: { key: string; cwd: string; message: string; mode?: string; resume?: string; hold?: boolean; model?: string; fanout?: boolean; images?: { type: "image"; source: { type: "base64"; media_type: string; data: string } }[] }): { sessionId: string | null } {
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
  if (opts.resume && cold) {
    const owner = store.get(SID_KEY + opts.resume);
    if (owner && !owner.closed && owner.key !== opts.key) {
      throw new Error("That conversation is already open and running in another pane.");
    }
  }
  // An absent mode means "whatever this install defaults to"; an explicit one always wins.
  const wanted = opts.mode === undefined ? DEFAULT_PERMISSION_MODE : safeMode(opts.mode);
  const s = ensureSession(opts.key, opts.cwd, wanted, opts.resume, opts.model, opts.fanout);
  // Refresh the heartbeat every turn, not only at creation. A pane can sit warm for hours between
  // messages, and a claim whose age is measured from `claimedAt` would expire under an owner who is
  // demonstrably still there. `ensureSession` above already staked it on the cold path; this is the
  // warm one. Cheap: one small write per turn, and a no-op outside a worktree.
  touchClaim(opts.cwd, opts.key);
  // ensureSession only applies `mode` when it CREATES the session, so a warm one would otherwise keep
  // whatever it was born with forever. Re-applying per turn means the composer's pill is authoritative
  // even if the change-mode request never happened (a pane that reloaded, a dropped fetch).
  if (!cold && s.mode !== wanted) setMode(opts.key, wanted);
  // The brake rides in with the message rather than being POSTed separately, and that's a race fix,
  // not a convenience: arming it on a pane with no live session yet has nothing to arm, and arming it
  // straight after the send loses to the SSE `snapshot` (which carries the session's real hold — still
  // false — and would immediately switch it back off). Applied here, it is true before the session's
  // first tool call can possibly reach the gate.
  if (opts.hold !== undefined && s.hold !== !!opts.hold) { s.hold = !!opts.hold; broadcast(s, { t: "hold", hold: s.hold }); }
  // Content stays a bare STRING when there are no images. That is not just tidiness: a string is what
  // every existing transcript line holds, and `claude-sessions.ts` reads user turns by pulling text
  // blocks out of whatever shape it finds — so keeping the common case identical means the parser, the
  // caches and the on-disk history are untouched by this feature until an image is actually present.
  //
  // Image FIRST, then the text. Claude attends to a question asked after the evidence more reliably
  // than before it, and this is the order the API's own vision guidance recommends.
  const content = opts.images?.length
    ? [...opts.images, { type: "text" as const, text: opts.message }]
    : opts.message;
  // Stamp a uuid on every message, not just queued ones. It's what `command_lifecycle` echoes back as
  // `command_uuid`, so it is the only handle we get on a message once it's down the pipe — and stamping
  // uniformly means the queued and unqueued paths are observable the same way. It's also what
  // interrupt()'s `still_queued` receipt lists, so Stop can name what it left running.
  const uuid = randomUUID();
  s.queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid });

  // ── Queueing path ─────────────────────────────────────────────────────────────────────────────────
  // A turn is already in flight, so this message is a follow-up the CLI will run after it. Everything
  // below this block is TURN-START bookkeeping and must not run: resetting `partial`/`sawText` would
  // truncate the reply currently streaming (it's the buffer a reconnecting pane replays from), and
  // resetActivity() would wipe liveTools mid-turn so the activity line would narrate the wrong work.
  // The real turn-start reset for this message happens when the CLI says `started`.
  if (s.busy) {
    s.queued.push({ uuid, text: opts.message, at: Date.now() });
    if (s.waiter) { const w = s.waiter; s.waiter = null; w(); }
    broadcast(s, { t: "queued", queued: s.queued.map((q) => ({ uuid: q.uuid, text: q.text })) });
    return { sessionId: s.sessionId };
  }

  s.busy = true;
  s.sawText = false; // fresh turn: the next text block opens the reply, no leading separator
  s.sawThinking = false; // ...and the first thinking pass opens the reasoning, no leading seam
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
  if (p.timer) clearTimeout(p.timer); // a held call's auto-release backstop — the human beat it here
  s.pending.delete(id);
  if (decision === "allow") p.resolve({ behavior: "allow", updatedInput: p.input });
  // `message` is what makes steering work: a denial reason is handed straight back to Claude as the
  // tool result, so a correction typed on a node lands INSIDE the same turn with its context intact,
  // rather than as a follow-up message after the bad step already ran.
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
  if (p.timer) clearTimeout(p.timer);
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
  //
  // Deliberately the BARE interrupt(), never `cancel_queued: true`: Stop here means "abandon what's
  // running and move on to what I just told you", which is how a change of mind actually works — you
  // queue the correction, then stop the work it corrects. The SDK guarantees that shape: with
  // cancel_queued absent, "queued commands survive the interrupt", and the CLI's drain loop starts the
  // next queued turn immediately (measured: ~2ms after the interrupted turn's result).
  const receipt = await Promise.race([
    // Promise.resolve(...) wraps the case where interrupt itself is missing (undefined) so `.catch` is
    // always safe to call — `s.q?.interrupt?.()` alone would be `undefined.catch(...)` in that case.
    Promise.resolve(s.q?.interrupt?.()).catch(() => { /* best effort — the turn may already be finishing */ }),
    new Promise((resolve) => setTimeout(resolve, 8000)),
  ]) as { still_queued?: string[] } | undefined;
  // Say what Stop did NOT stop. Silence here is the bad outcome: the user hits Stop, the pane keeps
  // animating because a queued follow-up took over, and that reads as "Stop is broken" rather than
  // "Stop worked and your correction is running now". Counted against OUR list, not the receipt's, since
  // the receipt can also list ids we never sent (cron triggers, auto-resume continuations).
  const surviving = (receipt?.still_queued || []).filter((id) => s.queued.some((q) => q.uuid === id)).length
    || (receipt ? 0 : s.queued.length); // older CLIs send no receipt — fall back to what we're tracking
  if (surviving > 0) {
    broadcast(s, { t: "notice", kind: "aborted", text: `stopped — running your ${surviving === 1 ? "queued message" : `${surviving} queued messages`} next` });
  }
  for (const [id, p] of toDeny) {
    if (s.pending.get(id) === p) { if (p.timer) clearTimeout(p.timer); p.resolve({ behavior: "deny", message: "Stopped by user." }); s.pending.delete(id); }
  }
  // Aborting is also the end of supervising this turn — leaving the brake on would silently park the
  // first tool call of whatever the user sends next, which reads as "my next message hung".
  if (s.hold) { s.hold = false; broadcast(s, { t: "hold", hold: false }); }
  return true;
}

/** The Flow view's brake. Returns whether a live session actually took it, so the client's toggle can
 *  revert rather than claim a hold that no session is honouring — same contract as setMode(). */
export function setHold(key: string, hold: boolean): boolean {
  const s = store.get(key);
  if (!s || s.closed) return false;
  s.hold = !!hold;
  broadcast(s, { t: "hold", hold: s.hold });
  // Releasing does NOT retroactively approve what's already parked. A call sitting at the gate was
  // stopped so a human could look at it, and "resume the session" is a different decision from "run
  // this specific step" — the reviewer still answers it explicitly (allow, or deny with a reason).
  return true;
}

/** Returns whether a live session actually took the change — the route reports this verbatim, so the
 *  composer's pill can revert instead of lighting up over a no-op. */
export function setMode(key: string, mode?: string): boolean {
  try {
    const s = store.get(key);
    if (!s || s.closed) return false;
    s.mode = safeMode(mode); // the copy canUseTool reads — this is the one that actually decides
    // Tell the SDK the SPAWN mode, not the real one. Handing it `bypassPermissions` mid-session would
    // stop it consulting canUseTool at all (see spawnMode), silently disarming both our own enforcement
    // and the Flow brake — the exact failure this indirection exists to prevent.
    const p = s.q?.setPermissionMode?.(spawnMode(safeMode(mode)));
    // setPermissionMode() returns a promise; this call is intentionally fire-and-forget (the route
    // just wants the mode applied, not to block on it), but an un-awaited promise that later rejects
    // (e.g. the mode toggle is flipped right as the session ends) becomes an UNHANDLED REJECTION with
    // nowhere to be caught — and with no global handler, Node's default is to crash the whole process,
    // killing every open pane over one stale mode change. Attaching a no-op .catch() here keeps it
    // fire-and-forget while ensuring it can never do that.
    if (p && typeof (p as Promise<unknown>).then === "function") (p as Promise<unknown>).catch(() => { /* session likely gone — nothing to do */ });
    return true;
  } catch { return false; /* not initialized yet */ }
}

/**
 * Point this pane at a different model.
 *
 * **There is no such thing as changing a warm session's model.** The SDK builds `query()` around the
 * model at creation and there is no control message to move it — the same shape of trap as
 * `setPermissionMode()` (see canUseTool: the CLI *accepts* that call on a running query and then
 * ignores it). A picker that POSTed a change and lit up green would be reporting a swap that never
 * happened, and every subsequent turn would bill and behave as the old model with the UI insisting
 * otherwise. So the only honest implementations are "refuse while live" or "respawn", and refusing
 * makes the control useless in the case you actually want it — three turns into a conversation.
 *
 * Respawn it is: close the SDK subprocess and let the next send start a new one with `resume` set to
 * this conversation's id. Context survives because it survives *on disk* — the CLI replays the JSONL,
 * which is the same mechanism a pane reattaching after a server restart already relies on. What does
 * NOT survive is anything that only existed inside the old process: a queued follow-up, a parked
 * permission prompt (closeSession denies those), and the KV cache, so the first turn after a swap is a
 * cold read of the transcript and costs accordingly.
 *
 * Refused mid-turn on purpose. Killing a subprocess that is streaming a reply loses the tail of that
 * reply (it is only in `s.partial` until the turn's `result` lands) and orphans any tool call already
 * running — the caller is told to stop the turn first rather than being silently half-obeyed.
 *
 * Returns `respawned` so the client knows to re-arm `resume` on its next send. A pane with no live
 * session is the easy case and reports `ok` with no respawn: nothing exists yet to be born with the
 * wrong model, and the choice simply rides in with the first message.
 */
export function setModel(key: string, model?: string): { ok: boolean; respawned?: boolean; reason?: string } {
  const s = store.get(key);
  if (!s || s.closed) return { ok: true };
  if (s.busy) return { ok: false, reason: "a turn is in flight — stop it before switching model" };
  // Compare resolved ids, not raw args: `undefined` means "the box pin", so undefined→DEFAULT_MODEL is
  // a no-op and must not tear down a perfectly good session.
  if (s.model === (model || DEFAULT_MODEL)) return { ok: true };

  // No `notice` broadcast here, deliberately. NoticeStrip only renders while a pane is busy, and a swap
  // is REFUSED while busy — so a notice sent from this path is unreachable at the moment it means
  // something and would surface a turn late, attached to the next reply, reading as if it had just
  // happened. The composer derives the same fact from state that cannot go stale: until the next send,
  // the pane's picked model and the session's reported one disagree, and that disagreement IS
  // "staged, not yet applied". See ModelPicker in app/page.tsx.

  // Carry the live SSE subscribers across the respawn. closeSession() drops the Session object whose
  // `subs` set they live in, and ensureSession() starts a fresh one that only adopts from `waiting` —
  // so without this handover every pane watching this key goes silent until it is reloaded, which
  // looks exactly like the swap having hung. `waiting` is precisely the parking lot for subscribers
  // that exist before their session does, which is what these become for the next few hundred ms.
  const orphans = new Set(s.subs);
  closeSession(key);
  if (orphans.size) {
    const set = waiting.get(key) || new Set<Sub>();
    for (const sub of orphans) set.add(sub);
    waiting.set(key, set);
  }
  return { ok: true, respawned: true };
}

// The fan-out half of setModel's contract, and the same mechanics for the same reason: the fan-out
// instruction is a system-prompt append, fixed at query() creation, so a warm session's can't be
// edited — only replaced. Teardown here, and the pane's next send resumes the conversation from disk
// with (or without) the instruction. `respawned` tells the client to re-arm `resume`, exactly as for
// a model swap.
export function setFanout(key: string, fanout: boolean): { ok: boolean; respawned?: boolean; reason?: string } {
  const s = store.get(key);
  if (!s || s.closed) return { ok: true }; // no live session — the flag just applies at the next send
  if (s.busy) return { ok: false, reason: "a turn is in flight — stop it before switching fan-out" };
  if (s.fanout === fanout) return { ok: true };
  // Same subscriber handover as setModel — see the comment there for why `waiting` is the parking lot.
  const orphans = new Set(s.subs);
  closeSession(key);
  if (orphans.size) {
    const set = waiting.get(key) || new Set<Sub>();
    for (const sub of orphans) set.add(sub);
    waiting.set(key, set);
  }
  return { ok: true, respawned: true };
}

// ── the placement pass ─────────────────────────────────────────────────────────────────────────
// Runs at the end of an idle turn and answers one question: is this chat living in the right
// folder? Two wrong answers it can fix, both born from the same habit (chats START in the vault
// because the context lives there, but the WORK often lives elsewhere):
//
//   · The chat's writes concentrate in another repo → relocate it there. The vault stays readable
//     from anywhere (global context, absolute paths), the target repo's own CLAUDE.md/skills load,
//     and the board re-tiles the chat under the project it actually belongs to.
//   · The chat wrote its (lazy-mode) home repo while another chat shares it → NOW it earns the
//     worktree that lazy mode declined at birth.
//
// Both act through relocate(): the same teardown-and-resume every other "can't change a warm
// session" feature uses — move the transcript, tell the panes, close; the next send resumes from
// disk in the new home. Guarded to idle moments only: no in-flight turn, no parked prompt, no
// queued follow-up. Scoped to lazy-mode repos on purpose — in an eager repo (code), a chat editing
// a second repo is usually a deliberate cross-repo fix, and yanking it away would be automation
// fighting intent. The vault declared itself context-first; that declaration is the licence.

/** Nearest enclosing git checkout of a path, walking up to the first `.git`. Cached per directory —
 *  the pass runs over ≤200 paths that mostly share a few parents. */
const repoRootCache = new Map<string, string | null>();
function repoRootOf(p: string): string | null {
  let d = p;
  const seen: string[] = [];
  for (let i = 0; i < 24; i++) {
    const hit = repoRootCache.get(d);
    if (hit !== undefined) { for (const x of seen) repoRootCache.set(x, hit); return hit; }
    seen.push(d);
    try { if (fsSync.existsSync(pathMod.join(d, ".git"))) { for (const x of seen) repoRootCache.set(x, d); return d; } } catch { /* unreadable — keep walking */ }
    const up = pathMod.dirname(d);
    if (up === d) break;
    d = up;
  }
  for (const x of seen) repoRootCache.set(x, null);
  return null;
}

const real = (p: string) => { try { return fsSync.realpathSync(p); } catch { return p; } };

/** Another live session whose cwd is this same checkout — the contention that makes a home write
 *  worth isolating. Keyed sessions only (skip the `live:` aliases, which would double-count). */
function contendedHome(s: Session, home: string): boolean {
  const h = real(home);
  for (const [k, o] of store) {
    if (o === s || o.closed || k !== o.key) continue;
    if (real(o.cwd) === h) return true;
  }
  return false;
}

/** Tear the session down and point the conversation at a new folder. The transcript moves FIRST —
 *  it is what makes the next `resume` find the chat in its new home; a teardown before a failed
 *  move would strand the conversation exactly like a recycled worktree used to. */
function relocate(s: Session, newCwd: string, text: string) {
  if (!s.sessionId) return;
  if (!moveTranscriptHome(s.sessionId, s.cwd, newCwd)) return;
  // Broadcast BEFORE closing: closeSession drops the Session whose `subs` these live in. The pane
  // uses this to adopt the new cwd and re-arm `resume` — and to say what happened, because a chat
  // that silently changes folders reads as a bug, not a feature.
  broadcast(s, { t: "relocated", cwd: newCwd, text });
  const orphans = new Set(s.subs);
  closeSession(s.key);
  if (orphans.size) {
    const set = waiting.get(s.key) || new Set<Sub>();
    for (const sub of orphans) set.add(sub);
    waiting.set(s.key, set);
  }
}

async function placementPass(s: Session): Promise<void> {
  if (s.closed || s.busy || s.pending.size || s.queued.length || s.hold || !s.sessionId) return;
  if (!s.writePaths.length) return;
  if (worktreeOf(s.cwd)) return; // already isolated — its placement is settled
  const home = repoRootOf(s.cwd);
  if (!home) return;
  if ((await isolateMode(home)) !== "lazy") return;
  if (s.closed || s.busy) return; // the await above raced a new turn — stand down

  const counts = new Map<string, number>();
  for (const p of s.writePaths) {
    const r = repoRootOf(p);
    if (r) counts.set(real(r), (counts.get(real(r)) || 0) + 1);
  }
  const homeReal = real(home);
  let away: { root: string; n: number } | null = null;
  for (const [root, n] of counts) {
    if (root !== homeReal && (!away || n > away.n)) away = { root, n };
  }
  // Two writes into one other repo is a pattern; one could be a stray drop. Vault writes don't
  // veto the move (Thomas: the target repo owns an interleaved chat — capture works from anywhere).
  if (away && away.n >= 2) {
    relocate(s, away.root, `moved to ${away.root.replace(/^\/Users\/[^/]+/, "~")} — that's where this chat's work is`);
    return;
  }
  if ((counts.get(homeReal) || 0) >= 1 && contendedHome(s, home)) {
    try {
      const iso = await isolate(s.cwd, "chat", "turn");
      if (!iso || s.closed || s.busy) return;
      relocate(s, iso.dir, `isolated into ${iso.name} — this chat writes here and another chat is present`);
    } catch { /* isolation is an optimisation; the shared folder still works */ }
  }
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
  // `model` rides the replay too, or a pane that reattached (refresh, server restart) would show
  // "default" for a session it can see is running — the SDK's own init only fires once, at spawn.
  if (s.sessionId) replay.push({ t: "init", sessionId: s.sessionId, model: s.model });
  // `activity` rides along so a client that refreshed mid-tool-call resumes with the real label and a
  // correctly-offset elapsed clock, instead of falling back to a generic "working…".
  replay.push({ t: "snapshot", busy: s.busy, partial: s.partial, partialThinking: s.partialThinking, activity: activityOf(s), hold: s.hold, queued: s.queued.map((q) => ({ uuid: q.uuid, text: q.text })) });
  for (const [id, p] of s.pending) {
    if (p.toolName === "AskUserQuestion") replay.push({ t: "ask", id, questions: (p.input as { questions?: AgentQuestion[] })?.questions || [] });
    // `expiresAt` is an absolute timestamp, not a remaining duration, precisely so a client that
    // reconnects halfway through a hold shows the real countdown instead of restarting it at 10:00.
    else replay.push({ t: "permission", id, toolName: p.toolName, input: p.input, held: !!p.timer, expiresAt: p.expiresAt });
  }
  return {
    replay,
    unsubscribe: () => { s.subs.delete(sub); if (s.subs.size === 0) scheduleIdle(s); },
    exists: true,
  };
}

// A snapshot of every live session's current activity, keyed by Claude sessionId — polled by the grid
// so each running Bento tile can show what it's doing (thinking / reading X / running: …).
/** Is a specific pane key mid-turn? The autopilot's conflict resolver needs to know when its own
 *  session has stopped, and `liveActivity()` is keyed by sessionId — which the caller doesn't have,
 *  and which several sessions in the same cwd would make ambiguous anyway. */
export function isBusy(key: string): boolean {
  const s = store.get(key);
  return !!s && !s.closed && s.busy;
}

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
  denyAllPending(s, "Session closed.");
  if (s.waiter) { const w = s.waiter; s.waiter = null; w(); }
  // close() may return a promise; guard against a later rejection going unhandled (harmless today since
  // instrumentation.ts's global handler catches it, but this keeps the same fire-and-forget-safely
  // pattern used by setMode() above instead of relying on that as the only backstop).
  try { Promise.resolve(s.q?.close?.()).catch(() => { /* already gone */ }); } catch { /* already gone */ }
  if (s.idleTimer) clearTimeout(s.idleTimer);
  // The queue dies with the subprocess that held it — a queued message only ever existed inside that
  // CLI's queue, so leaving the mirror populated would let a reattaching pane render follow-ups that
  // nothing is going to run. Drop the handover backstop with it.
  if (s.queueTimer) { clearTimeout(s.queueTimer); s.queueTimer = null; }
  if (s.queued.length) { s.queued = []; broadcast(s, { t: "queued", queued: [] }); }
  // Hand the worktree back. Only clears the file once no owner is left, so closing one of two panes
  // on the same tree doesn't unprotect it for the other. A crash never reaches this line, which is
  // what CLAIM_TTL_MS is for — the release is the fast path, the heartbeat expiry is the guarantee.
  releaseClaim(s.cwd, key);
  // Remove BOTH the pane-key entry and the sessionId alias so neither leaks a closed session.
  store.delete(key);
  store.delete(s.key);
  if (s.sessionId) store.delete(SID_KEY + s.sessionId);
}
