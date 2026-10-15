import { listGoals, runGoalsNow } from "@/lib/goals";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → { goals } — every autonomous goal, its run log and Thomas's part today (§29).
export async function GET() {
  try { return Response.json({ goals: listGoals() }); }
  catch (e) { return Response.json({ error: String((e as Error).message || e) }, { status: 400 }); }
}

// POST { op: "run" } → { goals } — start the goal runner now instead of waiting for 06:45.
export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (b.op !== "run") throw new Error(`unknown op: ${b.op}`);
    runGoalsNow();
    return Response.json({ goals: listGoals() });
  } catch (e) { return Response.json({ error: String((e as Error).message || e) }, { status: 400 }); }
}
