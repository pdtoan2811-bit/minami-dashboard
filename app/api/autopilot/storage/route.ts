import path from "node:path";
import { execFileSync } from "node:child_process";
import { snapshot, startJanitor } from "@/lib/autopilot/storage";
import { readConfig } from "@/lib/autopilot/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The Storage tab (§32). GET → free space, the trend, the last passes, what was removed and how to restore it,
// and the tier-3 asks. POST → start a pass now, or run a tier-3 action Thomas pressed.
//
// The root is the MAIN checkout, never process.cwd() blindly: a preview server in a worktree would otherwise
// start the worktree's copy of the janitor, which may be older or half-written.
function mainRoot(): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    return path.dirname(common);
  } catch { return process.cwd(); }
}

export async function GET() {
  try {
    return Response.json({ ...snapshot(), on: readConfig().enabled && readConfig().storage });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { op } = (await req.json()) as { op?: string };
    // Whitelisted: each op is one fixed argv. Nothing from the client reaches the command line.
    const ARGS: Record<string, string[]> = {
      run: ["--why", "manual"],
      docker: ["--do", "docker", "--why", "manual"],
    };
    const args = op ? ARGS[op] : undefined;
    if (!args) return Response.json({ error: `unknown op: ${op}` }, { status: 400 });
    const started = startJanitor(mainRoot(), args);
    return Response.json({ ok: true, started, ...(started ? {} : { note: "a pass is already running" }) });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
