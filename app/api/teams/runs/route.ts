import { startRun } from "@/lib/teams/run";
import { listRuns } from "@/lib/teams/runs";
import { getProduct } from "@/lib/teams/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const productId = new URL(req.url).searchParams.get("product") || undefined;
  return Response.json({ runs: listRuns(productId) });
}

/**
 * Start a run. Returns as soon as it's dispatched — a run is minutes to tens of minutes, and this
 * request must not hang for it. The run record is how you follow it.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const product = getProduct(String(body?.productId || ""));
    if (!product) return Response.json({ error: "no such product" }, { status: 404 });
    const run = startRun(product, {
      title: typeof body?.title === "string" ? body.title : undefined,
      brief: String(body?.brief || ""),
    });
    return Response.json({ ok: true, run });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 400 });
  }
}
