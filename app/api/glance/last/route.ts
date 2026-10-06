import { getSession } from "@/lib/claude-sessions";
import { splitPreviewBlock } from "@/lib/preview-block";
import { pendingFor } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET ?id=<sessionId>[&need=<needId>] → { text, at, you, question? } — the chat's latest reply IN FULL, for the cover screen's
// reader (§23). The live feed only carries the first 400 chars of a reply (`ended.text`), and the cover
// cut even that to four lines: "I can't read full". The transcript route would answer this too, but
// it ships the whole tail page (~160 KB on a real chat) to a 362px screen to read one message.
// `you` is your last message, so the reader can say what the reply is answering.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const id = q.get("id") || "";
  const needId = q.get("need") || "";
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  try {
    const { turns } = getSession(id);
    let text = "", at = 0, you = "";
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i] as { role: string; text?: string; ts?: number | string };
      if (!text && t.role === "assistant" && t.text) {
        // Collect the whole last assistant run (one reply is often several rows), oldest first.
        let j = i; const parts: string[] = [];
        while (j >= 0 && (turns[j] as { role: string }).role === "assistant") { const x = (turns[j] as { text?: string }).text; if (x) parts.unshift(x); j--; }
        text = splitPreviewBlock(parts.join("\n\n")).body.trim();
        at = typeof t.ts === "number" ? t.ts : Date.parse(String(t.ts || "")) || 0;
        i = j + 1;
        continue;
      }
      if (text && t.role === "user" && t.text) { you = t.text.slice(0, 600); break; }
    }
    // A pending question's FULL wording: the feed's `need.summary` is cut at 200 chars.
    const question = needId ? pendingFor(id, needId)?.questions.join("\n\n") || undefined : undefined;
    return Response.json({ text: text.slice(0, 20000), at, you, ...(question ? { question } : {}) });
  } catch {
    return Response.json({ text: "", at: 0, you: "" });
  }
}
