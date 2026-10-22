import { askAbout, listAsks, replyTo } from "@/lib/autopilot-ask";

export const dynamic = "force-dynamic";

// GET → { asks } — the last 7 days of questions asked from /autopilot, so each card can show its chats.
// POST { kind: "goal" | "runner", id, question } → { sessionId } — start the chat (lib/autopilot-ask.ts).
// POST { op: "reply", sessionId, text } → { ok } — the reply box under an ask's row, so answering never leaves the page.
export async function GET() {
  return Response.json({ asks: listAsks() });
}

export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (b.op === "reply") return Response.json(await replyTo(String(b.sessionId || ""), String(b.text || "")));
    if (b.kind !== "goal" && b.kind !== "runner") return Response.json({ error: "kind must be goal or runner" }, { status: 400 });
    return Response.json(await askAbout(b.kind, String(b.id), String(b.question || "")));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
