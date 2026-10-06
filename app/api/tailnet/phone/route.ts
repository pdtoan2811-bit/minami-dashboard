import { phoneAccess, setPhoneAccess } from "@/lib/tailnet";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET → PhoneAccess (is Tailscale up, is the dashboard served on the tailnet, which phones are online).
// POST { on } → turn the dashboard's tailnet entry on/off (lib/tailnet.ts, §23). Same trust boundary as
// every route here: whoever can reach this server already has a bypassPermissions shell on the box.
export async function GET() {
  return Response.json(await phoneAccess());
}

export async function POST(req: Request) {
  let on: unknown;
  try { ({ on } = await req.json()); } catch { /* 400 below */ }
  if (typeof on !== "boolean") return Response.json({ error: "on (boolean) is required" }, { status: 400 });
  try { return Response.json(await setPhoneAccess(on)); }
  catch (e) { return Response.json({ ...(await phoneAccess()), error: (e as Error).message.split("\n")[0] }, { status: 502 }); }
}
