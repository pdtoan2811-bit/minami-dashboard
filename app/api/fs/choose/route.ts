import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST { kind: "file" | "folder", start?: string, multiple?: boolean }
//   → { paths: string[] } | { canceled: true }
//
// The real macOS open panel, driven by osascript.
//
// ── Why this exists at all, when the browser has a file picker ────────────────────────────────────
// Because the browser's picker cannot answer the only question this app asks. `<input type="file">`
// and the File System Access API both hand back a File/handle carrying BYTES and a bare `name` — the
// absolute path is deliberately withheld from web content, and no flag brings it back. But this
// dashboard's whole composer contract (see Composer.tsx and lib/agent/images.ts) is that the textarea
// holds PATHS: the attach button inserts a path, a pasted screenshot is written to disk and its path
// inserted, and `/api/agent/send` inlines images by re-reading the paths the message mentions.
//
// So a browser picker forces a copy — the bytes get written somewhere new and Claude is pointed at a
// snapshot, not at the user's actual file. Edit it and the edit lands in a temp copy. For "attach this
// screenshot" that is fine (it is what /api/fs/paste already does). For "here is the module I want you
// to change" it is quietly wrong.
//
// osascript is the way out: the panel is the genuine AppKit one — sidebar, favourites, ⌘⇧G, search, the
// lot — and it returns a POSIX path. Bytes never move.
//
// ── Where the dialog appears ──────────────────────────────────────────────────────────────────────
// On the machine running the server, which is the point on this box but is NOT true if a pane is open
// from the phone (a documented use case — see /api/fs/list). A remote pane calling this pops a panel on
// the Mac. That's why the in-app FolderPicker stays: it is the portable one, this is the native one.
//
// ── Posture ───────────────────────────────────────────────────────────────────────────────────────
// Same as its neighbours: local-only, no auth, and it takes no path it will read on the caller's
// behalf. `start` only seeds the panel's initial directory and is ignored unless it exists. The worst a
// caller can do is make a dialog appear; nothing is read or returned until a human picks something.
const TIMEOUT_MS = 5 * 60 * 1000;

// One panel at a time. Two panes (or a double-click) would otherwise stack modal dialogs on top of each
// other, and the second one steals the keyboard from a panel the user is already typing a filename
// into. Answering "busy" is far better than that.
let inFlight = false;

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function script(kind: "file" | "folder", start: string | null, multiple: boolean): string[] {
  // `activate` targets osascript itself, which is what pulls the panel in front of the browser — a
  // dialog opened by a background process otherwise appears behind everything and reads as a hang.
  const lines = ["activate"];
  const loc = start ? ` default location (POSIX file "${esc(start)}")` : "";
  const prompt = kind === "folder" ? "Choose a folder for Claude" : "Choose file(s) for Claude";
  if (kind === "folder") {
    lines.push(`return POSIX path of (choose folder with prompt "${prompt}"${loc})`);
  } else {
    // Build one newline-joined string rather than logging per item: osascript prints a `return` value
    // to stdout, while `log` goes to stderr and would be interleaved with any warning the OS emits.
    lines.push(`set xs to (choose file with prompt "${prompt}"${loc}${multiple ? " with multiple selections allowed" : ""})`);
    lines.push(`if class of xs is not list then set xs to {xs}`);
    lines.push(`set out to ""`);
    lines.push(`repeat with x in xs`);
    lines.push(`set out to out & POSIX path of x & linefeed`);
    lines.push(`end repeat`);
    lines.push(`return out`);
  }
  return lines.flatMap((l) => ["-e", l]);
}

export async function POST(req: Request) {
  if (process.platform !== "darwin") {
    return Response.json({ error: "the native picker is macOS-only — use the in-app folder picker" }, { status: 501 });
  }
  if (inFlight) {
    return Response.json({ error: "a file panel is already open on the Mac — finish that one first" }, { status: 409 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const kind: "file" | "folder" = body?.kind === "folder" ? "folder" : "file";
    const multiple = body?.multiple !== false;
    // Only seed the panel from a directory that actually exists: AppleScript raises on a bad `default
    // location`, which would turn a stale cwd into a hard failure instead of just an unhelpful start.
    let start: string | null = null;
    const raw = typeof body?.start === "string" ? body.start : "";
    if (raw && path.isAbsolute(raw)) {
      try { if (fs.statSync(raw).isDirectory()) start = raw; } catch { /* not a usable start dir */ }
    }

    inFlight = true;
    const out = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = execFile("osascript", script(kind, start, multiple), { timeout: TIMEOUT_MS, maxBuffer: 1 << 20 },
        (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr: String(stderr || "") }));
      child.on("error", () => resolve({ code: 1, stdout: "", stderr: "could not run osascript" }));
    });

    // -128 is the OS's "user cancelled" — an ordinary outcome, not an error. Reporting it as a failure
    // would put a red message in the composer every time someone opened the panel and changed their mind.
    if (out.code !== 0) {
      if (/-128|User canceled/i.test(out.stderr)) return Response.json({ canceled: true });
      return Response.json({ error: out.stderr.trim() || "the file panel could not be opened" }, { status: 500 });
    }

    const paths = out.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
      // `choose folder` returns a trailing slash; every other path in this app is bare, and the
      // difference would show up as a duplicate the moment two of them are compared.
      .map((p) => (p.length > 1 ? p.replace(/\/$/, "") : p));
    return Response.json(paths.length ? { paths } : { canceled: true });
  } catch (e) {
    return Response.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  } finally {
    inFlight = false;
  }
}
