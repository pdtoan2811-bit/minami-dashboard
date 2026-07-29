// Which view each bento topic opens in — Chat (the transcript) or Flow (the step graph).
//
// On disk, next to the icon store (lib/tech-attach.ts), rather than in localStorage: this is a
// statement about a PROJECT, not about a browser. A topic you supervise step-by-step should still be
// supervised step-by-step from the phone, and after a redeploy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type BentoView = "chat" | "flow";
export type ViewPrefs = Record<string, BentoView>;

const DIR = path.join(os.homedir(), ".minami-bento");
const STORE = path.join(DIR, "views.json");

/** Never throws: a missing or corrupt store just means "everything is Chat", which is the default
 *  anyway. A view preference is not worth failing a page render over. */
export function getViewPrefs(): ViewPrefs {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const out: ViewPrefs = {};
    for (const [k, v] of Object.entries(parsed)) if (v === "chat" || v === "flow") out[k] = v;
    return out;
  } catch { return {}; }
}

/** Read-modify-write. The file is tiny and written only on an explicit click, so the lack of locking
 *  is fine — but write to a temp file and rename, so a crash mid-write can't leave truncated JSON that
 *  the reader above would silently discard along with every OTHER project's preference. */
export function setViewPref(project: string, view: BentoView): ViewPrefs {
  const next = { ...getViewPrefs(), [project]: view };
  if (view === "chat") delete next[project]; // chat is the default — don't persist the absence of a choice
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = STORE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, STORE);
  } catch { /* best effort — the UI already applied it optimistically */ }
  return next;
}
