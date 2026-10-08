import { answerCard, type Answer } from "@/lib/team-inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { ts, answers: Answer[], text? } → a team-ask relay in the card's thread (§25).
export async function POST(req: Request) {
  const { ts, answers, text } = await req.json().catch(() => ({}));
  if (typeof ts !== "string" || !Array.isArray(answers)) return Response.json({ ok: false, error: "ts and answers are required" }, { status: 400 });
  const r = await answerCard(ts, answers as Answer[], typeof text === "string" ? text : undefined);
  return Response.json(r, { status: r.ok ? 200 : 409 });
}
