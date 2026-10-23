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
  /** The video's title and its cover image's absolute path (the Bento publish tile shows covers, not codes). */
  title?: string; cover?: string;
  /** ISO. The slot it was aimed at while uploading; the slot it was booked into once done. */
  slot?: string; startedAt?: number; tookMs?: number;
  sent?: number; rateBps?: number; try?: number; tries?: number;
};
export type UploadProgress = {
  v: 1; kind: "upload"; label: string; pid: number; session: string | null; cwd: string;
  startedAt: number; updatedAt: number; cur: string | null; items: UploadItem[];
  /** Set only on the copy the writer keeps in done/ when it exits. */
  endedAt?: number;
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

// ── The Bento publish tile ───────────────────────────────────────────────────────────────────────────────
// Picked from the upload-place pitch, round 3, C "Delivery tracker" (2026-10-23), after the tray in the agent card
// was "somewhere you aren't looking" and a calmer tile with chips and a speed meter read as "not intuitive and ugly".
// The tile answers one thing at a time: the video uploading now, large, with its minutes left, or how late it will
// be for its post slot; the rest of the batch is a small row of covers. So this computes words-ready numbers, not
// bytes: minutes left, minutes late, and one tone.

/** What the writer keeps after it exits (`done/<pid>.json`), newest first, for `maxAgeMs`. */
export function readFinished(dir = path.join(PROGRESS_DIR, "done"), maxAgeMs = 6 * 3600e3): UploadProgress[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return []; }
  const out: UploadProgress[] = [];
  for (const f of names) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as UploadProgress;
      if (p?.kind === "upload" && Array.isArray(p.items) && p.endedAt && Date.now() - p.endedAt < maxAgeMs) out.push(p);
    } catch { /* skip */ }
  }
  return out.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
}

/** The cover of one video in one publish, live or finished: the only file path the tile's image route will open. */
export function coverOf(pid: number, n: string): string | null {
  for (const f of [path.join(PROGRESS_DIR, `${pid}.json`), path.join(PROGRESS_DIR, "done", `${pid}.json`)]) {
    try {
      const p = JSON.parse(fs.readFileSync(f, "utf8")) as UploadProgress;
      const c = p.items.find((i) => i.n === n)?.cover;
      if (c && /\.(png|jpe?g|webp)$/i.test(c)) return c;
    } catch { /* next */ }
  }
  return null;
}

export type PublishVideo = { n: string; title: string; cover: boolean; state: UploadState; why?: string; slot?: string; pct?: number; leftMin?: number; lateMin?: number };
export type Publish = {
  pid: number; label: string; session: string | null; sessionId?: string | null; live: boolean; endedAt?: number;
  /** `publish:<pid>:<startedAt>`, the key of its comments and Minami chats in the attention store (§34). */
  key: string; cwd: string;
  /** ok: on time · late: the video uploading now finishes after its slot · stuck: under 20 KB/s (the 10-19 hang ran
   *  at 12–15; a normal Post for Me upload is 44–150) · done: ended clean · trouble: ended with a failure */
  tone: "ok" | "late" | "stuck" | "done" | "trouble";
  cur: PublishVideo | null; videos: PublishVideo[];
  rateKBs: number | null; leftMin: number | null; tryNo?: number; tries?: number;
  done: number; count: number; held: number; failed: number;
};

/** Below this the upload is treated as stuck rather than slow. */
export const STUCK_KBS = 20;

export function publishOf(p: UploadProgress, now = Date.now()): Publish {
  const t = trayOf(p);
  const videos: PublishVideo[] = t.rows.map((r) => {
    const late = r.state === "uploading" && r.slot && r.leftMin != null ? Math.round((now + r.leftMin * 60e3 - Date.parse(r.slot)) / 60e3) : undefined;
    return {
      n: r.n, title: r.title || r.n, cover: !!r.cover, state: r.state, why: r.why, slot: r.slot,
      ...(r.state === "uploading" && r.size ? { pct: Math.min(100, Math.round(((r.sent ?? 0) / r.size) * 100)) } : {}),
      ...(r.leftMin != null ? { leftMin: r.leftMin } : {}),
      ...(late != null && late > 0 ? { lateMin: late } : {}),
    };
  });
  const cur = videos.find((v) => v.state === "uploading") ?? null;
  const curRow = t.rows.find((r) => r.state === "uploading");
  const live = !p.endedAt;
  const tone: Publish["tone"] = !live ? (t.failed ? "trouble" : "done")
    : cur?.lateMin ? "late" : t.rateKBs != null && t.rateKBs < STUCK_KBS ? "stuck" : "ok";
  return {
    pid: p.pid, label: p.label, session: p.session, live, endedAt: p.endedAt, key: `publish:${p.pid}:${p.startedAt}`, cwd: p.cwd, tone, cur, videos,
    rateKBs: t.rateKBs, leftMin: t.leftMin, tryNo: curRow?.try, tries: curRow?.tries,
    done: t.done, count: t.count, held: t.held, failed: t.failed,
  };
}

/** The publish as a few plain lines, for the chat Minami starts from the tile: what it is doing, video by video. */
export function publishBrief(p: Publish): string {
  const hm = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" }) : "");
  const head = p.live
    ? `Running (pid ${p.pid}), ${p.done} of ${p.count} done, ${p.rateKBs ?? "?"} KB/s${p.leftMin != null ? `, about ${Math.round(p.leftMin)} min left` : ""}, tone: ${p.tone}.`
    : `Ended ${p.endedAt ? new Date(p.endedAt).toISOString() : ""}: ${p.done} of ${p.count} posted, ${p.failed} failed, ${p.held} held.`;
  const rows = p.videos.map((v) => `- ${v.n} · ${v.title} · ${v.state}${v.slot ? ` · slot ${hm(v.slot)} (UTC+7)` : ""}${v.pct != null ? ` · ${v.pct}%` : ""}${v.lateMin ? ` · ${v.lateMin} min late` : ""}${v.why ? ` · ${v.why}` : ""}`);
  return [`${p.label}: ${head}`, ...rows].join("\n");
}
