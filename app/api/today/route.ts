import { readDay, listDays, applyAction, runHeartbeat, handoff, localDate, type TodayAction, type Handoff } from "@/lib/today";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET [?date=YYYY-MM-DD] → { day, days } — the Today page's data (§26). `days` lists every stored day,
// newest first, for the history strip.
export async function GET(req: Request) {
  const date = new URL(req.url).searchParams.get("date") || localDate();
  try { return Response.json({ day: readDay(date), days: listDays(), today: localDate() }); }
  catch (e) { return Response.json({ error: String(e) }, { status: 400 }); }
}

// POST { date?, op, ... } → { day } — tick, add, drop, resolve, reopen, note; or { op: "heartbeat" } to
// rebuild today's plan now instead of waiting for 07:30.
export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (body.op === "heartbeat") return Response.json(runHeartbeat());
    // { op: "handoff", kind, id, how: do|decide|ask, member?, answer? } → { ok, sessionId } (open /?open=<id>)
    if (body.op === "handoff") return Response.json(await handoff(body.date || localDate(), body as Handoff));
    const date = body.date || localDate();
    return Response.json({ day: applyAction(date, body as TodayAction) });
  } catch (e) { return Response.json({ error: String(e) }, { status: 400 }); }
}
