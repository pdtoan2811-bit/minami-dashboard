// Folds a transcript into the step graph the Flow view draws.
//
// Same shape of thing as lib/browser-view.ts: a pure derivation over the turns the pane already has,
// not a second event pipeline. The transcript IS the server's stream (or the JSONL it reconciles to),
// so a view built from it cannot disagree with what actually ran — which a parallel client-side
// activity model very much could.
//
// The unit is a plan item, because that's the unit a human reviews: "did it do the right thing for
// this step", not "was that particular Read correct". Tool calls hang underneath the step that was in
// progress when they ran.
//
// TWO plan tools exist and both are live, so both are read here. Measured on this box: given an
// explicit "track this with TodoWrite" instruction, Claude reached for TaskCreate/TaskUpdate anyway —
// so supporting only one of them means the graph silently degrades to the tool-call fallback for
// whole categories of turn, which looks like "the feature doesn't work" rather than "wrong tool".
//
//   TodoWrite  — REPLACE semantics: every call carries the whole list. No stable ids, so identity has
//                to be reconstructed (see reconcileKeys), which is the fiddly path.
//   TaskCreate — incremental, and it hands back a REAL id ("Task #3 created successfully: …") that
//   /TaskUpdate  TaskUpdate then addresses by `taskId`. Where this is available it is strictly better:
//                the id IS the node key, so no heuristic can mis-match a reworded step.
import { activityLabel, type ToolOutput } from "./agent/labels";
import { stackOf } from "./flow-stack";

/** How many of a milestone's newest tool calls the canvas previews on the node itself. Three is a
 *  budget, not a preference: this is the same surface v3 drowned in by drawing EVERY call, so the
 *  preview has to stay small enough that the node is still an account of the work and not a log. */
export const RECENT_CALLS = 3;

export type FlowStatus = "pending" | "in_progress" | "completed";

export type FlowTool = { id?: string; name: string; input: unknown; done?: boolean; ok?: boolean; ms?: number; output?: ToolOutput };

/** What a group of tool calls MEANT, which is the unit the flow view draws.
 *
 *  Tool names are the wrong vocabulary for review: "Read, Read, Grep, Read, Bash, Edit, Bash" is seven
 *  boxes that say nothing, and reading it back is the work the view was supposed to save. These nine
 *  kinds are the answer to "what was it doing", and every tool on the box maps into one — including MCP
 *  tools, which arrive as `mcp__<server>__<verb>` and would otherwise each read as a novel noun. */
export type ActKind = "read" | "searched" | "changed" | "ran" | "verified" | "delegated" | "browsed" | "asked" | "other";

export type Act = { kind: ActKind; n: number; label: string; ok: boolean | null };

/** A command whose result is a VERDICT, not just output — a build, a test run, a commit, a deploy.
 *  Surfaced separately from ordinary `ran` because "did the thing it claims to have done actually
 *  work" is the question a completed step is being asked, and a green tick you can trace to a real
 *  exit code is a different claim from Claude writing "done". */
export type Check = { label: string; ok: boolean | null; verify: boolean };

export type FlowStep = {
  /** Stable across TodoWrite rewrites — see reconcileKeys. React Flow keys nodes on this, so churn
   *  here is visible as nodes re-mounting and re-animating on every plan update. */
  key: string;
  title: string;
  /** TaskCreate's `description` — the longer form, when it says more than the subject. TodoWrite has
   *  no equivalent, so this is simply absent on that path. */
  detail?: string;
  status: FlowStatus;
  /** True when this step was synthesized from tool calls rather than read off a plan — either the
   *  pre-plan preamble, or a whole turn that never called TodoWrite. Drawn differently, because
   *  "Claude decided this was a step" and "we grouped some tools for you" are different claims. */
  synthetic?: boolean;
  tools: FlowTool[];
  thinking: string;
  text: string;
  /** Edit/Write targets — the thing you most need to review, surfaced without opening every tool. */
  files: string[];
  agents: { agent: string; description: string }[];
  /** Derived, not stored: what this step's tool calls amount to. Filled by `summarize()` once the
   *  step is complete, so nothing here can disagree with `tools` — it IS `tools`, read semantically. */
  acts: Act[];
  checks: Check[];
  /** One sentence, from rules alone. The model-written version lands beside it as a `Narrative` and
   *  never overwrites this one, so a step always has something to say even with narration off. */
  headline: string;
  /** Wall-clock span of the assistant turns attributed to this step, and their USD. Both are absent
   *  (0) on a transcript parsed before `Turn.cost` existed — see the note on that field. */
  t0: number;
  t1: number;
  cost: number;
};

export type FlowTurn = {
  index: number;
  request: string;
  steps: FlowStep[];
  /** Every non-plan tool call of this turn in the order it RAN, which `steps` cannot give you: a step
   *  the plan returns to later collects calls from two different moments, so flattening the steps
   *  yields plan order, not time order. "The latest 3 calls" is a claim about time, so it reads this. */
  tools: FlowTool[];
  /** Whether a real plan drove this turn. The empty-plan fallback is honest about being a fallback. */
  planned: boolean;
  streaming?: boolean;
  /** Turn-level totals, summed from the source rows rather than from `steps` — a step's share is an
   *  attribution, and attributions don't have to add up to the truth. These do. */
  t0: number;
  t1: number;
  cost: number;
  /** Byte offset of the user row that opened this turn. Immutable (transcripts are append-only), so
   *  it is the one identity that survives re-polling, paging back, and the server folding the same
   *  session independently for narration. Falls back to the array index when absent (a live pane's
   *  in-memory turns have no offset yet). */
  off?: number;
};

