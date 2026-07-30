// The agent registry — one JSON file per agent under ~/.minami/agents/.
//
// On disk rather than in localStorage, for the same reason lib/autopilot/config.ts is: the things
// that read this run in the SERVER. A task runner spawning a session needs the agent's cwd, model and
// permission mode with no browser to ask, and it has to still know them after the restart a deploy
// causes. localStorage would put the roster in one tab and hide it from the process that acts on it.
//
// One file per agent rather than one array: several panes can create agents at once, and separate
// files make that safe without a lock. The registry is deliberately thin — the substance of an agent
// (persona, notes, memory) lives in its home folder, where the CLI can see it too. What's here is
// only what the server needs to *find and spawn* it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PERMISSION_MODE, safeMode } from "../agent/manager";
import { DASHBOARD_MODEL } from "../model-pins";
import type { AgentDef } from "./types";

export const AGENTS_DIR =
  process.env.MINAMI_AGENTS_DIR || path.join(os.homedir(), ".minami", "agents");

// Where an agent reaches the dashboard from a shell. Only used in generated docs and by bin/agent.mjs
// — nothing here calls it over HTTP — but it has to be a real, reachable URL, because HQ pastes it
// into commands it runs for real.
export const DASHBOARD_URL = process.env.MINAMI_DASHBOARD_URL || "http://127.0.0.1:3000";

const DEFAULT_ICON = "◆";

/**
 * Resolve a path through symlinks, keeping it as given if it doesn't exist yet.
 *
 * Not cosmetic. The CLI records the RESOLVED cwd in its transcript, and lib/claude-sessions.ts finds
 * a session's folder by encoding that path — so an agent whose home is stored unresolved looks at the
 * wrong directory and reports an empty history for work it definitely did. macOS makes this the
 * common case, not an edge one: `/tmp` is a symlink to `/private/tmp`, and so is anything under it.
 *
 * Resolution happens on every READ rather than only at creation, because a folder that doesn't exist
 * yet can't be resolved — an agent created a moment before its home is scaffolded would otherwise
 * keep the unresolved path for its whole life.
 */
function resolvePath(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * Expand a leading `~`. The API's inspect route already did this while create did not, so typing
 * `~/brains/researcher` in the New Agent dialog produced a cheerful "doesn't exist yet — it'll be
 * created" and then failed the submit with "home must be an absolute path". One helper, used by both.
 */
export function expandHome(p: string): string {
  const s = String(p || "").trim();
  return s.replace(/^~(?=\/|$)/, os.homedir());
}

/**
 * Is this a plausible Claude model id? Not a whitelist — a dated snapshot newer than the catalog has
 * to remain settable — but enough to reject a typo or another vendor's id.
 *
 * Worth checking at all because of how the failure presents: an agent set to `gpt-4-turbo` accepts
 * the config, accepts the task, sits at "running" for the full 90-second spawn grace, and then fails
 * with "The session never started — check the folder exists and the CLI is logged in", which names
 * two things that were both fine.
 */
export function isPlausibleModel(m: string): boolean {
  return /^claude-[a-z0-9][a-z0-9.-]*$/.test(m.trim());
}

export function slugify(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function fileFor(id: string): string {
  return path.join(AGENTS_DIR, `${id}.json`);
}

/**
 * Coerce whatever is on disk into a valid AgentDef. Hand-editing these files is a supported way to
 * work (they're small and legible on purpose), so a missing or junk field degrades to a sane default
 * rather than reaching `query({ cwd: undefined })` and failing somewhere far from the cause.
 */
function normalize(raw: Partial<AgentDef>, id: string): AgentDef | null {
  const given = typeof raw.home === "string" ? raw.home : "";
  if (!given || !path.isAbsolute(given)) return null; // an agent without a brain isn't one
  const home = resolvePath(given);
  const workspaces = Array.isArray(raw.workspaces)
    ? [...new Set(
        raw.workspaces
          .filter((w): w is string => typeof w === "string" && path.isAbsolute(w))
          .map(resolvePath)
          .filter((w) => w !== home),
      )]
    : [];
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    role: typeof raw.role === "string" ? raw.role : "",
    icon: typeof raw.icon === "string" && raw.icon.trim() ? raw.icon.trim() : DEFAULT_ICON,
    home,
    workspaces,
    // The pin, not a literal — so moving lib/model-pins.ts moves every agent that never overrode it.
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : DASHBOARD_MODEL,
    permissionMode: raw.permissionMode ? safeMode(raw.permissionMode) : DEFAULT_PERMISSION_MODE,
    hq: raw.hq === true,
    createdAt: Number(raw.createdAt) || Date.now(),
    scaffolded: raw.scaffolded === true,
    onboardedAt: Number(raw.onboardedAt) || undefined,
  };
}

/**
 * Registry files that exist but couldn't be turned into an agent, and why.
 *
 * These files are documented as hand-editable, so a typo is a normal event — and the failure mode was
 * that the agent simply vanished from the roster with nothing said. Collected here so the API can
 * report them rather than presenting a silently shorter list as the truth.
 */
export function brokenAgentFiles(): { file: string; reason: string }[] {
  let names: string[];
  try { names = fs.readdirSync(AGENTS_DIR); } catch { return []; }
  const out: { file: string; reason: string }[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const id = n.replace(/\.json$/, "");
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, n), "utf8")) as Partial<AgentDef>;
      if (!normalize(raw, id)) out.push({ file: n, reason: "no usable `home` — it must be an absolute path" });
    } catch (e) {
      out.push({ file: n, reason: String((e as Error)?.message || e) });
    }
  }
  return out;
}

