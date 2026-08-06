// Creating (or adopting) an agent's home folder.
//
// Two paths in, one shape out. SCAFFOLD writes a fresh brain: a CLAUDE.md persona, a note structure,
// a skills dir, a memory file. ADOPT points at a folder that already has some of that — ~/secondBrain
// being the case this was built for — and fills only what's missing.
//
// Nothing here ever overwrites. `inspect()` reports what a folder already has, `scaffold()` writes
// only the absent pieces, and an existing CLAUDE.md is left exactly as found. That's not politeness:
// the folders you'd most want to adopt are the ones with years of curation in them, and a create flow
// that can clobber one is a create flow nobody will point at anything real.
import fs from "node:fs";
import path from "node:path";
import type { AgentDef } from "./types";

/** The vault's shape, trimmed to what an agent actually needs. Ordered — this is also the doc order. */
export const NOTE_DIRS = [
  "00-09 System",
  "10-19 Projects",
  "50-59 Sources/.raw",
  "60-69 Wiki",
] as const;

export const MEMORY_FILE = "MEMORY.md";
export const ACTIVITY_FILE = path.join("00-09 System", "activity.md");
/** Where the run log goes in a folder that doesn't use the vault's note structure. */
export const ACTIVITY_FILE_FLAT = path.join(".claude", "agent-activity.md");

/**
 * The activity log's path for a specific home, relative to it.
 *
 * Not a constant, because the constant forced its own directory into existence: `writeIfAbsent` mkdirs
 * the parent, so even with the note structure switched off an adopted code repo grew a "00-09 System/"
 * folder to hold one log file. A repo gets `.claude/agent-activity.md` instead — beside the settings
 * and skills that are already agent-owned — and a vault-shaped brain keeps the note-structure path.
 * Resolved per call rather than stored on the agent so that a folder which GAINS a note structure
 * later starts using it without a migration.
 */
export function activityFileFor(home: string): string {
  return fs.existsSync(path.join(home, "00-09 System")) ? ACTIVITY_FILE : ACTIVITY_FILE_FLAT;
}

export type FolderReport = {
  path: string;
  exists: boolean;
  isDir: boolean;
  /** Non-hidden entries — enough to tell "empty new folder" from "someone's vault". */
  entries: number;
  hasClaudeMd: boolean;
  hasNotes: boolean;
  hasMemory: boolean;
  hasSkills: boolean;
  /** Transcripts already on disk for this cwd. Adopting a folder with these inherits them as history. */
  sessions: number;
  /** What a create would do: write a brain from scratch, or fill the gaps in one that exists. */
  suggests: "scaffold" | "adopt";
};