type SourceTurn = {
  role: "user" | "assistant"; text: string; tools: FlowTool[]; streaming?: boolean; thinking?: string;
  ts?: number; cost?: number; off?: number;
};
type TodoItemish = { content?: unknown; status?: unknown; activeForm?: unknown };

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// The calls that WRITE the plan. They become the graph's structure, so they must not also appear as
// work inside it — otherwise every step contains a tool call whose only job was to announce the step.
// TaskList/TaskGet only READ the plan, so they stay ordinary tool calls.
const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const slug = (s: string) => norm(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "step";

/** Carry keys across a TodoWrite rewrite.
 *
 *  TodoWrite is REPLACE-semantics: every call ships the WHOLE list, not a delta, and Claude freely
 *  rewords an item between calls ("add the gate" → "add the canUseTool gate"). Keying nodes on array
 *  index churns whenever the list grows; keying on content churns whenever it's reworded. Either way
 *  the graph re-mounts mid-review and the node you were reading jumps.
 *
 *  So: match on normalized content first (survives reordering and insertion), fall back to position
 *  (survives rewording), and only then mint a new key. Each previous key is claimed at most once, so
 *  two steps can never collapse onto one node. */
function reconcileKeys(prev: { key?: string; content: string }[], next: string[]): string[] {
  const used = new Set<string>();
  const byContent = new Map<string, string>();
  // `prev` keeps its POSITIONS (holes and all) — compacting it to drop keyless entries would shift
  // every later item left and silently hand its key to its neighbour, which is the exact mis-match
  // this function exists to prevent.
  for (const p of prev) if (p.key && !byContent.has(norm(p.content))) byContent.set(norm(p.content), p.key);

  const out: string[] = new Array(next.length);
  // Content matches first, across the whole list — a positional pass would otherwise claim the key of
  // an item that is still present further down, and then that item would mint a fresh one.
  next.forEach((c, i) => {
    const hit = byContent.get(norm(c));
    if (hit && !used.has(hit)) { used.add(hit); out[i] = hit; }
  });
  next.forEach((c, i) => {
    if (out[i]) return;
    const positional = prev[i]?.key;
    if (positional && !used.has(positional)) { used.add(positional); out[i] = positional; return; }
    // Mint. Suffixed by index so two genuinely identical strings in one list stay two nodes.
    let k = slug(c);
    if (used.has(k)) k = `${k}~${i}`;
    used.add(k);
    out[i] = k;
  });
  return out;
}

/** The id TaskCreate assigns, which lives in its RESULT text, not its input: "Task #3 created
 *  successfully: …". Parsed rather than inferred from call order because a failed or interleaved
 *  create would shift every later index by one and silently re-point every node. */
function createdTaskId(t: FlowTool): string | null {
  const text = t.output?.blocks?.find((b) => b.type === "text")?.text;
  const m = typeof text === "string" ? /Task #(\d+)/.exec(text) : null;
  return m ? m[1] : null;
}

const readStatus = (v: unknown): FlowStatus | null =>
  v === "in_progress" || v === "completed" || v === "pending" ? v : null;

function readTodos(input: unknown): { content: string; status: FlowStatus; activeForm?: string }[] | null {
  const list = (input as { todos?: unknown })?.todos;
  if (!Array.isArray(list)) return null;
  return list.map((t: TodoItemish) => ({
    content: String(t?.content ?? ""),
    status: (t?.status === "in_progress" || t?.status === "completed" ? t.status : "pending") as FlowStatus,
    activeForm: typeof t?.activeForm === "string" ? t.activeForm : undefined,
  }));
}

/** The step a tool call belongs to: the one Claude marked in_progress. Falls back to the last
 *  completed item (the plan finished but tools kept running — verification, usually), then the first
 *  one, so a call is never silently dropped from the graph.
 *
 *  Reads the STEPS rather than either tool's own list, which is what lets one rule serve both plan
 *  sources — TodoWrite mirrors its statuses onto the steps, TaskUpdate writes them directly. */
function activeKey(keys: string[], steps: Map<string, FlowStep>): string | null {
  let lastDone: string | null = null;
  for (const k of keys) {
    const st = steps.get(k);
    if (!st) continue;
    if (st.status === "in_progress") return k;
    if (st.status === "completed") lastDone = k;
  }
  return lastDone ?? keys.find((k) => steps.has(k)) ?? null;
}

const fileOf = (t: FlowTool): string | null => {
  if (!EDIT_TOOLS.has(t.name)) return null;
  const p = (t.input as { file_path?: unknown; notebook_path?: unknown });
  const v = p?.file_path ?? p?.notebook_path;
  return typeof v === "string" ? v : null;
};

const agentOf = (t: FlowTool): { agent: string; description: string } | null => {
  if (t.name !== "Agent" && t.name !== "Task") return null;
  const i = t.input as { subagent_type?: unknown; description?: unknown };
  return {
    agent: typeof i?.subagent_type === "string" ? i.subagent_type : "agent",
    description: typeof i?.description === "string" ? i.description : "subagent",
  };
};

function blankStep(key: string, title: string, status: FlowStatus, synthetic?: boolean): FlowStep {
  return {
    key, title, status, synthetic, tools: [], thinking: "", text: "", files: [], agents: [],
    acts: [], checks: [], headline: "", t0: 0, t1: 0, cost: 0,
  };
}

// ── the semantic layer ───────────────────────────────────────────────────────────────────────────
// Everything below turns "which tool ran" into "what was it doing", which is the whole point of this
// rework. It is deliberately RULES, not a model: it has to be right while a turn is still streaming,
// it has to work with the network down, and it must never invent a fact — the model-written narration
// (lib/flow-narrate.ts) sits *beside* this, never in place of it, so the view degrades to something
// true rather than to something empty.

const READ_TOOLS = new Set(["Read", "NotebookRead"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "LS"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);
const ASK_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"]);
const DELEGATE_TOOLS = new Set(["Agent", "Task"]);

/** Commands that return a VERDICT. Matching is on the whole command, not just its head, because the
 *  verdict-bearing part is usually downstream of a `cd`/`&&`/pipe — `cd x && npm run build:check` is a
 *  build, and treating it as an unclassified shell command loses the only hard evidence in the step. */
const VERIFY_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|lint|typecheck|check)|\b(?:tsc|jest|vitest|pytest|eslint|ruff|mypy|prettier)\b|\b(?:go|cargo|make)\s+(?:test|build|check)\b|\bbuild:check\b/;
/** Commands that CHANGE something outside the working tree. Also evidence, and the kind you most want
 *  to see without unfolding anything — "it pushed" is not a detail. */
const SHIP_RE = /\bgit\s+(?:commit|push|merge|revert|reset)\b|\bdeploy\.sh\b|\bserve\.sh\b|\bnpm\s+publish\b|\bgh\s+(?:pr|release)\b/;

const cmdOf = (t: FlowTool): string => {
  const c = (t.input as { command?: unknown })?.command;
  return typeof c === "string" ? c.trim() : "";
};

/** The server half of an MCP tool name: `mcp__playwright__browser_click` → `playwright`. */
const mcpServer = (name: string): string | null => {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  return m ? m[1] : null;
};

function actOf(t: FlowTool): ActKind {
  if (READ_TOOLS.has(t.name)) return "read";
  if (SEARCH_TOOLS.has(t.name)) return "searched";
  if (EDIT_TOOLS.has(t.name)) return "changed";
  if (DELEGATE_TOOLS.has(t.name)) return "delegated";
  if (ASK_TOOLS.has(t.name)) return "asked";
  if (WEB_TOOLS.has(t.name)) return "browsed";
  if (t.name === "Bash" || t.name === "BashOutput" || t.name === "KillShell") {
    return VERIFY_RE.test(cmdOf(t)) ? "verified" : "ran";
  }
  const server = mcpServer(t.name);
  // A browser MCP is browsing whatever it's called; anything else keeps its server's name, which is
  // still a meaning ("messaged slack") where the bare verb would not be.
  if (server) return /playwright|puppeteer|browser|chrome/i.test(server) ? "browsed" : "other";
  return "other";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The phrase for one bucket. Verbs are PAST tense and about the work, not the tool — "changed 3
 *  files", never "3 Edit calls" — because the reader is auditing an outcome, not a call log. */
function actLabel(kind: ActKind, n: number, tools: FlowTool[]): string {
  switch (kind) {
    case "read": return `read ${plural(n, "file")}`;
    case "searched": return `searched the tree ${n === 1 ? "once" : `${n}×`}`;
    case "changed": {
      const files = new Set(tools.map(fileOf).filter(Boolean) as string[]);
      return `changed ${plural(files.size || n, "file")}`;
    }
    case "ran": return `ran ${plural(n, "command")}`;
    case "verified": return `${plural(n, "check")}`;
    case "delegated": return `delegated to ${plural(n, "subagent")}`;
    case "browsed": return `browsed ${plural(n, "page")}`;
    case "asked": return `asked you ${n === 1 ? "a question" : `${n} questions`}`;
    default: {
      const servers = new Set(tools.map((t) => mcpServer(t.name)).filter(Boolean) as string[]);
      return servers.size === 1 ? `used ${[...servers][0]}` : `${plural(n, "other call")}`;
    }
  }
}

// Order acts by how much they tell a reviewer, not by when they happened. A step that read forty files
// and changed one is, to the person reviewing it, a step that changed one file.
const ACT_RANK: ActKind[] = ["changed", "verified", "delegated", "ran", "browsed", "asked", "searched", "read", "other"];

/** Fold a step's raw tool calls into acts, checks and one sentence. Idempotent and pure — called once
 *  per step at the end of the fold, and safe to call again on the same step. */
function summarize(st: FlowStep): void {
  const groups = new Map<ActKind, FlowTool[]>();
  for (const t of st.tools) {
    const k = actOf(t);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(t);
  }
  st.acts = ACT_RANK.filter((k) => groups.has(k)).map((kind) => {
    const tools = groups.get(kind)!;
    // null (unknown) rather than false while anything is still in flight: a running command has not
    // failed, and drawing it as a failure is the exact kind of wrong-and-confident the view must not be.
    const anyFailed = tools.some((t) => t.ok === false);
    const anyOpen = tools.some((t) => t.done === false);
    return { kind, n: tools.length, label: actLabel(kind, tools.length, tools), ok: anyFailed ? false : anyOpen ? null : true };
  });

  st.checks = st.tools
    .filter((t) => t.name === "Bash")
    .map((t) => ({ cmd: cmdOf(t), t }))
    .filter(({ cmd }) => cmd && (VERIFY_RE.test(cmd) || SHIP_RE.test(cmd)))
    .map(({ cmd, t }) => ({
      // First line only: a heredoc or a multi-line commit body is not a label, and its second line is
      // usually the part that would blow out the node's width.
      label: cmd.split("\n")[0].slice(0, 72),
      ok: t.done === false ? null : t.ok !== false,
      verify: VERIFY_RE.test(cmd),
    }))
    .slice(0, 6);

  st.headline = st.acts.length
    ? st.acts.slice(0, 3).map((a) => a.label).join(" · ")
    : st.text.trim() ? "answered in prose" : "";
}

// ── the ask ──────────────────────────────────────────────────────────────────────────────────────
// A user row is not just what you typed. Hooks, slash-command wrappers, system reminders and pasted
// command output all arrive on the same row, and a spine whose milestones are titled
// "<system-reminder>As you answer…" is a spine nobody can read.
const NOISE_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/g,
  // A background task reporting in. Arrives on a user row because that is the only channel the CLI
  // has for it, but nobody typed it.
  /<task-notification>[\s\S]*?<\/task-notification>/g,
];

/** Whole user rows that the CLI writes on your behalf. Anchored at the start, because these are the
 *  entire message when they appear — a row that merely quotes one is still your row. */
const MACHINE_ROWS = [
  /^\s*Continue from where you left off\./,                       // auto-resume
  /^\s*This session is being continued from a previous conversation/, // post-compaction preamble
  /^\s*Base directory for this skill:/,                           // a skill the model loaded itself
  /^\s*Caveat: The messages below were generated by the user/,    // `!cmd` output, unwrapped variant
];

/** Acknowledgements: "go", "continue", "yes". Measured across 60 transcripts these are the single most
 *  common user rows on the box — 25 "go", 23 "continue", 21 auto-resumes — and not one of them is a new
 *  thing being asked for. Each would otherwise open its own milestone, splitting one piece of work
 *  across four nodes and making the spine longer exactly where it is least informative.
 *
 *  The list is exact-match and deliberately short. Anything with a noun in it is a real ask, however
 *  brief ("push to main", "deploy", "try the other one") and keeps its own node — the rule is "this
 *  message adds no new intent", not "this message is short". */
const ACKS = new Set([
  "go", "go ahead", "continue", "please continue", "keep going", "carry on", "proceed", "next",
  "yes", "y", "yeah", "yep", "ok", "okay", "k", "sure", "do it", "again", "try again", "retry",
  "resume", "more", "and", "...", "?",
]);
export const isAck = (ask: string): boolean => ACKS.has(ask.toLowerCase().replace(/[.!,]+$/, "").trim());

/** What the human actually asked, or "" if this row carries no human ask at all.
 *
 *  The empty return is load-bearing, not a failure case: `buildJourney` folds an ask-less user row into
 *  the milestone above it. Measured on a real 439-turn session, that is the difference between nine
 *  milestones — three of them titled `[Image: original 2910x1586…]` or the body of a skill the model
 *  loaded itself — and six, each one an actual sentence the human typed, with the work that answered it
 *  attached. Every pattern below was found by folding real transcripts, not imagined. */
export function cleanAsk(raw: string): string {
  let s = raw || "";
  for (const re of NOISE_BLOCKS) s = s.replace(re, " ");
  // A slash command keeps its NAME (that is the ask) but loses the wrapper.
  s = s.replace(/<command-name>\s*([^<]*)<\/command-name>/g, (_, n) => String(n).trim());
  // The CLI's resumed-session preamble, and interrupt markers — both are machine speech on a user row.
  s = s.replace(/^Caveat: The messages below[\s\S]*?$/gm, " ");
  s = s.replace(/\[Request interrupted[^\]]*\]/g, " ");
  // A pasted screenshot arrives as its own user row carrying only this marker. It is part of the ask
  // above it, never an ask of its own.
  s = s.replace(/\[Image:[^\]]*\]/g, " ");
  // Rows the CLI writes for you — a resumed session, a compaction summary, a skill the model loaded
  // for itself. They read like instructions because they are ones, just not from the human, and
  // whatever followed belongs to the ask that actually caused it.
  for (const re of MACHINE_ROWS) if (re.test(s)) return "";
  return s.replace(/\s+/g, " ").trim();
}

