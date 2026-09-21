import { answerAskTeam } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { key, id, labels, text? } → answer the in-flight `ask_team` call from the pane, via the Ask
// Hub. `id` is the tool_use id the card was rendered from; the hub's own id is looked up server-side.
export async function POST(req: Request) {
  try {
    const { key, id, labels, text } = await req.json();
    if (!key || !id || !Array.isArray(labels)) {
      return Response.json({ error: "key, id and labels are required" }, { status: 400 });
    }
    const r = await answerAskTeam(String(key), String(id), labels.map(String), typeof text === "string" ? text : undefined);
    return Response.json(r, { status: r.ok ? 200 : 409 });
  } catch (e) {
    return Response.json({ ok: false, reason: String((e as Error)?.message || e) }, { status: 500 });
  }
}
