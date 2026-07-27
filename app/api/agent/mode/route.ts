import { setMode } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { key, mode } → change a live session's permission mode (default | acceptEdits | plan).
// bypassPermissions is never honoured — safeMode() clamps anything else to "default".
export async function POST(req: Request) {
  try {
    const { key, mode } = await req.json();
    if (!key) return Response.json({ error: "key required" }, { status: 400 });
    setMode(key, mode);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
