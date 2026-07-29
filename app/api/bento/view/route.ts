import { getViewPrefs, setViewPref, type BentoView } from "@/lib/view-prefs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET  → { views: { [project]: "flow" } }  — only non-default choices are stored, so an absent key
//         means Chat. The grid reads this once and applies it to every tile's ⚙.
export async function GET() {
  return Response.json({ views: getViewPrefs() });
}

// POST { project, view: "chat" | "flow" } → persist one topic's view choice.
export async function POST(req: Request) {
  try {
    const { project, view } = await req.json();
    if (!project || (view !== "chat" && view !== "flow")) {
      return Response.json({ error: "project and view (chat|flow) are required" }, { status: 400 });
    }
    return Response.json({ ok: true, views: setViewPref(String(project), view as BentoView) });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
