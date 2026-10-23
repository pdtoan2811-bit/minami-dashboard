import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { coverOf } from "@/lib/upload-progress";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE = path.join(os.tmpdir(), "minami-covers");

// GET ?pid&n → the cover image of one video in one publish (§33). The path comes only from that publish's own
// progress file, and only an image extension is served, so this can't be pointed at an arbitrary file.
// Covers are 1080×1920 PNGs of ~750 KB and the tile draws them at most 84 px wide, so the first request makes a
// 320 px JPEG (~20 KB) with macOS `sips`, cached by path + mtime; without sips the original is served.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const file = coverOf(Number(q.get("pid")), String(q.get("n") || ""));
  if (!file) return new Response("not found", { status: 404 });
  try {
    const st = fs.statSync(file);
    const thumb = path.join(CACHE, crypto.createHash("sha1").update(`${file}:${st.mtimeMs}`).digest("hex") + ".jpg");
    if (!fs.existsSync(thumb)) {
      try { fs.mkdirSync(CACHE, { recursive: true }); execFileSync("sips", ["-Z", "320", "-s", "format", "jpeg", file, "--out", thumb], { stdio: "ignore", timeout: 10000 }); } catch { /* serve the original */ }
    }
    const use = fs.existsSync(thumb) ? thumb : file;
    const type = use.endsWith(".jpg") || /\.jpe?g$/i.test(use) ? "image/jpeg" : /\.webp$/i.test(use) ? "image/webp" : "image/png";
    return new Response(new Uint8Array(fs.readFileSync(use)), { headers: { "content-type": type, "cache-control": "private, max-age=3600" } });
  } catch { return new Response("not found", { status: 404 }); }
}
