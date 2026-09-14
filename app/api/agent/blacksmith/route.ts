import { setBlacksmith } from "@/lib/agent/manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { key, blacksmith } → turn the Blacksmith operator console on/off for a pane. The fan-out
// route's twin, for the same reason: the instruction is a creation-time system-prompt append, so on a
// warm session the server answers by tearing it down (`respawned: true`) and the pane's next send
// resumes the conversation from disk under the new prompt. On a pane with no live session this is a
// no-op — the flag rides in with every send anyway and applies at the next creation.
export async function POST(req: Request) {
  try {
    const { key, blacksmith } = await req.json();
    if (!key) return Response.json({ error: "key required" }, { status: 400 });
    if (typeof blacksmith !== "boolean") return Response.json({ error: "blacksmith must be boolean" }, { status: 400 });
    return Response.json(setBlacksmith(key, blacksmith));
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
