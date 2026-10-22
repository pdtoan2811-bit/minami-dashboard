// Modules (§31): a module is a folder that describes itself, so that any chat started inside it, by this
// dashboard or by whatever replaces Claude Code, reads the right rules and the right data with no help from us.
//
// The folder is the product; this file is one reader of it. A folder under MINAMI_HOME (~/.minami) is a module
// when it has a module.json. Nothing here writes into a module: its data has one writer (the module's own CLI or
// runner), and the dashboard only finds modules, shows them and opens a chat in them. Opening a chat is the whole
// trick: a chat's cwd decides which CLAUDE.md, skills and memory load (§31), so cwd = the module folder is enough
// for the chat to know where it is. There is no prompt-side context to keep in sync with the files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const ROOT = process.env.MINAMI_HOME || path.join(HOME, ".minami");

/** module.json, as far as the dashboard reads it. Everything else in the manifest is for the agent. */
export type ModuleManifest = {
  module: string; manifestVersion: number; title: string; summary: string;
  door?: string; cli?: string; view?: string; lessons?: string[];
  writer?: { who: string; code?: string; schedule?: string };
};
export type ModuleInfo = ModuleManifest & { dir: string };

export function listModules(): ModuleInfo[] {
  let names: string[] = [];
  try { names = fs.readdirSync(ROOT); } catch { return []; }
  const out: ModuleInfo[] = [];
  for (const n of names) {
    const dir = path.join(ROOT, n);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(dir, "module.json"), "utf8")) as ModuleManifest;
      // A manifest mid-edit, or one from a newer layout this reader doesn't know, is skipped, not fatal.
      if (typeof m.module !== "string" || m.manifestVersion !== 1) continue;
      out.push({ ...m, dir });
    } catch { /* not a module */ }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Start a chat whose cwd is the module folder. A new chat per click: unlike "Resolve with Minami" (one chat per goal
 * per day) there is no single job to resume here, and two questions about a module are two conversations.
 */
export async function moduleChat(id: string, ask?: string, intent?: "new"): Promise<{ sessionId: string }> {
  const m = listModules().find((x) => x.module === id);
  if (!m) throw new Error(`no module ${id}`);
  const q = (ask ?? "").trim().slice(0, 500);
  const { sendMessage, liveStats } = await import("@/lib/agent/manager");
  const key = `module:${id}:${Date.now()}`;
  // The first line is the chat's name on the board (§5h). The rules come from the folder's own CLAUDE.md /
  // AGENTS.md, not from this message: a chat opened in the folder any other way must know just as much. So the
  // message says only what Thomas typed and how to answer; HOW to add a goal lives in the module's AGENTS.md.
  const message = intent === "new" && q
    ? `${m.title} · new: ${q}\n\nThomas typed this into "Add" on the ${m.title} tab:\n\n${q}\n\n` +
      "Follow your AGENTS.md's procedure for adding one: draft it, show him, and write nothing until he says yes."
    : q
    ? `${m.title} · ${q}\n\nThomas typed this on the ${m.title} tab of Autopilot:\n\n${q}\n\n` +
      "Answer first, plainly and short, from this module's data. If it asks for a change, say what you'd change and ask " +
      "before doing it, unless it is trivial and safe. Never post as Thomas."
    : `${m.title} · chat\n\nThomas opened a chat in the ${m.title} module. Read the state the way your AGENTS.md says, ` +
      "give him where things stand in at most five lines, then wait for his question. Change nothing yet.";
  let { sessionId } = sendMessage({ key, cwd: m.dir, message });
  for (let i = 0; !sessionId && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    sessionId = liveStats().details.find((d) => d.key === key)?.sessionId ?? null;
  }
  if (!sessionId) throw new Error("the chat didn't start in time — look for it on the board");
  return { sessionId };
}
