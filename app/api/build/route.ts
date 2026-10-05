export const dynamic = "force-dynamic";

// GET → { build } — the id this server was built as (next.config.mjs `env.MINAMI_BUILD`, inlined at
// build time into the client bundle AND this route alike). lib/use-build-refresh.ts compares it with
// the id baked into the page it is running, so an installed phone app that has sat in the background
// across a deploy notices it is stale and reloads (§23).
export function GET() {
  return Response.json({ build: process.env.MINAMI_BUILD || "" }, { headers: { "cache-control": "no-store" } });
}
