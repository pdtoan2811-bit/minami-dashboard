import { answer, pendingFor } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { sessionId, needId, answer } → answer a chat's AskUserQuestion from the cover screen (§23).
//
// Why not /api/agent/answer directly: that route is keyed by the literal question text, and the only
// copy of the question the cover screen has is Need.summary, which is cut at 200 chars. A long
// question would key the answer to a string the SDK never asked, and the answer would silently land on
// nothing. pendingFor() hands back the full question text and the store key — the same lookup the
// push notification's answer action uses (lib/push/server.ts) — so this resolves through exactly the
// pane's own answer() path.
//
// Deliberately narrower than /api/agent/answer, not a second door shaped like it: questions only.
// `answer` (one string) for a single-question prompt; `answers` (question → string | string[]) for a
// multi-question or multi-select ask stepped through on the cover — added 2026-10-07, when "Open on
// main screen" turned out to bounce straight back to the cover and such an ask couldn't be answered
// there at all. A tool step (permission / plan / held) is refused here on purpose —
// the cover screen never approves anything (see app/glance/Glance.tsx for why).
export async function POST(req: Request) {
  try {
    const { sessionId, needId, answer: text, answers } = await req.json();
    if (typeof sessionId !== "string" || typeof needId !== "string") {
      return Response.json({ error: "sessionId and needId are required" }, { status: 400 });
    }
    const p = pendingFor(sessionId, needId);
    // 409 rather than 404: the usual cause is that the question was answered elsewhere (main screen,
    // a notification) between this page's poll and the tap — a state change, not a bad request.
    if (!p) return Response.json({ ok: false, reason: "already settled" }, { status: 409 });
    if (answers && typeof answers === "object") {
      if (p.toolName !== "AskUserQuestion") return Response.json({ ok: false, reason: "not a question" }, { status: 409 });
      // Keyed by the literal question text, which is what answer() matches on; a key that isn't one of
      // this prompt's questions is dropped rather than trusted.
      const clean: Record<string, string | string[]> = {};
      for (const q of p.questions) {
        const v = (answers as Record<string, unknown>)[q];
        if (typeof v === "string" && v.trim()) clean[q] = v.trim().slice(0, 4000);
        else if (Array.isArray(v)) {
          const a = v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().slice(0, 4000));
          if (a.length) clean[q] = a;
        }
      }
      if (!Object.keys(clean).length) return Response.json({ error: "no answer" }, { status: 400 });
      return Response.json({ ok: answer(p.key, needId, clean) });
    }
    if (typeof text !== "string" || !text.trim()) return Response.json({ error: "answer is required" }, { status: 400 });
    if (p.toolName !== "AskUserQuestion" || p.questions.length !== 1) {
      return Response.json({ ok: false, reason: "not a single question" }, { status: 409 });
    }
    // Free text is a valid answer: it is what the main screen's "Other" row sends (components/AskCard.tsx).
    return Response.json({ ok: answer(p.key, needId, { [p.questions[0]]: text.trim().slice(0, 4000) }) });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
