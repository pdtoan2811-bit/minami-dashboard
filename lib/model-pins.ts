import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The declared model pin for this box, and the drift check behind the dashboard's alert.
//
// Why this file exists: the model a bot spawns on is decided in a *different process from the one
// that can tell you about it*. Minami's brain is a Node daemon in ~/Minami reading its own .env;
// the dashboard's chat sessions are the Agent SDK inside this Next process; token-slayer owns the
// account underneath both. Nothing reconciled them, so "Minami is on Opus 5" was a belief, not an
// observation — and on 2026-07-29 the belief was wrong for weeks (brain.js still defaulted to Opus
// 4.8 while everything else had moved on). This module makes the pin declarative and *checkable*:
// one PINNED_MODEL constant, one function that reads what each spawner is actually configured to
// use, and a boolean the alert can render.
//
// The check is config-level, not runtime: it reports what the next spawned turn WILL use, which is
// the thing you can still fix. A running session keeps whatever model it was born with (same
// caveat as token-slayer's account switching — see the token-slayer skill).

// ── the pin ───────────────────────────────────────────────────────────────────────────────────
// Every judgement-layer spawner on this box should be on this model. Opus 5 (anh, 2026-07-29).
// Overridable per-deploy so a box can be pinned to something else without editing code.
export const PINNED_MODEL = process.env.MINAMI_PINNED_MODEL || "claude-opus-5";

// The dashboard's own Bento chat sessions. Falls through to the pin rather than repeating the
// literal, so moving the pin moves this too — that's the whole point of the file.
export const DASHBOARD_MODEL = process.env.MINAMI_DASHBOARD_MODEL || PINNED_MODEL;

// The picker menu. Defined in lib/model-catalog.ts and re-exported here so this file stays the one
// place code looks for "which models exist" — the catalog is a separate module only because THIS one
// imports node:fs, and the agent config form that renders the menu runs in the browser.
export { SELECTABLE_MODELS } from "./model-catalog";

// Where Minami's bot repo lives, for reading its brain config.
const MINAMI_DIR = process.env.MINAMI_BOT_DIR || path.join(os.homedir(), "Minami");

export type SpawnerPin = {
  /** Human label, shown in the alert. */
  name: string;
  /** The model this spawner is currently configured to use, or null if it can't be determined. */
  model: string | null;
  /** Where that value came from — so a drift alert tells you which file to edit. */
  source: string;
  drifted: boolean;
};

// Read Minami's brain model the same way brain.js resolves it: BRAIN_MODEL from .env wins, else the
// code default. We parse brain.js's default rather than hardcoding a copy here — a copy would go
// stale silently and this module's entire job is to not do that.
function readMinamiBrainModel(): { model: string | null; source: string } {
  // 1. An explicit .env override on this box.
  try {
    const env = fs.readFileSync(path.join(MINAMI_DIR, ".env"), "utf8");
    // Last non-empty assignment wins, mirroring dotenv-style last-write semantics.
    const hits = [...env.matchAll(/^\s*BRAIN_MODEL\s*=\s*(.*)$/gm)]
      .map((m) => m[1].trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
    if (hits.length) return { model: hits[hits.length - 1], source: "~/Minami/.env BRAIN_MODEL" };
  } catch { /* no .env on this box — fall through to the code default */ }

  // 2. The code default in brain.js: `process.env.BRAIN_MODEL || 'claude-opus-5'`.
  try {
    const src = fs.readFileSync(path.join(MINAMI_DIR, "src", "brain.js"), "utf8");
    const m = src.match(/BRAIN_MODEL\s*\|\|\s*['"]([^'"]+)['"]/);
    if (m) return { model: m[1], source: "~/Minami/src/brain.js default" };
  } catch { /* Minami not installed here */ }

  return { model: null, source: "not found on this host" };
}

/**
 * What every judgement-layer spawner on this box is configured to run, and whether any has drifted
 * off PINNED_MODEL.
 *
 * Deliberately excludes deterministic cheap-model callers — `lib/bento-enrich.ts` pins Haiku 4.5 on
 * purpose (it labels sessions; it is not judgement work), and flagging it would train you to ignore
 * this alert. Only spawners that are *supposed* to be on the pin are checked. Same reasoning as the
 * model-routing skill's table: cheap-by-design is not drift.
 */
export function checkModelPins(): { pinned: string; spawners: SpawnerPin[]; drifted: boolean } {
  const brain = readMinamiBrainModel();

  const spawners: SpawnerPin[] = [
    {
      name: "Minami bot",
      model: brain.model,
      source: brain.source,
      // A spawner we cannot read is not drift — it's absence. Reporting "unknown" as a violation
      // would make the alert fire permanently on any box without the bot checked out.
      drifted: brain.model != null && brain.model !== PINNED_MODEL,
    },
    {
      name: "Dashboard chat",
      model: DASHBOARD_MODEL,
      source: process.env.MINAMI_DASHBOARD_MODEL
        ? "MINAMI_DASHBOARD_MODEL env"
        : "lib/model-pins.ts default",
      drifted: DASHBOARD_MODEL !== PINNED_MODEL,
    },
  ];

  return { pinned: PINNED_MODEL, spawners, drifted: spawners.some((s) => s.drifted) };
}
