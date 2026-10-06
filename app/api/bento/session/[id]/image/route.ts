import { getSession } from "@/lib/claude-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET ?tool=<toolUseId>&i=<k>[&before=<off>] → the k-th image of that tool result, as an image.
// The other half of the slim transcript (lib/transcript-slim.ts): screenshots leave the JSON and are
// fetched here only when something draws them. A tool result never changes once written, so the reply
// is cacheable for good — the second view of a screenshot costs nothing.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  const toolId = q.get("tool") || "";
  const k = Number(q.get("i") || "0");
  const b = Number(q.get("before") || "");
  if (!toolId || !Number.isInteger(k) || k < 0) return new Response("bad request", { status: 400 });
  try {
    const page = getSession(id, Number.isFinite(b) && b > 0 ? { before: b } : undefined);
    for (let t = page.turns.length - 1; t >= 0; t--) {
      const tc = page.turns[t].tools?.find((x) => x.id === toolId);
      if (!tc) continue;
      const img = tc.output?.blocks?.filter((x) => x.type === "image")[k];
      if (!img || img.type !== "image" || !img.data) break;
      return new Response(Buffer.from(img.data, "base64"), {
        headers: { "content-type": img.mediaType || "image/png", "cache-control": "private, max-age=31536000, immutable" },
      });
    }
    // Scrolled out of the live window since the URL was minted: the image is still in the file, just in
    // an older page the URL didn't name. 404 is honest; the UI already treats a dead image as normal.
    return new Response("not found", { status: 404 });
  } catch {
    return new Response("error", { status: 500 });
  }
}
