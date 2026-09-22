import { teamRoster } from "@/lib/team-roster";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Who a question can be forwarded to — team-ask's roster minus whoever is at this machine.
// `[]` when team-ask isn't installed; the ask card hides its forward row on an empty list.
export async function GET() {
  return Response.json({ members: teamRoster() });
}
