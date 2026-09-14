import { blacksmithState } from "@/lib/blacksmith/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/blacksmith → the factory's current state, normalized for the pane panel and the tile badge.
//
// Always 200, even when the factory is down: `up: false` with a reason is the answer, not an error.
// Half the point of the panel is to say "Blacksmith isn't running" clearly instead of rendering an
// empty board that reads exactly like "Blacksmith is running and has nothing to do".
export async function GET() {
  return Response.json(await blacksmithState());
}
