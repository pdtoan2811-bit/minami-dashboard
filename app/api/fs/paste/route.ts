import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { looksLikeImage, IMAGE_MIME } from "@/lib/agent/images";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST <raw image bytes>, Content-Type: image/png|jpeg|gif|webp → { path }
//
// Where a pasted image lands. NOT inside the session's cwd, deliberately: `.playwright-mcp/` gets away
// with living in the project because the MCP server writes it and this repo's .gitignore covers it —
// but the dashboard pastes into *every* topic's folder (secondBrain, ownego-growth, …) and cannot edit
// their gitignores. A pasted screenshot is chat input, not a project artifact, so it lives with the
// other dashboard-owned state under ~/.minami.
//
// Unlike /api/agent/browser/file (which reads a client-supplied cwd), this route takes NO path input
// at all: the destination root is fixed and the filename is generated here. There is nothing for a
// caller to traverse with.
const ROOT = process.env.MINAMI_PASTES || path.join(os.homedir(), ".minami", "pastes");
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
};

export async function POST(req: Request) {
  try {
    const ct = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const ext = EXT[ct];
    if (!ext) return Response.json({ error: `unsupported type: ${ct || "none"}` }, { status: 400 });

    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length === 0) return Response.json({ error: "empty body" }, { status: 400 });
    if (buf.length > MAX_BYTES) return Response.json({ error: "image too large (max 5MB)" }, { status: 413 });
    // The declared Content-Type is a claim; the header bytes are the fact.
    if (!looksLikeImage(buf)) return Response.json({ error: "not an image" }, { status: 400 });

    await fs.mkdir(ROOT, { recursive: true });
    // Timestamp for human sorting, random suffix so two pastes in the same millisecond can't collide.
    const name = `paste-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}${ext}`;
    const dest = path.join(ROOT, name);
    await fs.writeFile(dest, buf);
    void prune();
    return Response.json({ path: dest, bytes: buf.length });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

/**
 * Drop pastes older than 24h.
 *
 * Aggressive on purpose: the model already received this image inline at send time, so the file is
 * only a *rendering* cache — what lets the thumbnail come back after a reload, given that
 * `claude-sessions.ts` keeps only text blocks from user turns and `trimOutput` strips images from
 * sessionStorage. Losing it a day later costs a thumbnail in old scrollback, never the conversation.
 */
async function prune() {
  try {
    const now = Date.now();
    for (const f of await fs.readdir(ROOT)) {
      if (!IMAGE_MIME[path.extname(f).toLowerCase()]) continue;
      const p = path.join(ROOT, f);
      try {
        const st = await fs.stat(p);
        if (now - st.mtimeMs > MAX_AGE_MS) await fs.unlink(p);
      } catch { /* raced with another prune — fine */ }
    }
  } catch { /* no directory yet, or unreadable; nothing to prune */ }
}
