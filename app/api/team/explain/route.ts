import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { liveStats, sendMessage } from "@/lib/agent/manager";
import { listSessions, topicOf } from "@/lib/claude-sessions";
import { primeRepoState } from "@/lib/repo-state";
import { explainDmPrompt, explainPrompt, findCard, findDm } from "@/lib/team-inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The folder to explain a question in: the local checkout of the repo it names, so the chat can read
 *  the code being asked about. team-ask sends only the repo's basename, so match that against the
 *  folders you've actually worked in (newest first), skipping worktrees — a recycled one may vanish
 *  under the chat. Home when nothing matches; the card's own text is still the whole question. */
function folderFor(repo: string): string {
  if (repo) {
    for (const s of listSessions().sort((a, b) => b.lastActivity - a.lastActivity)) {
      if (!s.cwd || topicOf(s.cwd).isolatedAs) continue;
      if (path.basename(s.cwd) === repo && fs.existsSync(s.cwd)) return s.cwd;
    }
    for (const guess of [path.join(os.homedir(), repo), path.join(os.homedir(), "dev", repo)]) if (fs.existsSync(guess)) return guess;
  }
  return os.homedir();
}

// POST { ts, dm? } → starts a dashboard chat seeded with the question and returns its session id, so
// the client opens it like any other chat (§25). The session is born here rather than in a pane
// because the pane has no way to start with a message already in it; once `init` lands the manager
// aliases it to `live:<id>`, which is exactly what a pane opened on that id attaches to.
export async function POST(req: Request) {
  const { ts, dm } = await req.json().catch(() => ({}));
  if (typeof ts !== "string") return Response.json({ ok: false, error: "ts is required" }, { status: 400 });
  let message: string, cwd: string;
  if (dm) {
    const d = await findDm(ts);
    if (!d) return Response.json({ ok: false, error: "message not found" }, { status: 404 });
    message = explainDmPrompt(d); cwd = os.homedir();
  } else {
    const card = await findCard(ts);
    if (!card) return Response.json({ ok: false, error: "question not found" }, { status: 404 });
    message = explainPrompt(card); cwd = folderFor(card.repo);
  }
  const key = `team-explain-${ts.replace(/\D/g, "")}-${Date.now().toString(36)}`;
  await primeRepoState(cwd).catch(() => null);
  let { sessionId } = sendMessage({ key, cwd, message });
  // The id arrives with the SDK's `init`, a second or two after spawn. Wait for it here so the client
  // gets one answer instead of having to poll for a session it can't name yet.
  for (let i = 0; !sessionId && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    sessionId = liveStats().details.find((d) => d.key === key)?.sessionId ?? null;
  }
  if (!sessionId) return Response.json({ ok: false, error: "the chat didn't start in time — look for it on the board" }, { status: 504 });
  return Response.json({ ok: true, sessionId, cwd });
}
