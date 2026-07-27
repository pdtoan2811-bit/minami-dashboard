import { getAttach } from "@/lib/tech-attach";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { items: [{ name, cwd }] } → { <name>: Attach } for many projects at once, so the bento grid
// can show each tile's tech icons in a single request. Local-only.
export async function POST(req: Request) {
  try {
    const { items } = await req.json();
    const out: Record<string, ReturnType<typeof getAttach>> = {};
    if (Array.isArray(items)) {
      for (const it of items.slice(0, 100)) {
        if (it?.name && it?.cwd) out[it.name] = getAttach(String(it.cwd), String(it.name));
      }
    }
    return Response.json({ attach: out });
  } catch {
    return Response.json({ attach: {} });
  }
}
