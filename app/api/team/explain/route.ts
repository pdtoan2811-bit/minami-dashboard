import os from "node:os";
import { folderFor, startTeamChat } from "@/lib/team-chat";
import { explainDmPrompt, explainPrompt, findCard, findDm } from "@/lib/team-inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { ts, dm? } → starts a dashboard chat seeded with the question and returns its session id, so
// the client opens it like any other chat (§25).
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
  const sessionId = await startTeamChat(key, cwd, message);
  if (!sessionId) return Response.json({ ok: false, error: "the chat didn't start in time — look for it on the board" }, { status: 504 });
  return Response.json({ ok: true, sessionId, cwd });
}
