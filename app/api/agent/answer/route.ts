import { answer } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { key, id, answers } → answer Claude's AskUserQuestion prompt.
// answers = { [questionText]: "<label>" | ["<label>", ...] }.
export async function POST(req: Request) {
  try {
    const { key, id, answers } = await req.json();
    if (!key || !id || !answers || typeof answers !== "object") {
      return Response.json({ error: "key, id and answers are required" }, { status: 400 });
    }
    return Response.json({ ok: answer(key, id, answers) });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
