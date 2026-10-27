import { harnessLogin } from "@/lib/harness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { on: boolean, url? } → open or close the harness's phone login page (§36). The page it serves is
// tailnet-only, like the dashboard; `url` must be http(s) so this can't be turned into a way to run anything else.
export async function POST(req: Request) {
  const { on, url } = await req.json().catch(() => ({}));
  if (typeof url === "string" && !/^https?:\/\/[^\s]+$/.test(url)) return Response.json({ ok: false, out: "url must be http(s)" }, { status: 400 });
  const r = await harnessLogin(on !== false, typeof url === "string" ? url : undefined);
  return Response.json(r, { status: r.ok ? 200 : 500 });
}
