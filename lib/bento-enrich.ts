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

export type Entry = { messages: number; task: string; topic: string };
export type Digest = { id: string; project: string; title: string; lastPrompt: string; toolNames: string[]; messages: number };

function readCache(): Record<string, Entry> {
  try { return JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch { return {}; }
}
function writeCache(c: Record<string, Entry>) {
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(c)); } catch { /* disk */ }
}
export function getEnrichment(): Record<string, Entry> { return readCache(); }

function needs(d: Digest, cache: Record<string, Entry>): boolean {
  const e = cache[d.id];
  return !e || Math.abs(e.messages - d.messages) > 8;
}

// Summarize up to N un-enriched sessions in one Haiku call. Returns the full (merged) cache.
export function enrich(digests: Digest[]): Record<string, Entry> {
  const cache = readCache();
  const todo = digests.filter((d) => needs(d, cache)).slice(0, 16);
  if (!todo.length) return cache;

  const lines = todo.map((d, i) =>
    `${i + 1}. id=${d.id} | project=${d.project} | intent="${(d.lastPrompt || d.title).slice(0, 180)}" | tools=${d.toolNames.slice(0, 6).join(",")}`
  ).join("\n");

  const prompt =
    `You label Claude Code coding/agent sessions for a dashboard. For EACH session, infer what it is REALLY doing.\n` +
    `Return ONLY a JSON array, one object per session: [{"id":"<id>","task":"<4-7 word action title>","topic":"<1-3 word theme>"}].\n` +
    `Rules: task = specific and meaningful (e.g. "Wire Bento usage metrics", "Fix Slack image sending") — NEVER generic ("Slack turn", "chat"). ` +
    `topic = a short theme that GROUPS related sessions (reuse the same topic string across related sessions), e.g. "Minami infra", "Bento UI", "Ecom Intel", "Dashboard", "Deploy".\n\n` +
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
            task: String(it.task).slice(0, 70),
            topic: String(it.topic || "General").slice(0, 24),
          };
        }
      }
      writeCache(cache);
    }
  } catch { /* summarizer unavailable — callers fall back to heuristic titles */ }
  return cache;
}
