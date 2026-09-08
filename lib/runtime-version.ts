// Which Claude Code actually runs the chats — which is NOT the one on your PATH.
//
// 2026-09-08: picking Fable 5.1 in a pane died mid-turn with
//   "API Error: 400 Claude Code 2.1.220 does not support this model; version 2.1.251 or newer is
//    required. Run 'claude update', or update the Claude desktop app, then try again."
//
// The advice in that message is wrong here, and following it would have wasted an afternoon: `claude`
// on this box was ALREADY 2.1.241, and updating it further would have changed nothing. The Agent SDK
// ships its own Claude Code binary and spawns that one — `@anthropic-ai/claude-agent-sdk@0.3.220`
// carries 2.1.220, built 2026-07-24. The only way to move it is to bump the npm dependency.
//
// So the version that governs which models a pane may use is a property of node_modules, and the app
// had no idea what it was. It does now, so the picker can decline a model BEFORE a turn is spent on it
// rather than surfacing a 400 the user has to decode.

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
