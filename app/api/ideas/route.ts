import { list, apply, add, type IdeaAction } from "@/lib/ideas";

// Ideas (§28). GET → { items (ranked), themes, removed }.
// POST JSON { op: star|comment|remove|retry, id, … } → { item }
// POST multipart (the drop box: `text` + any `file` fields) → { id }; the bot's code reads and tags it.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX = 25 * 1024 * 1024; // the same cap the bot uses for Slack downloads

export async function GET() {
  try { return Response.json(list()); }
  catch (e) { return Response.json({ error: String(e) }, { status: 500 }); }
}

export async function POST(req: Request) {
  try {
    if ((req.headers.get("content-type") || "").startsWith("multipart/form-data")) {
      const form = await req.formData();
      const files = [];
      for (const f of form.getAll("file")) {
        if (typeof f === "string" || !f.size) continue;
        if (f.size > MAX) return Response.json({ error: `${f.name} is over 25 MB` }, { status: 400 });
        files.push({ name: f.name, mime: f.type, data: Buffer.from(await f.arrayBuffer()) });
      }
      return Response.json(add(String(form.get("text") ?? ""), files));
    }
    return Response.json({ item: apply((await req.json()) as IdeaAction) });
  } catch (e) { return Response.json({ error: String((e as Error).message || e) }, { status: 400 }); }
}