export function listAgents(): AgentDef[] {
  let names: string[];
  try { names = fs.readdirSync(AGENTS_DIR); } catch { return []; }
  const out: AgentDef[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const id = n.replace(/\.json$/, "");
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, n), "utf8")) as Partial<AgentDef>;
      const a = normalize(raw, id);
      if (a) out.push(a);
    } catch { /* unreadable or half-written — skip rather than break the whole roster (see brokenAgentFiles) */ }
  }
  // HQ first, then oldest-first so the roster doesn't reshuffle as you add agents.
  return out.sort((a, b) => Number(b.hq) - Number(a.hq) || a.createdAt - b.createdAt);
}

export function getAgent(id: string): AgentDef | null {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(id), "utf8")) as Partial<AgentDef>;
    return normalize(raw, id);
  } catch { return null; }
}

function write(a: AgentDef): AgentDef {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.writeFileSync(fileFor(a.id), JSON.stringify(a, null, 2) + "\n");
  return a;
}

/** Exactly one HQ. Demote the others rather than letting two tiles both claim to be the front door. */
function enforceSingleHQ(keep: string): void {
  for (const other of listAgents()) {
    if (other.id !== keep && other.hq) write({ ...other, hq: false });
  }
}

export function createAgent(input: Partial<AgentDef> & { name: string; home: string }): AgentDef {
  const base = slugify(input.id || input.name) || "agent";
  let id = base;
  // Collide by suffix rather than overwriting: `id` is baked into session keys and task records, so
  // silently reusing one would graft a new agent onto another's history.
  for (let n = 2; fs.existsSync(fileFor(id)); n++) id = `${base}-${n}`;
  const a = normalize({ ...input, createdAt: Date.now() }, id);
  if (!a) throw new Error("home must be an absolute path");
  write(a);
  if (a.hq) enforceSingleHQ(a.id);
  return a;
}

/** Patch an agent. `id`, `createdAt` and `scaffolded` are immutable — they describe history, not config. */
export function updateAgent(id: string, patch: Partial<AgentDef>): AgentDef | null {
  const cur = getAgent(id);
  if (!cur) return null;
  const next = normalize(
    { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt, scaffolded: cur.scaffolded },
    cur.id,
  );
  if (!next) return null;
  write(next);
  if (next.hq) enforceSingleHQ(next.id);
  return next;
}

/**
 * Forget an agent. Deliberately does NOT touch its home folder: that folder is the work — notes,
 * decisions, months of accumulated context — and deleting it because someone tidied a roster would be
 * unrecoverable. Removing the registry entry is reversible by re-adopting the same folder.
 */
export function deleteAgent(id: string): boolean {
  try { fs.unlinkSync(fileFor(id)); return true; } catch { return false; }
}

export function hqAgent(): AgentDef | null {
  return listAgents().find((a) => a.hq) || null;
}

/**
 * The agent already living in this folder, if any.
 *
 * Two agents sharing a home is not a harmless duplicate — it breaks the one attribution rule the
 * whole subsystem rests on. "Every session in an agent's home folder is its own" cannot be true for
 * both of them, so each would claim the other's conversations as its history, and both would write
 * their memory into one MEMORY.md and one activity log. Cheap to prevent, impossible to untangle
 * afterwards.
 */
export function agentAtHome(home: string, exceptId?: string): AgentDef | null {
  const target = resolvePath(expandHome(home));
  return listAgents().find((a) => a.id !== exceptId && a.home === target) || null;
}

/** Every folder an agent is allowed to run in. Home is always permitted; the API checks against this. */
export function allowedCwds(a: AgentDef): string[] {
  return [a.home, ...a.workspaces];
}
