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

export type FlowStatus = "pending" | "in_progress" | "completed";

export type FlowTool = { id?: string; name: string; input: unknown; done?: boolean; ok?: boolean; ms?: number; output?: ToolOutput };

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
};

export type FlowTurn = {
  index: number;
  request: string;
  steps: FlowStep[];
  /** Whether a real plan drove this turn. The empty-plan fallback is honest about being a fallback. */
  planned: boolean;
  streaming?: boolean;
};

type SourceTurn = { role: "user" | "assistant"; text: string; tools: FlowTool[]; streaming?: boolean; thinking?: string };
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
  return { key, title, status, synthetic, tools: [], thinking: "", text: "", files: [], agents: [] };
}

/** Split a transcript into turns and fold each into its step graph. */
export function buildFlow(source: SourceTurn[]): FlowTurn[] {
  const turns: FlowTurn[] = [];
  let cur: { request: string; body: SourceTurn[]; streaming?: boolean } | null = null;
  const flush = () => { if (cur) turns.push(foldTurn(cur.request, cur.body, turns.length, cur.streaming)); cur = null; };

  for (const t of source) {
    if (t.role === "user") { flush(); cur = { request: t.text, body: [] }; continue; }
    // An assistant turn before any user turn (a resumed transcript opening mid-conversation) still
    // deserves a home rather than being dropped on the floor.
    if (!cur) cur = { request: "", body: [] };
    cur.body.push(t);
    if (t.streaming) cur.streaming = true;
  }
  flush();
  return turns;
}

function foldTurn(request: string, body: SourceTurn[], index: number, streaming?: boolean): FlowTurn {
  const steps = new Map<string, FlowStep>();
  let todos: { content: string; status: FlowStatus; activeForm?: string }[] = [];
  let keys: string[] = [];
  // Provisional-key → real-key, for the window between a TaskCreate streaming in (no id yet, keyed on
  // its subject) and its result landing with "Task #N". Without it a TaskUpdate arriving in that
  // window addresses `task#N`, finds nothing, and the step silently never leaves "pending".
  const taskKeys = new Map<string, string>();
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

    for (const tool of turn.tools) {
      if (PLAN_TOOLS.has(tool.name)) continue; // the plan itself isn't a step of the plan
      const st = current();
      st.tools.push(tool);
      const f = fileOf(tool);
      if (f && !st.files.includes(f)) st.files.push(f);
      const a = agentOf(tool);
      if (a) st.agents.push(a);
    }
  }

  // No plan at all — the honest fallback: one node per tool call, so the view is never empty for the
  // many turns (quick answers, one-file edits) that never open a TodoWrite.
  if (!planned) {
    const flat: FlowStep[] = [];
    const pre = steps.get(PRE);
    body.forEach((turn) => {
      turn.tools.forEach((tool, j) => {
        const st = blankStep(`t${index}-${tool.id || `${flat.length}-${j}`}`, activityLabel(tool.name, tool.input), tool.done === false ? "in_progress" : "completed", true);
        st.tools = [tool];
        const f = fileOf(tool); if (f) st.files.push(f);
        const a = agentOf(tool); if (a) st.agents.push(a);
        flat.push(st);
      });
    });
    // The reply itself is a step. For a turn with no tools at all it's the ONLY node, which is the
    // right picture: Claude was asked something and answered.
    if (pre && (pre.text.trim() || pre.thinking.trim())) {
      flat.push({ ...blankStep(`t${index}-reply`, "the reply", streaming ? "in_progress" : "completed", true), text: pre.text, thinking: pre.thinking });
    }
    return { index, request, steps: flat, planned: false, streaming };
  }

  // Order by the LATEST plan, then append anything the plan has since dropped (and the preamble,
  // which always leads). Ordering by first-appearance instead would leave a re-ordered plan drawn in
  // an order that no longer matches the checklist the user is reading in the composer.
  const ordered: FlowStep[] = [];
  const pre = steps.get(PRE);
  if (pre && (pre.tools.length || pre.text.trim() || pre.thinking.trim())) ordered.push(pre);
  for (const k of keys) { const st = steps.get(k); if (st) ordered.push(st); }
  for (const [k, st] of steps) if (k !== PRE && !keys.includes(k)) ordered.push(st);

  return { index, request, steps: ordered, planned: true, streaming };
}
