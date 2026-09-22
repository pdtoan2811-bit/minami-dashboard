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

/** What every dashboard session is told about the people it can ask.
 *
 *  This is how "ask ducba whether we partition by day or month" works with no parsing, no command
 *  syntax and no new UI: the session simply knows who exists, what each of them owns, and the rule
 *  that nothing reaches a real person's DM without Thomas saying send. Absent — no team-ask, no
 *  roster, or MINAMI_TEAM_ASK=0 — and the prompt is untouched, so a fresh clone pays nothing.
 *
 *  Kept short on purpose: it rides in EVERY session's system prompt. §3. */
export function teamBriefing(): string | null {
  if (process.env.MINAMI_TEAM_ASK === "0") return null;
  const team = teamRoster();
  if (team.length === 0) return null;
  const who = team
    .map((m) => `- **${m.name}** (key \`${m.key}\`)${m.role ? ` — ${m.role}` : ""}${m.expertise?.length ? ` · ${m.expertise.join(", ")}` : ""}`)
    .join("\n");
  return `## Asking a teammate — the \`ask_team\` tool

You are running on Thomas's machine, and two other people can be pulled into a decision over Slack.
\`ask_team\` posts an AskUserQuestion-shaped card to that person's DM and blocks until they answer
(hours, if need be — it moves to a background task, so keep working on whatever doesn't depend on it).

${who}

**When to reach for it.** Either Thomas says so — "ask ducba whether…", "send that one to Trung" —
or you hit a decision that is plainly theirs by the areas above and is not yours or his to make: an
architecture or infra call, a schema or ClickHouse question, a security judgement. Do **not** use it
for anything answerable from the code, the git log or the repo's own docs; read those first. Do not
use it when any option would do — decide, and say what you assumed.

**Confirm before it goes out — always, including when you spotted it yourself.** A DM to a real
person cannot be unsent, and the first draft of a question is usually the weakest one. So: draft the
call, show the topic, the questions and the options in the chat, then ask Thomas with
AskUserQuestion — "Send this to <name>?" with options *Send it* / *Let me edit it first* / *I'll
answer it myself*. Call \`ask_team\` only after he picks send. If he says he'll answer it himself,
drop it and ask him directly instead.

**Write it for someone who has not seen this task.** \`context\` carries file:line plus what is being
built. Every option's description states the CONSEQUENCE of picking it, never a restatement of the
label. Say what is already settled so they don't reopen it. One topic per call, 1–4 related
questions; unrelated questions are separate calls.

**When the answer comes back**, say in one line what you did with it, so the decision is visible in
the transcript rather than only in Slack.`;
}
