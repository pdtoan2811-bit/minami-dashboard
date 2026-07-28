/* eslint-disable @typescript-eslint/no-explicit-any */
// Server-only: semantic layer for Bento. Summarizes each Claude Code session into a MEANINGFUL
// task title + a high-level topic (for hierarchy grouping), using Haiku via the local `claude`
// CLI (the user's subscription — no API key needed). Results are cached to disk and only
// recomputed when a session grows materially, so tokens are spent once per session.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), ".minami-bento");
const CACHE = path.join(DIR, "cache.json");
export const ENRICH_MARKER = ".minami-bento"; // sessions spawned by the summarizer live here — hide them

// Project > Goal > Task. `project` is deterministic (cwd); `goal` is a mid-level objective WITHIN
// the project that groups related sessions; `task` is the specific session. Curate this file by hand
// or via the `bento-taxonomy` skill — it's the source of truth and only auto-filled when missing.
export type Entry = { messages: number; goal: string; task: string; review: boolean };
export type Digest = { id: string; project: string; title: string; lastPrompt: string; toolNames: string[]; messages: number; lastRole: string; tail: string; active?: boolean };

// Run Haiku via the local `claude` CLI WITHOUT blocking the Node event loop. spawnSync used to freeze
// the entire server (every request — including transcript loads) for the whole call; this returns a
// promise so the server keeps serving while the label is computed.
function runHaiku(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn("claude", ["-p", prompt, "--model", "claude-haiku-4-5", "--output-format", "json"], { cwd: DIR }); }
    catch { resolve(""); return; }
    let out = "", done = false;
    const finish = (v: string) => { if (!done) { done = true; clearTimeout(to); resolve(v); } };
    const to = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(out); }, 90000);
    child.stdout?.on("data", (d) => { out += d; if (out.length > 8 * 1024 * 1024) finish(out); });
    child.on("error", () => finish(""));
    child.on("close", () => finish(out));
  });
}

function readCache(): Record<string, Entry> {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return {}; }
}
function writeCache(c: Record<string, Entry>) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    // Atomic write: a torn/partial write (crash mid-write, or two processes writing at once — e.g.
    // `next dev` and `next start` both pointed at this same home dir, which has happened before on
    // this project) would otherwise leave a file that fails JSON.parse on the next readCache(), which
    // silently returns {} — and the next enrich() call would then WRITE that empty object back,
    // permanently wiping every hand-curated goal/task label for every session. write-then-rename means
    // a reader only ever sees a fully-old or fully-new file, never a partial one.
    const tmp = `${CACHE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(c));
    fs.renameSync(tmp, CACHE);
  } catch { /* disk */ }
}
export function getEnrichment(): Record<string, Entry> { return readCache(); }

function needs(d: Digest, cache: Record<string, Entry>): boolean {
  const e = cache[d.id];
  if (!e || !e.goal || e.review === undefined) return true; // never labelled → do it once
  // Re-label only a SETTLED session that grew a LOT. Never re-run on an active session every few
  // messages — that was a constant Haiku spend and a repeated server stall on every live turn.
  return !d.active && Math.abs(e.messages - d.messages) > 30;
}

// Summarize un-enriched sessions in one Haiku call, into Project > Goal > Task. Goals are reused
// within a project for consistency. Only fills MISSING entries — curated edits are never clobbered.
export async function enrich(digests: Digest[]): Promise<Record<string, Entry>> {
  const cache = readCache();
  const todo = digests.filter((d) => needs(d, cache)).slice(0, 16);
  if (!todo.length) return cache;

  // Existing goals per project (so the model reuses them instead of inventing near-duplicates).
  const goalsByProject: Record<string, Set<string>> = {};
  for (const [id, e] of Object.entries(cache)) {
    const d = digests.find((x) => x.id === id);
    if (d && e.goal) (goalsByProject[d.project] ||= new Set()).add(e.goal);
  }
  const known = Object.entries(goalsByProject).map(([p, g]) => `${p}: ${[...g].join(" | ")}`).join("\n") || "(none yet)";

  // Compact digest per session (kept short to save tokens): intent + who-spoke-last + a tail snippet.
  const lines = todo.map((d, i) =>
    `${i + 1}. id=${d.id} | project=${d.project} | intent="${(d.lastPrompt || d.title).slice(0, 110)}" | lastRole=${d.lastRole} | tail="${(d.tail || "").slice(0, 140)}" | tools=${d.toolNames.slice(0, 5).join(",")}`
  ).join("\n");

  const prompt =
    `You classify Claude Code sessions into a Project > Goal > Task hierarchy for a dashboard.\n` +
    `The PROJECT is given. For each session infer:\n` +
    `- goal: the mid-level OBJECTIVE within that project (2-5 words). REUSE an existing goal when it fits; only coin a new one otherwise.\n` +
    `- task: the specific thing this session is doing (4-7 words, concrete) — NEVER generic like "Slack turn"/"chat".\n` +
    `- review: true if the session likely NEEDS THE USER'S ATTENTION now — i.e. the last turn (see lastRole/tail) is the assistant asking a question, presenting options or a decision, reporting an error/blocker, or finishing something that needs verification (it's waiting on the user). false if it's mid-work or a clearly closed/trivial exchange.\n\n` +
    `Existing goals per project:\n${known}\n\n` +
    `Return ONLY a JSON array: [{"id":"<id>","goal":"<goal>","task":"<task>","review":true|false}].\n\n` +
    `Sessions:\n${lines}`;

  try {
    fs.mkdirSync(DIR, { recursive: true });
    let text = await runHaiku(prompt); // <-- up to 90s away; `cache` above can go stale during this gap
    try { text = JSON.parse(text).result || text; } catch { /* raw */ }
    const m = text.match(/\[[\s\S]*\]/);
    if (m) {
      const arr = JSON.parse(m[0]) as any[];
      // Re-read from disk right before merging/writing, instead of merging onto the `cache` snapshot
      // read at the top of this function (before the long Haiku await). That snapshot can be stale by
      // now — another process, or another concurrent enrich() call, may have written newer curated
      // labels while this one was waiting on Haiku — and writing it back verbatim would silently
      // clobber them. This can't fully eliminate the race (no cross-process lock), but it shrinks the
      // vulnerable window from "the whole Haiku call" down to just this read-then-write.
      const latest = readCache();
      for (const it of arr) {
        const d = todo.find((x) => x.id === it?.id);
        if (d && it?.task) {
          latest[it.id] = {
            messages: d.messages,
            goal: String(it.goal || latest[it.id]?.goal || "General").slice(0, 40),
            task: String(it.task).slice(0, 70),
            review: !!it.review,
          };
        }
      }
      writeCache(latest);
      return latest;
    }
  } catch { /* summarizer unavailable — callers fall back to heuristic titles */ }
  return cache;
}
