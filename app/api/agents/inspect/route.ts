import { inspect } from "@/lib/agents/scaffold";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

/**
 * `?path=/abs/path` → what a create would find there.
 *
 * The create dialog calls this as you type, so it can say "this folder already has a CLAUDE.md and 84
 * sessions — adopting" instead of making you guess whether you're about to write into something. The
 * scaffold never overwrites either way; this is what makes that visible before you commit to it.
 */
export async function GET(req: Request) {
  try {
    const p = new URL(req.url).searchParams.get("path") || "";
    if (!p) return Response.json({ error: "path is required" }, { status: 400 });
    return Response.json({ report: inspect(p.replace(/^~(?=\/|$)/, os.homedir()), PROJECTS) });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
