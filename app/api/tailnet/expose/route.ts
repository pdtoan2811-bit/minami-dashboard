import { exposePort } from "@/lib/tailnet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { port } → { base: "https://<host>.ts.net[:port]" } — the tailnet address of a localhost port,
// creating a tailnet-only `tailscale serve` entry if it has none. Called by lib/open-local.ts when a
// localhost link is tapped on a device that isn't this machine (§23).
//
// Trust boundary: the same as every other route here — whoever reaches this server already has a
// bypassPermissions shell on the box. This adds one thing they could not already do with that shell
// in one command: nothing. Ports below 1024 are refused anyway; nothing worth previewing lives there,
// and :443 is the dashboard's own serve entry, which a stray request must never be able to replace.
export async function POST(req: Request) {
  let port: unknown;
  try { ({ port } = await req.json()); } catch { /* fall through to the 400 */ }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) {
    return Response.json({ error: "port must be an integer 1024–65535" }, { status: 400 });
  }
  const r = await exposePort(port);
  return r.ok ? Response.json({ base: r.base, created: r.created }) : Response.json({ error: r.error }, { status: r.status });
}
