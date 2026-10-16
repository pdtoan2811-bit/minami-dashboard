import { toVideo } from "@/lib/ideas";

// POST { id } → { item } — send an idea to Video Studio as a story card for tomorrow's plan (§28,
// lib/ideas.ts toVideo). Idempotent: an idea already sent comes back as it is, nothing re-runs.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { id } = (await req.json()) as { id?: string };
    if (!id || !/^[0-9a-z]{4,32}$/i.test(id)) return Response.json({ error: "bad id" }, { status: 400 });
    return Response.json({ item: toVideo(id) });
  } catch (e) { return Response.json({ error: String((e as Error).message || e) }, { status: 400 }); }
}
