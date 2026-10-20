import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST → one line per chat link the board tried to open (`/?open=`, the drawer, a push tap): was the
// chat in the list, did it open (app/page.tsx, settleOpen). The phone can't be watched from the Mac,
// so this is how "I tapped it and nothing happened" gets a cause. Last 300 lines; never read by the app.
const FILE = path.join(os.homedir(), ".minami", "open.jsonl");

export async function POST(req: Request) {
  try {
    const d = await req.json();
    const line = JSON.stringify({ at: new Date().toISOString(), ua: (req.headers.get("user-agent") || "").slice(0, 80), ...d }).slice(0, 400);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    let lines: string[] = [];
    try { lines = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean); } catch { /* first one */ }
    lines.push(line);
    fs.writeFileSync(FILE, lines.slice(-300).join("\n") + "\n");
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 400 });
  }
}
