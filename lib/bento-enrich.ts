/* eslint-disable @typescript-eslint/no-explicit-any */
// Server-only: semantic layer for Bento. Summarizes each Claude Code session into a MEANINGFUL
// task title + a high-level topic (for hierarchy grouping), using Haiku via the local `claude`
// CLI (the user's subscription — no API key needed). Results are cached to disk and only
// recomputed when a session grows materially, so tokens are spent once per session.
import { spawnSync } from "node:child_process";
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
export type Digest = { id: string; project: string; title: string; lastPrompt: string; toolNames: string[]; messages: number; lastRole: string; tail: string };

function readCache(): Record<string, Entry> {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return {}; }
}
function writeCache(c: Record<string, Entry>) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(c)); } catch { /* disk */ }
}
export function getEnrichment(): Record<string, Entry> { return readCache(); }

function needs(d: Digest, cache: Record<string, Entry>): boolean {
  const e = cache[d.id];
  return !e || !e.goal || e.review === undefined || Math.abs(e.messages - d.messages) > 8;
}

// Summarize un-enriched sessions in one Haiku call, into Project > Goal > Task. Goals are reused
// within a project for consistency. Only fills MISSING entries — curated edits are never clobbered.
export function enrich(digests: Digest[]): Record<string, Entry> {
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
    const res = spawnSync("claude", ["-p", prompt, "--model", "claude-haiku-4-5", "--output-format", "json"], {
      cwd: DIR, encoding: "utf8", timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    });
    let text = res.stdout || "";
    try { text = JSON.parse(text).result || text; } catch { /* raw */ }
    const m = text.match(/\[[\s\S]*\]/);
    if (m) {
      const arr = JSON.parse(m[0]) as any[];
      for (const it of arr) {
        const d = todo.find((x) => x.id === it?.id);
        if (d && it?.task) {
          cache[it.id] = {
            messages: d.messages,
            goal: String(it.goal || cache[it.id]?.goal || "General").slice(0, 40),
            task: String(it.task).slice(0, 70),
            review: !!it.review,
          };
        }
      }
      writeCache(cache);
    }
  } catch { /* summarizer unavailable — callers fall back to heuristic titles */ }
  return cache;
}
