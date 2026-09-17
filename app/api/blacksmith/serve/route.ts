import { serveBlacksmithUi } from "@/lib/blacksmith/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/blacksmith/serve → start `smith ui serve` if it isn't answering, wait for its pulse.
//
// Takes no input on purpose: the binary, the clone and the port all come from the server's own
// config (lib/agent/manager.ts), so there is nothing a caller can point this at. Always 200 with
// `ok`/`up`/`reason` — like GET /api/blacksmith, "it didn't start, here's why" is an answer for the
// strip to render, not an error for a console.
export async function POST() {
  return Response.json(await serveBlacksmithUi());
}
