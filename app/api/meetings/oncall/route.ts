// POST /api/meetings/oncall — open the On Call launcher (bin/Minami Call.command) in a Terminal window
// on this Mac: the Google Meet bot path, the "Send the bot →" link under the laptop start bar.
//
// ⚠️ THROUGH `open`, NEVER AS A CHILD. The launcher runs a whole call (app :3011, receiver, tunnel,
// bot). Spawned directly it would be a child of next-server, and the next deploy would kill a live
// client meeting. `open` hands the file to LaunchServices, so Terminal owns it and the dashboard can
// restart underneath. The launcher stays interactive (template, context, the Meet link), so nothing
// from the request reaches it — there is no argument to inject into.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function POST() {
  const file = path.join(process.cwd(), "bin", "Minami Call.command");
  if (!existsSync(file)) return Response.json({ ok: false, error: "bin/Minami Call.command not found" }, { status: 404 });
  const ok = await new Promise<boolean>((done) => {
    const p = spawn("open", [file], { stdio: "ignore", detached: true });
    p.on("error", () => done(false));
    p.on("exit", (code) => done(code === 0));
    p.unref();
  });
  return ok
    ? Response.json({ ok: true })
    : Response.json({ ok: false, error: "could not open the launcher" }, { status: 500 });
}