/** Claude Code's project-dir encoding: every non-alphanumeric byte of the cwd becomes a dash. */
export function projectDirFor(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function countSessions(cwd: string, projectsRoot: string): number {
  try {
    return fs.readdirSync(path.join(projectsRoot, projectDirFor(cwd))).filter((f) => f.endsWith(".jsonl")).length;
  } catch { return 0; }
}

export function inspect(dir: string, projectsRoot: string): FolderReport {
  const r: FolderReport = {
    path: dir, exists: false, isDir: false, entries: 0,
    hasClaudeMd: false, hasNotes: false, hasMemory: false, hasSkills: false,
    sessions: 0, suggests: "scaffold",
  };
  if (!path.isAbsolute(dir)) return r;
  let st: fs.Stats | null = null;
  try { st = fs.statSync(dir); } catch { return r; }
  r.exists = true;
  r.isDir = st.isDirectory();
  if (!r.isDir) return r;
  try { r.entries = fs.readdirSync(dir).filter((f) => !f.startsWith(".")).length; } catch { /* unreadable */ }
  r.hasClaudeMd = fs.existsSync(path.join(dir, "CLAUDE.md"));
  r.hasMemory = fs.existsSync(path.join(dir, MEMORY_FILE));
  r.hasSkills = fs.existsSync(path.join(dir, ".claude", "skills"));
  r.hasNotes = NOTE_DIRS.some((d) => fs.existsSync(path.join(dir, d.split("/")[0])));
  r.sessions = countSessions(dir, projectsRoot);
  // A folder that already carries a persona or a note structure is someone's work — adopt it.
  r.suggests = r.hasClaudeMd || r.hasNotes || r.sessions > 0 ? "adopt" : "scaffold";
  return r;
}

function writeIfAbsent(file: string, body: string, created: string[]): void {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  created.push(file);
}

/* ---------------- the persona ---------------- */

// Written as a STARTING POINT the onboarding interview then rewrites, not as the final article — hence
// the explicit TODOs. A persona file full of confident placeholder prose reads as finished and never
// gets filled in; one with holes in it invites the interview that closes them.
function personaFor(a: AgentDef): string {
  const dirs = NOTE_DIRS.map((d) => `- \`${d}/\``).join("\n");
  return `# ${a.name}

${a.role || "TODO — one line: what this agent owns."}

You are **${a.name}**, a standing agent on Thomas's machine. This file is your constitution: it loads
on every session that runs in this folder, whether started from the Minami dashboard or from a plain
\`claude\` in a terminal here.

## What you own

TODO — the two or three things work is routed to you *for*. Be specific enough that a task obviously
does or doesn't belong to you.

## What you never do

TODO — the boundary. Name the neighbouring agent or person a request outside it should go to.

## Voice

Warm and direct. Concrete over abstract. No jargon, no hype, no build-ups — say the thing.

## Your brain

This folder is your memory, and it is yours to maintain:

${dirs}
- \`${MEMORY_FILE}\` — durable facts and the *why* behind decisions. Curated: merge, don't append forever.
- \`${activityFileFor(a.home)}\` — an append-only log of your runs. The dashboard writes to it; you read it.

**Every session, before you finish: write down what changed.** A decision, an open loop, a lesson, a
fact that will be true next week — put it in \`${MEMORY_FILE}\` or the matching note under
\`10-19 Projects/\`. Work you did that left no trace here didn't happen, because the next session
starts blind.

**This holds when you're working somewhere else.** You get assigned tasks in other folders; the work
lands there and the memory lands *here*. Write back before the run ends.

## Tools

TODO — what you're allowed to reach for, and what needs asking first. \`.claude/settings.json\` in
this folder carries the enforceable half.
`;
}

function memorySeedFor(a: AgentDef): string {
  return `# ${a.name} — memory

Durable facts and the reasoning behind decisions. One heading per topic; merge related notes rather
than appending forever. If it will still be true next month, it belongs here — if it's about one
task, it belongs in \`10-19 Projects/\`.

_Empty. The onboarding interview seeds this, and every run after that adds to it._
`;
}

function activitySeedFor(a: AgentDef): string {
  return `# ${a.name} — activity log

Append-only. One line per completed run: when, where, what came of it. Written by the dashboard's
task runner, so this stays true even when a run ends badly.

`;
}

function skillsReadme(a: AgentDef): string {
  return `# ${a.name}'s skills

Drop a \`<name>/SKILL.md\` in here and it loads automatically for any session running in this folder.

A skill is a procedure this agent should follow the same way every time — not knowledge (that goes in
\`60-69 Wiki/\`) and not identity (that's \`CLAUDE.md\`). Frontmatter needs \`name\` and a
\`description\` that says *when to use it*, because the description is all Claude sees when deciding
whether to load it.
`;
}

/**
 * The HQ appendix. HQ orchestrates through the same local API the dashboard uses, driven by a small
 * CLI — so "agents hand off to each other" is a tool HQ holds, not a hidden code path. Writing the
 * commands into its persona is what makes that reachable; an agent told it *can* delegate but not
 * *how* will just do the work itself.
 */
function hqAppendix(dashboardUrl: string): string {
  return `

## You are HQ

You're the front door. Thomas talks to you; you decide what to do yourself and what to route to
another agent, then you follow up. Peers run in their own folders with their own memory — you don't
need to hold their context, only to know who owns what.

\`\`\`bash
node ~/minami-dashboard/bin/agent.mjs list                 # the roster, with live status
node ~/minami-dashboard/bin/agent.mjs assign <id> "brief"  # hand work over; returns a task id
node ~/minami-dashboard/bin/agent.mjs assign <id> "brief" --cwd /path --handoff <other-id>
node ~/minami-dashboard/bin/agent.mjs tasks [<id>]         # what's queued, running, done
node ~/minami-dashboard/bin/agent.mjs task <task-id>       # one run, with its result
\`\`\`

The dashboard is at ${dashboardUrl}; the CLI is a thin wrapper over its \`/api/agents\` routes.

**How to delegate well:**

- Give a brief that stands alone. The agent receiving it has its own memory and none of this
  conversation — "the thing we discussed" reaches a stranger.
- Say what "done" looks like, and where the output should land.
- \`--handoff\` chains a second agent onto the first's result. Use it for real pipelines (research →
  draft), not to fan work out for its own sake.
- A run is unattended: it can't ask you a question. If the task needs a decision only Thomas can
  make, get it from him *before* assigning.
- Then tell Thomas what you routed and to whom. A silent delegation looks like you ignored him.
`;
}

/* ---------------- the write ---------------- */

export type ScaffoldResult = { created: string[]; skipped: string[] };

/** A skill file to seed into the new home. Only ever written when absent, like everything else here. */
export type SeedSkill = { name: string; description: string; body: string };

/**
 * Fill in whatever `home` is missing. Safe to run twice, and safe to run on a folder full of someone
 * else's work — every write goes through writeIfAbsent().
 *
 * `persona` and `skills` are how the team layer (§15) seeds a role: a template role already knows what
 * it owns and how it works, so it ships a written persona instead of the TODO-laden default, which
 * would otherwise mean an interview per role before the first run. They stay optional and they stay
 * write-if-absent — an agent that has since rewritten its own persona must not have it reverted by a
 * second product being pointed at the same brain.
 */
export function scaffold(
  a: AgentDef,
  opts: { dashboardUrl: string; notes?: boolean; persona?: string; skills?: SeedSkill[] },
): ScaffoldResult {
  const created: string[] = [];
  const before = new Set<string>();
  for (const f of ["CLAUDE.md", MEMORY_FILE, activityFileFor(a.home)]) {
    if (fs.existsSync(path.join(a.home, f))) before.add(f);
  }
  fs.mkdirSync(a.home, { recursive: true });

  if (opts.notes !== false) {
    for (const d of NOTE_DIRS) {
      const full = path.join(a.home, d);
      if (!fs.existsSync(full)) { fs.mkdirSync(full, { recursive: true }); created.push(full); }
    }
  }

  writeIfAbsent(
    path.join(a.home, "CLAUDE.md"),
    (opts.persona || personaFor(a)) + (a.hq ? hqAppendix(opts.dashboardUrl) : ""),
    created,
  );
  writeIfAbsent(path.join(a.home, MEMORY_FILE), memorySeedFor(a), created);
  writeIfAbsent(path.join(a.home, activityFileFor(a.home)), activitySeedFor(a), created);
  writeIfAbsent(path.join(a.home, ".claude", "skills", "README.md"), skillsReadme(a), created);
  for (const s of opts.skills || []) {
    // Frontmatter is not decoration: `description` is all Claude sees when deciding whether to load a
    // skill, so a skill without one is a file that never runs.
    const body = `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n${s.body}`;
    writeIfAbsent(path.join(a.home, ".claude", "skills", s.name, "SKILL.md"), body, created);
  }
  // An empty permissions object, on purpose: it's the file the interview edits, and an absent file is
  // one more thing to discover. `deny` first so the shape of a restriction is visible before it's needed.
  writeIfAbsent(
    path.join(a.home, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2) + "\n",
    created,
  );

  return { created, skipped: [...before] };
}

/**
 * Append the HQ section to an agent that's promoted after the fact. Separate from scaffold() because
 * writeIfAbsent() can't help here — CLAUDE.md already exists, and the section has to go *into* it.
 */
export function ensureHQSection(a: AgentDef, dashboardUrl: string): boolean {
  const file = path.join(a.home, "CLAUDE.md");
  let body: string;
  try { body = fs.readFileSync(file, "utf8"); } catch { return false; }
  if (body.includes("## You are HQ")) return false;
  fs.appendFileSync(file, hqAppendix(dashboardUrl));
  return true;
}
