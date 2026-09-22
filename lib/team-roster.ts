// The people Claude can hand a question to, read from team-ask's own roster
// (github.com/Anhduchb01/team-ask — `team.json`, the same file its MCP server reads).
//
// Deliberately a READ of that file rather than a copy: the roster is the team's, it changes when
// someone joins, and a second list here would drift into sending questions to the wrong person.
// Absent on any machine without team-ask, in which case the ask card simply shows no forward row.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TeamMember } from "./team-forward";

export type { TeamMember };

const TEAM_ASK_DIR = process.env.MINAMI_TEAM_ASK_DIR || path.join(os.homedir(), "dev", "team-ask");

/** Who is sitting at THIS machine — you don't forward a question to yourself. team-ask decides this
 *  with CC_ASK_ME (or a git-email match); we read the same knob so the two can't disagree. */
function meKey(): string | null {
  if (process.env.MINAMI_ASK_ME) return process.env.MINAMI_ASK_ME;
  try {
    // Only this one key is read — nothing else in that file is ours to look at.
    const env = fs.readFileSync(path.join(TEAM_ASK_DIR, ".env"), "utf8");
    return /^\s*CC_ASK_ME\s*=\s*(.+?)\s*$/m.exec(env)?.[1] || null;
  } catch {
    return null;
  }
}

let cache: { at: number; mtime: number; members: TeamMember[] } | null = null;

/** Everyone but you. Empty when team-ask isn't installed — callers treat that as "no forwarding". */
export function teamRoster(): TeamMember[] {
  const file = path.join(TEAM_ASK_DIR, "team.json");
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return [];
  }
  if (cache && cache.mtime === mtime && Date.now() - cache.at < 60_000) return cache.members;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as TeamMember[];
    const me = meKey();
    const members = (Array.isArray(raw) ? raw : [])
      .filter((m) => m?.key && m.key !== me)
      .map((m) => ({ key: m.key, name: m.name || m.key, role: m.role, expertise: m.expertise }));
    cache = { at: Date.now(), mtime, members };
    return members;
  } catch {
    return [];
  }
}