/** Split a transcript into turns and fold each into its step graph. */
export function buildFlow(source: SourceTurn[]): FlowTurn[] {
  const turns: FlowTurn[] = [];
  let cur: { request: string; body: SourceTurn[]; streaming?: boolean; off?: number } | null = null;
  const flush = () => { if (cur) turns.push(foldTurn(cur.request, cur.body, turns.length, cur.streaming, cur.off)); cur = null; };

  for (const t of source) {
    if (t.role === "user") { flush(); cur = { request: t.text, body: [], off: t.off }; continue; }
    // An assistant turn before any user turn (a resumed transcript opening mid-conversation) still
    // deserves a home rather than being dropped on the floor.
    if (!cur) cur = { request: "", body: [] };
    // ...and it borrows the first body row's offset as its identity. Without this the milestone falls
    // back to its array INDEX, which is stable only until the transcript window slides — and a key that
    // silently re-points is a cached narrative attached to the wrong ask.
    if (cur.off == null) cur.off = t.off;
    cur.body.push(t);
    if (t.streaming) cur.streaming = true;
  }
  flush();
  return turns;
}

function foldTurn(request: string, body: SourceTurn[], index: number, streaming?: boolean, off?: number): FlowTurn {
  const steps = new Map<string, FlowStep>();
  let todos: { content: string; status: FlowStatus; activeForm?: string }[] = [];
  let keys: string[] = [];
  // Provisional-key → real-key, for the window between a TaskCreate streaming in (no id yet, keyed on
  // its subject) and its result landing with "Task #N". Without it a TaskUpdate arriving in that
  // window addresses `task#N`, finds nothing, and the step silently never leaves "pending".
  const taskKeys = new Map<string, string>();
  // Chronological, across every step — see FlowTurn.tools.
  const flatTools: FlowTool[] = [];
  let planned = false;
  // Everything before the first TodoWrite. Kept as one node rather than spread across the plan,
  // because attributing it to a step that didn't exist yet would be a guess presented as a fact.
  const PRE = "~preamble";

  const stepFor = (key: string, title: string, status: FlowStatus, synthetic?: boolean) => {
    const found = steps.get(key);
    if (found) return found;
    const made = blankStep(key, title, status, synthetic);
    steps.set(key, made);
    return made;
  };
  const current = (): FlowStep => {
    const k = activeKey(keys, steps);
    const st = k ? steps.get(k) : null;
    return st ?? stepFor(PRE, "before the plan", "completed", true);
  };

  for (const turn of body) {
    // Apply this turn's plan updates BEFORE attributing its prose. Claude reasons about the step it is
    // *about to* take, then marks it in_progress, then works — so folding the plan calls first is what
    // puts "here's why I'm doing X" on X rather than on the step it just finished.
    for (const tool of turn.tools) {
      // --- TaskCreate / TaskUpdate: incremental, real ids ---
      if (tool.name === "TaskCreate") {
        const i = tool.input as { subject?: unknown; description?: unknown };
        const subject = typeof i?.subject === "string" ? i.subject : "";
        if (!subject) continue;
        planned = true;
        // Until the result lands (mid-stream), fall back to the subject slug so the node appears
        // immediately and then keeps its identity when the real id arrives — `taskKeys` maps the
        // provisional key to the id-based one so a TaskUpdate can still find it.
        const id = createdTaskId(tool);
        const key = id ? `task#${id}` : `task~${slug(subject)}`;
        if (id) taskKeys.set(`task~${slug(subject)}`, key);
        if (!keys.includes(key)) keys.push(key);
        const st = stepFor(key, subject, "pending");
        st.title = subject;
        if (typeof i?.description === "string" && i.description && i.description !== subject) st.detail = i.description;
        continue;
      }
      if (tool.name === "TaskUpdate") {
        const i = tool.input as { taskId?: unknown; status?: unknown; subject?: unknown };
        const key = `task#${String(i?.taskId ?? "")}`;
        const st = steps.get(key) ?? steps.get(taskKeys.get(key) ?? "");
        if (!st) continue;
        planned = true;
        const next = readStatus(i?.status);
        if (next) st.status = next;
        if (typeof i?.subject === "string" && i.subject) st.title = i.subject;
        continue;
      }
      // --- TodoWrite: whole-list replace, identity reconstructed ---
      const list = tool.name === "TodoWrite" ? readTodos(tool.input) : null;
      if (!list) continue;
      planned = true;
      keys = reconcileKeys(todos.map((t, i) => ({ key: keys[i], content: t.content })), list.map((t) => t.content));
      todos = list;
      // Re-title and re-status every known step from the newest plan — a step whose text changed must
      // show the new text, and one marked completed must stop looking like it's still running.
      todos.forEach((t, i) => { const st = stepFor(keys[i], t.content, t.status); st.title = t.content; st.status = t.status; });
    }
    const owner = current();
    if (turn.thinking) owner.thinking += (owner.thinking ? "\n\n" : "") + turn.thinking;
    if (turn.text.trim()) owner.text += (owner.text ? "\n\n" : "") + turn.text;
    // Time and money follow the same rule as prose: they belong to whichever step was in progress when
    // the message was generated. A turn is charged to exactly one step, so summing step costs across a
    // milestone can't double-count — but `t0`/`t1` are a SPAN, and spans of a step that was revisited
    // later legitimately overlap other steps. That's why the milestone's own totals are computed from
    // the body below rather than from these.
    if (turn.ts) { owner.t0 = owner.t0 ? Math.min(owner.t0, turn.ts) : turn.ts; owner.t1 = Math.max(owner.t1, turn.ts); }
    if (turn.cost) owner.cost += turn.cost;

    for (const tool of turn.tools) {
      if (PLAN_TOOLS.has(tool.name)) continue; // the plan itself isn't a step of the plan
      flatTools.push(tool);
      const st = current();
      st.tools.push(tool);
      const f = fileOf(tool);
      if (f && !st.files.includes(f)) st.files.push(f);
      const a = agentOf(tool);
      if (a) st.agents.push(a);
    }
  }

  // Turn-level truth, straight from the source rows.
  const stamps = body.map((b) => b.ts || 0).filter(Boolean);
  const totals = {
    t0: stamps.length ? Math.min(...stamps) : 0,
    t1: stamps.length ? Math.max(...stamps) : 0,
    cost: body.reduce((n, b) => n + (b.cost || 0), 0),
  };

  // No plan at all — the honest fallback. It used to be one node PER TOOL CALL, which is precisely the
  // "tool use log is too much detailed and noise" complaint: a fifteen-call turn drew fifteen boxes
  // named after tools. Now an unplanned turn groups its calls by what they DID, so the same turn reads
  // as "explored the repo · changed 3 files · build passed" — three nodes with meaning, not fifteen
  // with none. The raw calls are still on the steps; they're just behind a click.
  if (!planned) {
    const flat: FlowStep[] = [];
    const pre = steps.get(PRE);
    const byAct = new Map<ActKind, FlowTool[]>();
    for (const turn of body) {
      for (const tool of turn.tools) {
        const k = actOf(tool);
        (byAct.get(k) ?? byAct.set(k, []).get(k)!).push(tool);
      }
    }
    for (const kind of ACT_RANK) {
      const tools = byAct.get(kind);
      if (!tools?.length) continue;
      // Keyed on the act, not on a tool id, so the node survives the next poll adding another Read to
      // the same group instead of re-mounting as a different node.
      const st = blankStep(`t${index}-${kind}`, PHASE_TITLE[kind], tools.some((t) => t.done === false) ? "in_progress" : "completed", true);
      st.tools = tools;
      for (const tool of tools) {
        const f = fileOf(tool); if (f && !st.files.includes(f)) st.files.push(f);
        const a = agentOf(tool); if (a) st.agents.push(a);
      }
      flat.push(st);
    }
    // The reply itself is a step. For a turn with no tools at all it's the ONLY node, which is the
    // right picture: Claude was asked something and answered.
    if (pre && (pre.text.trim() || pre.thinking.trim())) {
      flat.push({ ...blankStep(`t${index}-reply`, "the reply", streaming ? "in_progress" : "completed", true), text: pre.text, thinking: pre.thinking, cost: pre.cost, t0: pre.t0, t1: pre.t1 });
    }
    flat.forEach(summarize);
    return { index, request, steps: flat, tools: flatTools, planned: false, streaming, off, ...totals };
  }

  // Order by the LATEST plan, then append anything the plan has since dropped (and the preamble,
  // which always leads). Ordering by first-appearance instead would leave a re-ordered plan drawn in
  // an order that no longer matches the checklist the user is reading in the composer.
  const ordered: FlowStep[] = [];
  const pre = steps.get(PRE);
  if (pre && (pre.tools.length || pre.text.trim() || pre.thinking.trim())) ordered.push(pre);
  for (const k of keys) { const st = steps.get(k); if (st) ordered.push(st); }
  for (const [k, st] of steps) if (k !== PRE && !keys.includes(k)) ordered.push(st);

  ordered.forEach(summarize);
  return { index, request, steps: ordered, tools: flatTools, planned: true, streaming, off, ...totals };
}

