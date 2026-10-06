import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST → appends one line to ~/.minami/viewports.jsonl: what a device's browser reports for its size
// (lib/viewport-report.ts, §23). Bounded to the last 500 lines; diagnostics, never read by the app.
const FILE = path.join(os.homedir(), ".minami", "viewports.jsonl");

export async function POST(req: Request) {
  try {
    const d = await req.json();
    const line = JSON.stringify({ at: new Date().toISOString(), ...d }).slice(0, 600);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    let lines: string[] = [];
    try { lines = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean); } catch { /* first one */ }
    lines.push(line);
    fs.writeFileSync(FILE, lines.slice(-500).join("\n") + "\n");
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 400 });
  }
}
