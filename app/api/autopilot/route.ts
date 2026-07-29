import { readConfig, writeConfig, type AutopilotConfig } from "@/lib/autopilot/config";
import { status } from "@/lib/autopilot/runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET  → the switch, plus what the runner would see right now (tasks, base state, what's blocked).
// POST → patch the switch. Local-only, like every other route here.
export async function GET() {
  try {
    return Response.json(await status());
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e), config: readConfig() }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Partial<AutopilotConfig>;
    // Whitelist: this file is the on-switch for something that rewrites the user's git history, so a
    // stray key from a future client must not become config it silently obeys.
    const patch: Partial<AutopilotConfig> = {};
    for (const k of ["enabled", "merge", "deploy", "resolve"] as const) {
      if (typeof body[k] === "boolean") patch[k] = body[k];
    }
    for (const k of ["settleMs", "everyMs"] as const) {
      if (typeof body[k] === "number") patch[k] = body[k];
    }
    return Response.json({ ok: true, config: writeConfig(patch) });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