/** The title an unplanned turn's grouped node gets. Named for the INTENT of the group, since there is
 *  no plan item to borrow a name from — the act label ("read 6 files") then says the scale underneath. */
const PHASE_TITLE: Record<ActKind, string> = {
  changed: "made the edits",
  verified: "checked the work",
  delegated: "handed off to subagents",
  ran: "ran the commands",
  browsed: "looked things up",
  asked: "came back with questions",
  searched: "searched the code",
  read: "read the code",
  other: "other work",
};

// ── the journey ──────────────────────────────────────────────────────────────────────────────────
// One turn is not a journey. The question the flow view exists to answer — "what did I ask for, did it
// happen, and where am I now" — spans the whole session, and the per-turn pager it used to have made
// that question un-askable: you could see one turn perfectly and still have no idea whether the thing
// you asked for four turns ago ever finished. So the spine is now the SESSION, one node per ask.

/** The model-written half. Never replaces the rules — it sits beside `headline`, and its absence is a
 *  normal state (narration off, not yet run, or the summariser unreachable). */
export type Narrative = { intent: string; outcome: string; verdict: "done" | "partial" | "open" | "question" };

export type MilestoneStatus = "done" | "running" | "open";

export type Milestone = {
  /** Byte offset of the ask's row, prefixed — immutable and identical whether this was folded in the
   *  browser or on the server for narration, which is what lets a narrative be cached against it. */
  key: string;
  index: number;
  ask: string;
  turn: FlowTurn;
  status: MilestoneStatus;
  /** Plan items only. An unplanned turn contributes 0/0 and is therefore neither complete nor open —
   *  it just happened. Counting synthesized groups as "goals" would inflate the progress bar with
   *  work nobody planned. */
  goals: { done: number; total: number };
  /** Plan items this milestone left unfinished. The reason this view exists. */
  openSteps: string[];
  acts: Act[];
  files: string[];
  checks: Check[];
  /** The last few tool calls this ask made, oldest of the three first — the same order as the raw log
   *  they preview, because a preview that reverses the thing it previews is a trap. Three, because that
   *  is what fits a node without turning it back into the call log v3 was: the point is "what is it
   *  touching right now", not "what did it do". */
  recent: FlowTool[];
  /** Tech slugs for `components/BrandIcon`, derived from the calls themselves — see lib/flow-stack.ts. */
  stack: string[];
  ms: number;
  cost: number;
  headline: string;
  narrative?: Narrative;
};

