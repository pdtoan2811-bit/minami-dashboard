import { stop } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { key } → interrupt the in-flight turn on a live session (the chat panel's Stop button).
export async function POST(req: Request) {
  try {
    const { key } = await req.json();
    if (!key) return Response.json({ error: "key required" }, { status: 400 });
    const ok = await stop(key);
    return Response.json({ ok });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
