/* eslint-disable @typescript-eslint/no-explicit-any */
// Server-only: the model-written half of the flow view.
//
// `lib/flow-model.ts` can tell you a milestone "changed 3 files · 2 checks passed". It cannot tell you
// that the milestone was *"harden the deploy gate so a busy pane can't be swapped out from under"* and
// that it *"landed the check but left the timeout unwired"*. That sentence is the thing being asked
// for — "the semantic intuitive idea of the goal of each step and how AI handled it" — and no rule
// over tool names can produce it, because it is about intent, and intent lives in prose.
//
// Three rules this module is built around, in order of how much trouble breaking them causes:
//
//  1. **It never replaces the rules.** A narrative is an ADDITIONAL field on a milestone that already
//     has a true `headline`. Narration off, model unreachable, JSON malformed, box offline — every one
//     of those degrades to a view that still says something correct. This is why the rules pass exists
//     at all rather than being deleted once narration worked.
//  2. **It only narrates FINISHED milestones.** A running turn's outcome is not yet a fact, and paying
//     Haiku to guess at one produces a sentence that is wrong for as long as the turn lasts — the worst
//     possible failure for a view whose whole job is "can I trust that this is done".
//  3. **It is cached against content, not just identity.** A milestone that grows (a continuation row
//     folded into it) gets a new signature and is re-narrated once; one that hasn't changed is never
//     paid for twice, however many panes open the flow.
//
// Cost shape, measured against the same spawner `lib/bento-enrich.ts` uses: one Haiku call per BATCH
// of up to 8 milestones, not one per milestone, and only for milestones never seen before. A long
// session narrates once and then costs nothing until it grows.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHEAP_MODEL } from "./model-pins";
import { buildJourney, type Journey, type Milestone, type Narrative } from "./flow-model";

// Same home as the bento enricher's cache, and — importantly — the same `cwd` for the spawned CLI.
// `ENRICH_MARKER` is how the board hides sessions that the dashboard spawned for its own bookkeeping;
// narrating from anywhere else would make every narration call show up as a new tile on the grid the
// user is looking at, which is a self-referential mess that took a while to diagnose the first time.
const DIR = path.join(os.homedir(), ".minami-bento");
const CACHE = path.join(DIR, "flow-narratives.json");

/** Off with `MINAMI_FLOW_NARRATE=0`. On by default: a flow view that needs a setting flipped before it
 *  says anything readable is a flow view nobody sees working. */
export const NARRATE_ENABLED = process.env.MINAMI_FLOW_NARRATE !== "0";
const BATCH = Number(process.env.MINAMI_FLOW_NARRATE_BATCH || 8);

type Cached = Narrative & { sig: string };
type Store = Record<string, Record<string, Cached>>; // sessionId → milestoneKey → narrative

/** What must change before a milestone is worth re-narrating. Step count and tool count move whenever
 *  real work is added; status moves when it finishes. Anything else (a re-poll, a re-fold, another
 *  pane opening the same session) leaves this identical, which is the point. */
function signature(m: Milestone): string {
  const tools = m.turn.steps.reduce((n, s) => n + s.tools.length, 0);
  return `${m.turn.steps.length}.${tools}.${m.status}.${m.goals.done}/${m.goals.total}`;
}

