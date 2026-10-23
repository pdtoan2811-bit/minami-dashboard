import { sessionIdentity } from "@/lib/agent/manager";
import { readUploads, trayOf, uploadsFor } from "@/lib/upload-progress";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET ?key=<pane key>&cwd=<pane cwd> → { trays } for the publishes this chat is running (§33). Polled by the
// agent card every 2 s while its pane has work in flight. The key is resolved through the live store because
// the pane holds `live:<sid>` after its first turn while the child saw the spawn key; `cwd` is the fallback
// for a pane whose session isn't live here (nothing it started can be running then, but a run without a key
// from the same repo still can).
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const key = q.get("key") || "", cwd = q.get("cwd") || "";
  const who = (key && sessionIdentity(key)) || (cwd ? { key: "\0none", cwd } : null);
  if (!who) return Response.json({ trays: [] });
  return Response.json({ trays: uploadsFor(readUploads(), who).map(trayOf) });
}