export type Journey = {
  milestones: Milestone[];
  /**
   * How far along the session is.
   *
   * `unit` matters. Counting plan items is the better answer, but **most sessions never write a plan**
   * — measured on a real 439-turn working session in this repo: zero TodoWrite calls, zero TaskCreate,
   * so a goals-only meter would have read `0/0` for the entire thing and answered nothing. So where
   * there are no plan items anywhere, the meter falls back to counting ASKS resolved, and says which
   * it is counting rather than quietly changing what the number means.
   */
  progress: { done: number; total: number; open: number; unit: "goals" | "asks" };
  openLoops: { key: string; ask: string; steps: string[] }[];
  ms: number;
  cost: number;
  /** True while the last milestone is still being worked. */
  live: boolean;
};

/**
 * Concatenate two folds' steps, coalescing the ones that are the same step.
 *
 * A milestone is often several folded turns (a screenshot row, a skill the model loaded, an
 * interrupt), and each fold names its synthesized groups `t<foldIndex>-<act>` — so a naive concat gave
 * a milestone two "read the code" nodes, two "ran the commands", and a spine that looked like the
 * model had done the same thing twice. Identity here is the ACT, not the fold: `read the code` from
 * turn 3 and from turn 7 are one phase of one answer to one ask.
 *
 * PLAN steps are matched on their real key instead, and never merged across different keys — a plan
 * item has an identity that `reconcileKeys`/`TaskCreate` already established, and second-guessing it
 * here would undo that work.
 */
