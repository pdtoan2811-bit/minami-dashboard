import { list, logs, pause, resume, runNow, update, create, remove, trash, restore, heal } from "@/lib/automations";
import { upNext } from "@/lib/upnext";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → { items, trash, upNext, heal } — every automation on this Mac (§27). GET ?logs=<id> → { text }, the log's tail.
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("logs");
  try {
    if (id) return Response.json({ text: logs(id) });
    const items = list();
    return Response.json({ items, trash: trash(), upNext: upNext(items), heal: heal(items) });
  } catch (e) { return Response.json({ error: String((e as Error).message || e) }, { status: 400 }); }
}

// POST { op, id, ... } → { items, trash } — pause · resume · run · update · create · delete · restore.
export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (b.op === "pause") pause(String(b.id));
    else if (b.op === "resume") resume(String(b.id));
    else if (b.op === "run") runNow(String(b.id));
    else if (b.op === "update") update(b);
    else if (b.op === "create") create(b);
    else if (b.op === "delete") remove(String(b.id));
    else if (b.op === "restore") restore(String(b.file));
    else throw new Error(`unknown op ${b.op}`);
    return Response.json({ items: list(), trash: trash() });
  } catch (e) { return Response.json({ error: String((e as Error).message || e) }, { status: 400 }); }
}
