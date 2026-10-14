import fs from "node:fs";
import path from "node:path";
import { mediaPath } from "@/lib/ideas";

// A saved image/file for the /ideas cards. Only files the item itself lists, and only under the media dir.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", mov: "video/quicktime", pdf: "application/pdf" };

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  const p = mediaPath(id, Number(n));
  if (!p) return new Response("not found", { status: 404 });
  const type = TYPES[path.extname(p).slice(1).toLowerCase()] || "application/octet-stream";
  // Immutable: an item's file never changes once saved (a re-save gets a new id).
  return new Response(fs.readFileSync(p), { headers: { "content-type": type, "cache-control": "private, max-age=31536000, immutable" } });
}
