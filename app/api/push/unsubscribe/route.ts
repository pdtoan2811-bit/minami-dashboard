import { removeDevice } from "@/lib/push/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { endpoint } → forget this device (§24).
export async function POST(req: Request) {
  try {
    const { endpoint } = await req.json();
    if (typeof endpoint !== "string" || !endpoint) return Response.json({ error: "endpoint required" }, { status: 400 });
    return Response.json({ ok: removeDevice(endpoint) });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
