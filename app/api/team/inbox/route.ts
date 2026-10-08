import { teamInbox } from "@/lib/team-inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The team inbox (§25). `?force=1` skips the 20s cache — used right after you answer, so the card
// flips to "sent" without waiting a poll.
export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  return Response.json(await teamInbox(force));
}
