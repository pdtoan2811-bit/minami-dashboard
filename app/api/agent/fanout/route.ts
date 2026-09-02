import { setFanout } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { key, fanout } → turn the fan-out instruction on/off for a pane. The model route's twin:
// the instruction is a creation-time system-prompt append, so on a warm session the server answers
// by tearing it down (`respawned: true`) and the pane's next send resumes the conversation from
// disk under the new prompt. On a pane with no live session, this is a no-op — the flag rides in
// with every send anyway and simply applies at the next creation.
export async function POST(req: Request) {
  try {
    const { key, fanout } = await req.json();
    if (!key) return Response.json({ error: "key required" }, { status: 400 });
    if (typeof fanout !== "boolean") return Response.json({ error: "fanout must be boolean" }, { status: 400 });
    return Response.json(setFanout(key, fanout));
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
