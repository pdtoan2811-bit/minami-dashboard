import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveStats, sendMessage } from "@/lib/agent/manager";
import { listSessions, topicOf } from "@/lib/claude-sessions";
import { primeRepoState } from "@/lib/repo-state";
import { minamiPrompt, type TeamCard } from "@/lib/team-inbox";

/** The folder to talk about a question in: the local checkout of the repo it names, so the chat can read
 *  the code being asked about. team-ask sends only the repo's basename, so match that against the
 *  folders you've actually worked in (newest first), skipping worktrees — a recycled one may vanish
 *  under the chat. Home when nothing matches; the card's own text is still the whole question. */
export function folderFor(repo: string): string {
  if (repo) {
    for (const s of listSessions().sort((a, b) => b.lastActivity - a.lastActivity)) {
      if (!s.cwd || topicOf(s.cwd).isolatedAs) continue;
      if (path.basename(s.cwd) === repo && fs.existsSync(s.cwd)) return s.cwd;
    }
    for (const guess of [path.join(os.homedir(), repo), path.join(os.homedir(), "dev", repo)]) if (fs.existsSync(guess)) return guess;
  }
  return os.homedir();
}

/** Start a dashboard chat with its first message already in it and return the session id (§25). The
 *  session is born server-side because a pane has no way to start with a message in it; once `init`
 *  lands the manager aliases it to `live:<id>`, which is what a pane opened on that id attaches to. The
 *  id arrives a second or two after spawn, so wait here — the client gets one answer instead of
 *  polling for a session it can't name yet. */
export async function startTeamChat(key: string, cwd: string, message: string): Promise<string | null> {
  await primeRepoState(cwd).catch(() => null);
  let { sessionId } = sendMessage({ key, cwd, message });
  for (let i = 0; !sessionId && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    sessionId = liveStats().details.find((d) => d.key === key)?.sessionId ?? null;
  }
  return sessionId ?? null;
}

// ── "Để Minami trả lời" ──────────────────────────────────────────────────────────────────────────
// One Minami chat per card, remembered on disk. The button is a link, and a link gets clicked twice, opened
// on the phone and then the Mac, reloaded: each of those must land on the chat that already answered,
// never start a second one that answers again. On disk rather than in memory because a deploy restarts
// the server between the click and the second look.
const FILE = path.join(os.homedir(), ".minami", "team-minami.json");
type Seen = Record<string, { sessionId: string; at: number }>;
const readSeen = (): Seen => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")) as Seen; } catch { return {}; } };

// Two clicks that arrive together (Slack opens the link, the phone retries) both find nothing on disk
// before either has a session id to write; the in-flight promise makes the second wait for the first.
const starting = new Map<string, Promise<string | null>>();

/** The chat already answering this card, if a click started one (or is starting one right now). */
export async function minamiChatFor(ts: string): Promise<string | null> {
  return readSeen()[ts]?.sessionId ?? (await starting.get(ts)) ?? null;
}

export async function minamiAnswers(card: TeamCard): Promise<{ sessionId: string | null; fresh: boolean }> {
  const had = await minamiChatFor(card.ts);
  if (had) return { sessionId: had, fresh: false };
  const p = (async () => {
    const port = process.env.PORT || "3000";
    const key = `team-minami-${card.ts.replace(/\D/g, "")}`;
    const sid = await startTeamChat(key, folderFor(card.repo), minamiPrompt(card, `http://127.0.0.1:${port}`));
    if (sid) {
      const seen = readSeen();
      seen[card.ts] = { sessionId: sid, at: Date.now() };
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(seen, null, 1));
    }
    return sid;
  })();
  starting.set(card.ts, p);
  try { return { sessionId: await p, fresh: true }; } finally { starting.delete(card.ts); }
}
