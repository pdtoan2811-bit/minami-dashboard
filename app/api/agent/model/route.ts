import { setModel } from "@/lib/agent/manager";
import { SELECTABLE_MODELS } from "@/lib/model-catalog";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { key, model? } → point a pane at a different model. An omitted/null model means "the box pin"
// (DASHBOARD_MODEL), which is how the picker's default option is expressed.
//
// Answers `{ ok, respawned }`. `respawned: true` means the live session was torn down and the pane must
// send its next message with `resume` so the new subprocess picks the conversation back up off disk —
// see setModel() for why swapping a warm session's model is impossible any other way.
export async function POST(req: Request) {
  try {
    const { key, model } = await req.json();
    if (!key) return Response.json({ error: "key required" }, { status: 400 });
    // Allow-list the id rather than passing arbitrary strings to the SDK. An unknown model doesn't fail
    // at this boundary — it fails ~2s later inside a spawning subprocess, which surfaces in a pane as a
    // session that produced no reply and no transcript (the same class of unactionable failure the send
    // route's cwd check exists to prevent). `null`/absent is valid and means the pin.
    if (model != null && !SELECTABLE_MODELS.some((m) => m.id === model)) {
      return Response.json({ error: `unknown model: ${model}` }, { status: 400 });
    }
    const r = setModel(key, model ?? undefined);
    return Response.json(r);
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
