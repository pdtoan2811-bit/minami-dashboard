import { markSeen, seenAll } from "@/lib/seen";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → { seen: { [sessionId]: ms }, floor }   POST { sessionId } → marks it seen now (lib/seen.ts, §23).
export function GET() {
  return Response.json(seenAll());
}

export async function POST(req: Request) {
  try {
    const { sessionId } = await req.json();
    if (typeof sessionId !== "string" || !sessionId) return Response.json({ error: "sessionId required" }, { status: 400 });
    markSeen(sessionId);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
