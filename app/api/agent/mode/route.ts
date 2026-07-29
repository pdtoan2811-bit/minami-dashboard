import { setMode } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { key, mode } → change a live session's permission mode (default | acceptEdits | plan |
// bypassPermissions). All four are real, user-selectable modes (see the composer's approval-level
// toggle in app/page.tsx); safeMode() in manager.ts only clamps unrecognized values to "default".
export async function POST(req: Request) {
  try {
    const { key, mode } = await req.json();
    if (!key) return Response.json({ error: "key required" }, { status: 400 });
    // Report whether it APPLIED. This used to always answer ok:true, including when the key matched no
    // live session at all — so the composer's pill lit up over a no-op and the badge you were reading
    // described a mode the session had never been in. The client reverts the pill on ok:false.
    const ok = setMode(key, mode);
    return Response.json({ ok });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
