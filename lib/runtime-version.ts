// Which Claude Code actually runs the chats — which is NOT the one on your PATH.
//
// 2026-09-08: picking Fable 5.1 in a pane died mid-turn with
//   "API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.251 or newer is
//    required. Run 'claude update', or update the Claude desktop app, then try again."
//
// The advice in that message is wrong here, and following it would have wasted an afternoon: `claude`
// on this box was ALREADY 2.1.241, and updating it further would have changed nothing. The Agent SDK
// ships its own Claude Code binary and spawns that one — at the time, `@anthropic-ai/claude-agent-sdk@0.3.220`
// carrying 2.1.220, built 2026-07-24. The only way to move it is to bump the npm dependency.
//
// So the version that governs which models a pane may use is a property of node_modules, and the app
// had no idea what it was. It does now, so the picker can decline a model BEFORE a turn is spent on it
// rather than surfacing a 400 the user has to decode.
//
// 2026-09-14: bumped to 0.3.270 / CLI 2.1.270, which is why no number is hardcoded below — the manifest
// is read at runtime precisely so this file does not become the thing that goes stale. The bump is also
// why Fable 5.1 (minCli 2.1.251) is now selectable here at all. Two hazards are recorded in
// docs/knowledge/03-live-sessions.md §3: NODE_ENV=production prunes devDeps on install, and the running
// server keeps the OLD wrapper in memory while resolving the NEW binary from disk, so deploy promptly
// after installing and check manifest.sdkCompat.testedWrapperVersions covers the pairing.

import fs from "node:fs";
import path from "node:path";

const MANIFEST = path.join(
  process.cwd(), "node_modules", "@anthropic-ai", "claude-agent-sdk", "manifest.json",
);

let cached: { at: number; version: string | null } | null = null;
const TTL_MS = 60_000; // a dependency bump needs a redeploy anyway; this is just a guard against churn

/**
 * The version of the Claude Code binary the SDK will spawn, or null if it can't be determined.
 *
 * Null is a real answer and callers must treat it as "no reason to block" rather than "blocked" — a
 * layout change in the SDK package must not silently strip the model picker down to nothing.
 */
export function sdkClaudeVersion(): string | null {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.version;
  let version: string | null = null;
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as { version?: unknown };
    if (typeof raw.version === "string" && /^\d+\.\d+/.test(raw.version)) version = raw.version;
  } catch { /* not installed, or the package moved its manifest — see the null contract above */ }
  cached = { at: Date.now(), version };
  return version;
}
