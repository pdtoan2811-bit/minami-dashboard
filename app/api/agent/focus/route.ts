import { focusList, pin, unpin, FOCUS_MAX } from "@/lib/focus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → { focus: string[], max }
// POST { id, on: true, swapOut? } → pins (409 + { full: true } when the set is full and nothing was swapped)
// POST { id, on: false } → unpins. lib/focus.ts, §23.
export function GET() {
  return Response.json({ focus: focusList(), max: FOCUS_MAX });
}

export async function POST(req: Request) {
  try {
    const { id, on, swapOut } = await req.json();
    if (typeof id !== "string" || !id) return Response.json({ error: "id required" }, { status: 400 });
    const r = on ? pin(id, typeof swapOut === "string" ? swapOut : undefined) : unpin(id);
    return Response.json({ ...r, max: FOCUS_MAX }, { status: r.ok ? 200 : 409 });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
