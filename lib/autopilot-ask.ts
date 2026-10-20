// Ask about a goal or a runner from /autopilot, and get a chat (§29, §27). Picked in the autopilot-phone pitch
// (round 4, 2026-10-20): the questions sit on the card they're about, a tap starts the chat straight away, as
// Today's hand-off does, and the chat stays on that card afterwards with its working/ready state.
//
// Each ask is appended to ~/.minami/autopilot-asks.jsonl. That file is the only link between a card and its
// chats: the session has no idea which card it came from, and the board shouldn't have to parse first lines.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listGoals, resolveContext } from "@/lib/goals";
import { list as listAutomations, logs } from "@/lib/automations";

const HOME = os.homedir();
const VAULT = process.env.SECOND_BRAIN_DIR || path.join(HOME, "secondBrain");
const FILE = path.join(HOME, ".minami", "autopilot-asks.jsonl");
/** Asks older than this drop off the cards (the chats themselves stay on the board). */
const KEEP_MS = 7 * 86400_000;

export type AskKind = "goal" | "runner";
export type Ask = { kind: AskKind; id: string; question: string; sessionId: string; at: string };

export function listAsks(): Ask[] {
  try {
    const cut = Date.now() - KEEP_MS;
    return fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try { const a = JSON.parse(l) as Ask; return Date.parse(a.at) > cut ? [a] : []; } catch { return []; }
    });
  } catch { return []; }
}

function runnerContext(id: string): { cwd: string; name: string; context: string } {
  const a = listAutomations().find((x) => x.id === id);
  if (!a) throw new Error(`no runner ${id}`);
  // The runner's own folder, so that project's CLAUDE.md and memory load; the vault when it has none.
  const cwd = a.workdir && fs.existsSync(a.workdir) ? a.workdir : VAULT;
  const tail = logs(id, 40).trim();
  const context = [
    `Runner: ${a.name} (${a.id}, ${a.kind})`,
    a.project && `Project: ${a.project}`,
    `What it does: ${a.description}`,
    `Schedule: ${a.scheduleText}${a.nextRun ? ` · next ${a.nextRun}` : ""}`,
    `Status: ${a.status}${a.lastExit != null ? ` · last exit ${a.lastExit}` : ""}${a.lastRun ? ` · last run ${a.lastRun}` : ""}`,
    `Command: ${a.command}${a.workdir ? ` (in ${a.workdir})` : ""}`,
    a.log && `Log: ${a.log}`,
    tail && `Last lines of its log:\n${tail}`,
  ].filter(Boolean).join("\n");
  return { cwd, name: a.name, context };
}

export async function askAbout(kind: AskKind, id: string, question: string): Promise<{ sessionId: string }> {
  const q = question.trim().slice(0, 500);
  if (!q) throw new Error("empty question");
  let cwd: string, name: string, context: string;
  if (kind === "goal") {
    const g = listGoals().find((x) => x.spec.id === id);
    if (!g) throw new Error(`no goal ${id}`);
    cwd = VAULT; name = g.note; context = resolveContext(g);
  } else ({ cwd, name, context } = runnerContext(id));

  const { sendMessage, liveStats } = await import("@/lib/agent/manager");
  const key = `autopilot:ask:${kind}:${id}:${Date.now()}`;
  // The first line is the chat's name on the board (§5h).
  const message = `Autopilot · ${q}\n\nThomas asked this from the Autopilot page, about the ${kind} “${name}”. What the dashboard knows:\n\n${context}\n\n` +
    "Answer the question first, plainly and short, from the data above and whatever you need to read. Then, if something is broken, say what you'd fix and ask before changing anything, unless the fix is trivial and safe. Never post as Thomas.";
  let { sessionId } = sendMessage({ key, cwd, message });
  for (let i = 0; !sessionId && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    sessionId = liveStats().details.find((d) => d.key === key)?.sessionId ?? null;
  }
  if (!sessionId) throw new Error("the chat didn't start in time — look for it on the board");
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify({ kind, id, question: q, sessionId, at: new Date().toISOString() } satisfies Ask) + "\n");
  return { sessionId };
}