function mergeSteps(a: FlowStep[], b: FlowStep[]): FlowStep[] {
  const out = a.map((s) => ({ ...s }));
  const at = (s: FlowStep) => (s.synthetic ? `~${s.title}` : `!${s.key}`);
  const index = new Map(out.map((s, i) => [at(s), i]));

  for (const step of b) {
    const hit = index.get(at(step));
    if (hit === undefined) { index.set(at(step), out.length); out.push({ ...step }); continue; }
    const t = out[hit];
    t.tools = [...t.tools, ...step.tools];
    t.files = [...new Set([...t.files, ...step.files])];
    t.agents = [...t.agents, ...step.agents];
    t.thinking = [t.thinking, step.thinking].filter(Boolean).join("\n\n");
    t.text = [t.text, step.text].filter(Boolean).join("\n\n");
    t.cost += step.cost;
    if (step.t0) t.t0 = t.t0 ? Math.min(t.t0, step.t0) : step.t0;
    t.t1 = Math.max(t.t1, step.t1);
    // The LATER fold's status wins: it is the more recent word on whether this step is finished.
    t.status = step.status;
    summarize(t);
  }
  return out;
}

/** Merge per-step acts into one set for a whole milestone. */
function rollupActs(steps: FlowStep[]): Act[] {
  const by = new Map<ActKind, { n: number; tools: FlowTool[] }>();
  for (const st of steps) {
    for (const t of st.tools) {
      const k = actOf(t);
      const e = by.get(k) ?? { n: 0, tools: [] };
      e.n++; e.tools.push(t);
      by.set(k, e);
    }
  }
  return ACT_RANK.filter((k) => by.has(k)).map((kind) => {
    const { n, tools } = by.get(kind)!;
    const failed = tools.some((t) => t.ok === false);
    const open = tools.some((t) => t.done === false);
    return { kind, n, label: actLabel(kind, n, tools), ok: failed ? false : open ? null : true };
  });
}

