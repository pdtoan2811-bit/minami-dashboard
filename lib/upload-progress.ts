/**
 * Upload progress from scripts that publish files, for the agent card (§33).
 *
 * A TikTok publish (`~/tiktok-studio/scripts/uploads.mjs publish`) uploads up to ten 34–143 MB masters one
 * after another at anything from 12 KB/s to 2 MB/s, and on the card it was one bash row and a clock for up to
 * an hour. The uploader always measured bytes and rate, but only to decide when to abort. It now writes
 * `~/.harness/progress/<pid>.json` (its `scripts/lib/upload-progress.mjs`), and this reads it.
 *
 * Pure apart from `readUploads()`: `trayOf()` is what the card draws, so the arithmetic (ETAs from one shared
 * rate, uploads strictly one after another) can be checked without a browser.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type UploadState = "queued" | "uploading" | "done" | "held" | "failed" | "skipped";
export type UploadItem = {
  n: string; lang?: string; size: number; state: UploadState; why?: string;
  /** ISO. The slot it was aimed at while uploading; the slot it was booked into once done. */
  slot?: string; startedAt?: number; tookMs?: number;
  sent?: number; rateBps?: number; try?: number; tries?: number;
};
export type UploadProgress = {
  v: 1; kind: "upload"; label: string; pid: number; session: string | null; cwd: string;
  startedAt: number; updatedAt: number; cur: string | null; items: UploadItem[];
};

export const PROGRESS_DIR = process.env.MINAMI_PROGRESS_DIR || path.join(os.homedir(), ".harness", "progress");

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/** Every progress file whose writer is still running. A dead writer's file is left for the next run to
 *  overwrite (pids recycle rarely enough) rather than deleted here: this is a reader, and a pid check
 *  that races a slow `exit` handler shouldn't be the thing that destroys a file. */
export function readUploads(dir = PROGRESS_DIR): UploadProgress[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  const out: UploadProgress[] = [];
  for (const f of names) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as UploadProgress;
      if (p?.kind === "upload" && Array.isArray(p.items) && alive(p.pid)) out.push(p);
    } catch { /* mid-rename or foreign: skip */ }
  }
  return out;
}

/** The repo a cwd belongs to, so a chat in a task worktree still matches a publish run from the main checkout. */
// Resolved first: a writer reports process.cwd(), which is the real path (/private/tmp on macOS) while a
// pane may hold the symlinked one (/tmp) for the same folder.
const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
const repoOf = (cwd: string) => real(cwd).replace(/\/\.minami-worktrees\/[^/]+.*$/, "").replace(/\/+$/, "");

/** The runs a chat should show: the ones its own children started (MINAMI_SESSION_KEY), or — for a writer
 *  with no key, i.e. started by a chat spawned before the variable existed — the ones in the same repo. */
export function uploadsFor(all: UploadProgress[], who: { key: string; cwd: string }): UploadProgress[] {
  return all.filter((p) => (p.session ? p.session === who.key : repoOf(p.cwd) === repoOf(who.cwd)));
}

export type TrayRow = UploadItem & { leftMin?: number; startsInMin?: number };
export type Tray = {
  label: string; rows: TrayRow[];
  done: number; count: number; held: number; failed: number;
  sentMb: number; allMb: number; rateKBs: number | null; leftMin: number | null;
};

const MB = 1e6;
/** One publish, as the batch tray draws it. Uploads run strictly one after another, so every queued item's
 *  start is the end of the one before it, all at the CURRENT rate — the one number we have that says
 *  anything about the next ten minutes. Before the first byte (no rate yet) the ETAs are null, not guessed. */
export function trayOf(p: UploadProgress): Tray {
  const cur = p.items.find((i) => i.state === "uploading");
  const rate = cur?.rateBps && cur.rateBps > 0 ? cur.rateBps : null;
  let t = 0;
  const rows: TrayRow[] = p.items.map((i) => {
    if (i.state !== "uploading" && i.state !== "queued") return { ...i };
    const left = i.state === "uploading" ? Math.max(0, i.size - (i.sent ?? 0)) : i.size;
    const startsInMin = rate ? t : undefined;
    if (rate) t += left / rate / 60;
    return { ...i, leftMin: rate ? t : undefined, ...(i.state === "queued" ? { startsInMin } : {}) };
  });
  const live = p.items.filter((i) => i.state !== "held" && i.state !== "skipped");
  const allMb = live.reduce((a, i) => a + i.size, 0) / MB;
  const sentMb = live.reduce((a, i) => a + (i.state === "done" ? i.size : i.state === "uploading" ? i.sent ?? 0 : 0), 0) / MB;
  const pending = p.items.some((i) => i.state === "uploading" || i.state === "queued");
  return {
    label: p.label, rows,
    done: p.items.filter((i) => i.state === "done").length,
    count: live.length,
    held: p.items.filter((i) => i.state === "held").length,
    failed: p.items.filter((i) => i.state === "failed").length,
    sentMb, allMb,
    rateKBs: rate ? Math.round(rate / 1e3) : null,
    leftMin: pending ? (rate ? t : null) : 0,
  };
}
