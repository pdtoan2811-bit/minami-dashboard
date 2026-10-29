import { current, apply, type OpinionOp } from "@/lib/opinion";

// Opinion Reveal (§38). GET → { interview, weeks, studio }. POST { op, week, story, … } → { interview }.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try { return Response.json(current()); }
  catch (e) { return Response.json({ error: String((e as Error).message || e) }, { status: 500 }); }
}

export async function POST(req: Request) {
  try { return Response.json({ interview: apply((await req.json()) as OpinionOp) }); }
  catch (e) { return Response.json({ error: String((e as Error).message || e) }, { status: 400 }); }
}
