import { listModules, moduleChat } from "@/lib/modules";

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
    return Response.json(await moduleChat(String(b.id), typeof b.ask === "string" ? b.ask : undefined, b.intent === "new" ? "new" : undefined));
  } catch (e) { return Response.json({ error: String((e as Error).message || e) }, { status: 400 }); }
}