/**
 * Fold a whole session into the spine the canvas draws.
 *
 * `narratives` is keyed by milestone key and merged in here rather than fetched here, because this
 * module stays pure and runs on both sides — the server folds the same session to decide what still
 * needs narrating, and it must reach the same keys the browser did.
 */
export function buildJourney(
  source: SourceTurn[],
  narratives?: Record<string, Narrative>,
  /** `busy` says the session has a turn in flight. It has to be passed in, because the ON-DISK
   *  transcript carries no `streaming` flag — that exists only on the live SSE stream — so a caller
   *  reading the JSONL (the canvas) would otherwise draw a running session's newest ask as finished
   *  and put a green "done" on work that is still happening. v3 shipped exactly this bug for the
   *  running-step edge animation; see the post-mortem in docs/knowledge/05f-flow.md. */
  opts?: { busy?: boolean },
): Journey {
  const turns = buildFlow(source);
  const milestones: Milestone[] = [];
  // The milestone's real span, kept alongside it while continuations are still being folded in. `ms` is
  // only computed at the end, from these — deriving it incrementally is how the first version reported
  // 20 minutes for a milestone that actually ran for an hour.
  const span = new Map<string, { t0: number; t1: number }>();

  turns.forEach((turn, i) => {
    const ask = cleanAsk(turn.request);
    const prev = milestones[milestones.length - 1];
    // A user row with no human ask in it — a pasted screenshot's marker, a skill the model loaded for
    // itself, a hook's output, a resumed-session preamble — is not a new thing you asked for. Folding
    // it into the previous milestone keeps the work attached to the ask that caused it; making it its
    // own node would put untitled boxes on the spine and, worse, break the chain between an ask and the
    // steps that answered it.
    if ((!ask || isAck(ask)) && prev) {
      prev.turn = {
        ...prev.turn,
        steps: mergeSteps(prev.turn.steps, turn.steps),
        // Plain concat, not a merge: these folds are consecutive in time by construction, so appending
        // preserves the chronology `recent` depends on.
        tools: [...prev.turn.tools, ...turn.tools],
        streaming: prev.turn.streaming || turn.streaming,
        planned: prev.turn.planned || turn.planned,
      };
      prev.cost += turn.cost;
      const sp = span.get(prev.key)!;
      if (turn.t0) sp.t0 = sp.t0 ? Math.min(sp.t0, turn.t0) : turn.t0;
      if (turn.t1) sp.t1 = Math.max(sp.t1, turn.t1);
      return;
    }
    const key = `m${turn.off ?? `i${i}`}`;
    span.set(key, { t0: turn.t0, t1: turn.t1 });
    milestones.push({
      key,
      index: milestones.length,
      ask: ask || "(continued)",
      turn,
      status: "done",
      goals: { done: 0, total: 0 },
      openSteps: [],
      acts: [], files: [], checks: [], recent: [], stack: [],
      ms: 0,
      cost: turn.cost,
      headline: "",
    });
  });

  let done = 0, total = 0, open = 0;
  const openLoops: Journey["openLoops"] = [];

  milestones.forEach((m, i) => {
    const isLast = i === milestones.length - 1;
    const steps = m.turn.steps;
    const sp = span.get(m.key);
    m.ms = sp?.t0 && sp.t1 ? sp.t1 - sp.t0 : 0;
    const plan = steps.filter((s) => !s.synthetic);
    const nDone = plan.filter((s) => s.status === "completed").length;
    const unfinished = plan.filter((s) => s.status !== "completed");

    m.goals = { done: nDone, total: plan.length };
    m.openSteps = unfinished.map((s) => s.title);
    m.acts = rollupActs(steps);
    m.files = [...new Set(steps.flatMap((s) => s.files))];
    m.checks = steps.flatMap((s) => s.checks).slice(0, 8);
    m.recent = m.turn.tools.slice(-RECENT_CALLS);
    m.stack = stackOf(m.turn.tools);

    // A milestone is RUNNING only if it is the live one. An older milestone with a step still marked
    // in_progress isn't running — it was abandoned there, which is an open loop and should read as one.
    m.status = m.turn.streaming || (isLast && (opts?.busy || plan.some((s) => s.status === "in_progress")))
      ? "running"
      : unfinished.length ? "open" : "done";

    const failed = m.checks.filter((c) => c.ok === false).length;
    const passed = m.checks.filter((c) => c.ok === true && c.verify).length;
    const verdict = failed ? `${plural(failed, "check")} failed` : passed ? `${plural(passed, "check")} passed` : "";
    m.headline = [m.acts.slice(0, 3).map((a) => a.label).join(" · "), verdict].filter(Boolean).join(" — ")
      || (steps.some((s) => s.text.trim()) ? "answered in prose" : "nothing ran");
    m.narrative = narratives?.[m.key];

    done += nDone;
    total += plan.length;
    if (m.status === "open") { open += unfinished.length; openLoops.push({ key: m.key, ask: m.ask, steps: m.openSteps }); }
  });

  // The fallback meter. `open` deliberately stays a count of unfinished PLAN items in both units — an
  // ask that ended in a question is not an open loop, it is your turn, and conflating the two would put
  // an amber warning on every conversation that ever asked you something.
  const progress = total > 0
    ? { done, total, open, unit: "goals" as const }
    : { done: milestones.filter((m) => m.status === "done").length, total: milestones.length, open: 0, unit: "asks" as const };

  // Read from the spans, not from `milestones[i].turn` — a milestone that absorbed continuations has a
  // span wider than the turn that opened it, and the turn's own `t1` is where the FIRST fold stopped.
  const first = milestones.length ? span.get(milestones[0].key) : undefined;
  const last = milestones.length ? span.get(milestones[milestones.length - 1].key) : undefined;
  return {
    milestones,
    progress,
    openLoops,
    ms: first?.t0 && last?.t1 ? last.t1 - first.t0 : 0,
    cost: milestones.reduce((n, m) => n + m.cost, 0),
    live: milestones[milestones.length - 1]?.status === "running",
  };
}
