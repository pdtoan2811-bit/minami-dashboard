import { listModules, moduleChat } from "@/lib/modules";
import { recordAsk } from "@/lib/autopilot-ask";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → { modules } — every folder under ~/.minami with a module.json (§31).
export async function GET() {
  try { return Response.json({ modules: listModules() }); }
  catch (e) { return Response.json({ error: String((e as Error).message || e) }, { status: 400 }); }
}

// POST { op: "chat", id, ask?, intent?: "new" } → { sessionId } — a new chat whose cwd is the module folder.
export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (b.op !== "chat") throw new Error(`unknown op: ${b.op}`);
    const ask = typeof b.ask === "string" ? b.ask : undefined, intent = b.intent === "new" ? "new" as const : undefined;
    const r = await moduleChat(String(b.id), ask, intent);
    // Every caller is /autopilot's boxes: recorded so the chat shows as a row under the box that started it (§31).
    recordAsk({ kind: "module", id: intent ? `${b.id}:new` : String(b.id), question: ask || (intent ? "Add a goal" : "Chat"), sessionId: r.sessionId });
    return Response.json(r);
  } catch (e) { return Response.json({ error: String((e as Error).message || e) }, { status: 400 }); }
}
