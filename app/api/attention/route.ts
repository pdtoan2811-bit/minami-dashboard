import { act } from "@/lib/attention";
import { askAbout } from "@/lib/autopilot-ask";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { op, key, ... } → { att } — Thomas's moves on a flagged item (§34, lib/attention.ts):
//   resolve { how?, note? } · reopen · comment { text } · ask { text, runner, context } — the last starts a chat in that
//   runner's folder (lib/autopilot-ask.ts) with the flag as its subject, and records the chat on the flag. Both are
//   clipped to fit askAbout's 500-character question, whose first line names the chat on the board.
export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (!b?.key || typeof b.key !== "string") return Response.json({ error: "key is required" }, { status: 400 });
    if (b.op === "ask") {
      const text = String(b.text || "").trim();
      if (!text) return Response.json({ error: "say what you want done" }, { status: 400 });
      const { sessionId } = await askAbout("runner", String(b.runner || ""), `${text.slice(0, 180)}\n\nAbout: ${String(b.context || b.key).slice(0, 300)}`);
      return Response.json({ att: act({ op: "chat", key: b.key, sessionId, text }), sessionId });
    }
    if (!["resolve", "reopen", "comment"].includes(b.op)) return Response.json({ error: "op must be resolve, reopen, comment or ask" }, { status: 400 });
    return Response.json({ att: act(b) });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 400 });
  }
}
