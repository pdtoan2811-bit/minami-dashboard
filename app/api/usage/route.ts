import { view, waitFresh } from "@/lib/usage-index";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET ?days=7|14|28 → the Metrics board's usage view (lib/usage-index.ts, §16). Waits briefly for a
// refresh so a reload shows the turn that just ended; never waits for a cold build — the board polls
// while `building` is set and draws whatever is indexed so far.
export async function GET(req: Request) {
  const days = Math.min(35, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 7));
  await waitFresh(1500);
  return Response.json(view(days), { headers: { "cache-control": "no-store" } });
}
