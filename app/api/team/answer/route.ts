import { answerCard, type Answer } from "@/lib/team-inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { ts, answers: Answer[], text?, minami?, approved? } → a team-ask relay in the card's thread (§25).
// `minami` is set by the chat a "Để Minami trả lời" click started, so the asker sees the AI answered, not
// you; `approved` when you told that chat to send after it explained.
export async function POST(req: Request) {
  const { ts, answers, text, minami, approved } = await req.json().catch(() => ({}));
  if (typeof ts !== "string" || !Array.isArray(answers)) return Response.json({ ok: false, error: "ts and answers are required" }, { status: 400 });
  const r = await answerCard(ts, answers as Answer[], typeof text === "string" ? text : undefined, { minami: minami === true, approved: approved === true });
  return Response.json(r, { status: r.ok ? 200 : 409 });
}