function readStore(): Store {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return {}; }
}
function writeStore(s: Store) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    // write-then-rename, same reasoning as bento-enrich's cache: a torn file fails JSON.parse, which
    // silently reads as "{}" — and the next write would then persist that emptiness over every
    // narrative the session ever paid for.
    const tmp = `${CACHE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, CACHE);
  } catch { /* disk */ }
}

function runHaiku(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { fs.mkdirSync(DIR, { recursive: true }); child = spawn("claude", ["-p", prompt, "--model", CHEAP_MODEL, "--output-format", "json"], { cwd: DIR }); }
    catch { resolve(""); return; }
    let out = "", done = false;
    const finish = (v: string) => { if (!done) { done = true; clearTimeout(to); resolve(v); } };
    const to = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(""); }, 60_000);
    child.stdout?.on("data", (d) => { out += d; if (out.length > 4 * 1024 * 1024) finish(out); });
    child.on("error", () => finish(""));
    child.on("close", () => finish(out));
  });
}

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** One milestone, compressed to what a summariser actually needs. Deliberately includes Claude's own
 *  closing prose: that is where "how it handled it" is actually stated, and a digest of tool names
 *  alone produces bland, interchangeable sentences. */
function digest(m: Milestone): string {
  const plan = m.turn.steps.filter((s) => !s.synthetic).map((s) => `${s.status === "completed" ? "x" : s.status === "in_progress" ? ">" : "-"} ${cut(s.title, 70)}`);
  const say = m.turn.steps.map((s) => s.text).filter(Boolean).join(" ").trim();
  return [
    `key=${m.key}`,
    `asked="${cut(m.ask, 220)}"`,
    plan.length ? `plan=[${plan.join(" | ")}]` : `plan=none`,
    `did=${m.acts.map((a) => a.label).join(", ") || "nothing"}`,
    m.files.length ? `files=${m.files.slice(0, 6).map((f) => f.split("/").slice(-2).join("/")).join(",")}` : "",
    m.checks.length ? `checks=${m.checks.map((c) => `${c.ok === false ? "FAIL" : c.ok ? "ok" : "?"}:${cut(c.label, 40)}`).join(" | ")}` : "",
    say ? `said="${cut(say.slice(-700), 700)}"` : "",
  ].filter(Boolean).join(" | ");
}

const PROMPT_HEAD =
  `You write the one-line summaries under each step of a "what did the AI actually do" timeline for a developer reviewing their own Claude Code session.\n\n` +
  `For each milestone below produce:\n` +
  `- intent: what the HUMAN wanted, in their terms. 4-9 words, lowercase, no trailing period. Not a restatement of the tools used.\n` +
  `- outcome: what the AI did about it and how it ended. Max 22 words, past tense, concrete and specific (name the thing changed, the check that ran, the answer given). No hype, no "successfully", no "I". If it failed or stopped short, SAY SO plainly.\n` +
  `- verdict: one of "done" (the ask was fulfilled), "partial" (real progress, something left unfinished), "open" (started and abandoned, or blocked), "question" (ended by asking the human something / presenting options).\n\n` +
  `Be accurate over fluent. Everything you say must be supported by the digest — never infer a result that isn't there. If a milestone's digest shows no work, say what was actually said instead.\n\n` +
  `Return ONLY a JSON array: [{"key":"...","intent":"...","outcome":"...","verdict":"..."}]\n\n` +
  `Milestones:\n`;

const VERDICTS = new Set(["done", "partial", "open", "question"]);

// One narration per session at a time. Panes poll, and two overlapping calls for the same session are
// pure waste — the second would ask Haiku for sentences the first is already paying for.
const inflight: Map<string, Promise<Record<string, Narrative>>> =
  ((globalThis as any).__minamiNarrateInflight ||= new Map());

/** Everything already known for a session. Free, no spawn — this is what a normal poll reads. */
export function readNarratives(sessionId: string): Record<string, Narrative> {
  const out: Record<string, Narrative> = {};
  for (const [k, v] of Object.entries(readStore()[sessionId] || {})) out[k] = { intent: v.intent, outcome: v.outcome, verdict: v.verdict };
  return out;
}

/**
 * Narrate whatever this session is missing, and return the full set for it.
 *
 * Returns the cached set unchanged when narration is off, when nothing is missing, or when the
 * summariser fails — callers cannot distinguish those, and shouldn't: in every case the answer is
 * "here is what is known", and the rules-derived headline covers the rest.
 */
export async function narrateSession(sessionId: string, journey: Journey): Promise<Record<string, Narrative>> {
  if (!NARRATE_ENABLED) return {};
  const running = inflight.get(sessionId);
  if (running) return running;

  const store = readStore();
  const have = store[sessionId] || {};
  const todo = journey.milestones
    .filter((m) => m.status !== "running")             // rule 2: an unfinished outcome is not a fact
    .filter((m) => have[m.key]?.sig !== signature(m))
    .slice(-BATCH);                                    // newest first — the tail is what's being read
  if (!todo.length) return readNarratives(sessionId);

  const job = (async () => {
    try {
      const text = await runHaiku(PROMPT_HEAD + todo.map(digest).join("\n"));
      let body = text;
      try { body = JSON.parse(text).result || text; } catch { /* raw stdout */ }
      const m = body.match(/\[[\s\S]*\]/);
      if (!m) return readNarratives(sessionId);
      const arr = JSON.parse(m[0]) as any[];

      // Re-read immediately before merging: this function was away for up to a minute, and another
      // session's narration may have written in that window. Same race, same shrink-the-window fix as
      // bento-enrich — merging onto the pre-await snapshot would drop those writes.
      const latest = readStore();
      const bucket = (latest[sessionId] ||= {});
      for (const it of arr) {
        const hit = todo.find((x) => x.key === it?.key);
        if (!hit || !it?.outcome) continue;
        bucket[hit.key] = {
          sig: signature(hit),
          intent: String(it.intent || "").slice(0, 90),
          outcome: String(it.outcome).slice(0, 220),
          verdict: VERDICTS.has(it.verdict) ? it.verdict : "done",
        };
      }
      // Bound the store: a box with months of sessions shouldn't carry every one forever. Keeping the
      // 200 most recently written sessions is the same order as the 60-tile board plus history.
      const keys = Object.keys(latest);
      if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete latest[k];
      writeStore(latest);
      return readNarratives(sessionId);
    } catch {
      return readNarratives(sessionId);
    } finally {
      inflight.delete(sessionId);
    }
  })();

  inflight.set(sessionId, job);
  return job;
}

/** Fold a session's turns and narrate in one step — what the API route wants. */
export async function journeyWithNarration(sessionId: string, turns: any[], narrate: boolean): Promise<Journey> {
  const first = buildJourney(turns, readNarratives(sessionId));
  if (!narrate || !NARRATE_ENABLED) return first;
  const narratives = await narrateSession(sessionId, first);
  return buildJourney(turns, narratives);
}
