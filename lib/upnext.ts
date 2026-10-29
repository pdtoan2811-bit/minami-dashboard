// Up next (Runners tab, 2026-10-22). Thomas: "Need to show in detail like event of uploading etc to let me know what's
// coming up next". The strip shows WHEN each runner fires; this says WHAT happens, in one time-ordered list, and puts the
// videos in it — each booked TikTok post is its own event, read from ~/tiktok-studio/uploads/<date> <Day>/.state.json
// (written by uploads.mjs; we only read it). A video that isn't booked has no time, so it goes in `waiting` with why.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Automation } from "./automations";
import { track, type AttnView } from "./attention";

const UPLOADS = process.env.MINAMI_UPLOADS_DIR || path.join(os.homedir(), "tiktok-studio", "uploads");
const CHANNEL: Record<string, string> = { en: "EN · 2 Boys 1 Company", vi: "VI · 2 Ông Cháu 1 Công Ty" };
const AUDIENCE_TZ: Record<string, { tz: string; label: string }> = { en: { tz: "America/New_York", label: "US" }, vi: { tz: "Asia/Ho_Chi_Minh", label: "VN" } };

// What the next fire will actually do, in a line. A runner not listed falls back to its description's first sentence.
const WILL: Record<string, string> = {
  "com.thomas.video-overnight": "Waits for the 00:30 lock, renders every locked video, then books the posts on TikTok",
  "com.thomas.video-evening": "Writes tomorrow's 5 video topics for the 21:30 card",
  "com.thomas.video-pitch": "Makes the day's video pitches",
  "com.thomas.minami-janitor": "Clears caches, recycles idle worktrees, samples the disk",
  "com.thomas.goal-runner": "Measures each goal and makes the day's moves",
  "com.thomas.minami-heartbeat": "Plans the day: writes /today and the vault daily note",
  "com.thomas.minami-morning": "Notification + opens /today",
  "com.thomas.video-harness-week": "Weekly video harness review, one Slack line",
  "com.thomas.video-opinion": "Drafts or locks the weekly opinion interview (/opinion)",
  "com.thomas.video-ideas-prune": "Drops expired and old ideas from the idea store",
  "com.thomas.design-kit-harness": "Weekly design-kit audit; edits nothing",
};

export type UpEvent = {
  at: string; kind: "runner" | "post" | "card";
  id?: string;              // the runner to jump to
  title: string; what: string;
  lang?: string; n?: string; // posts: channel and EN1/VI2…
  local?: string;           // posts: the slot in the audience's own time, "15:30 US"
};
/** `key`/`att`: the flag's resolve + comment state (lib/attention.ts, §34). */
export type UpWait = { day: string; n: string; lang: string; title: string; state: "held" | "not-booked" | "not-made" | "failed"; why: string; key: string; att?: AttnView };
/** `settled`: videos this panel flagged that are resolved — by Thomas, or because the studio no longer flags them. */
export type UpNext = { events: UpEvent[]; waiting: UpWait[]; settled: AttnView[]; repeating: string[]; posted: { day: string; done: number; of: number }[] };

const readJ = (f: string) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const firstSentence = (s: string) => (s.split(/(?<=[.:])\s/)[0] || s).replace(/[.:]$/, "");
const inTz = (iso: string, tz: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });

// The next local wall-clock HH:MM after `now` (the Mac runs on Vietnam time, as the plan card does).
function nextAt(hhmm: string, now: Date) {
  const [h, m] = hhmm.split(":").map(Number), d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

export function upNext(items: Automation[], now = new Date(), hours = 24): UpNext {
  const until = now.getTime() + hours * 3600e3;
  const events: UpEvent[] = [], posted: UpNext["posted"] = [];
  const waiting: Omit<UpWait, "key">[] = [];
  // what became of a video the panel used to flag, for its AUTO tick: by key, from the same state files
  const fate = new Map<string, string>();
  const off = (a: Automation) => a.status === "paused" || a.status === "not-loaded";

  for (const a of items) {
    if (off(a) || !a.nextRun || a.schedule.kind === "every") continue;
    const t = Date.parse(a.nextRun);
    if (t > until) continue;
    events.push({ at: a.nextRun, kind: "runner", id: a.id, title: a.name, what: WILL[a.id] ?? firstSentence(a.description) });
  }
  // The plan card lives inside the bot, so it has no nextRun of its own.
  const card = items.find((a) => a.id === "video-plan-card");
  if (card && !off(card)) {
    events.push({ at: nextAt("21:30", now).toISOString(), kind: "card", id: card.id, title: "Tomorrow's topics card", what: "Posts the 5 topics to your Ownego DM: tap to drop or swap" });
    events.push({ at: nextAt("00:30", now).toISOString(), kind: "card", id: card.id, title: "Plan locks", what: "No reply means go: the overnight run renders what's locked" });
  }
  const repeating = items.filter((a) => !off(a) && a.schedule.kind === "every").map((a) => `${a.name} (${a.scheduleText})`);

  // Every day folder still live (a finished day archives itself, so these are the days with work left).
  let days: string[] = [];
  try { days = fs.readdirSync(UPLOADS).filter((x) => /^\d{4}-\d{2}-\d{2} /.test(x)).sort(); } catch {}
  for (const dir of days) {
    const st = readJ(path.join(UPLOADS, dir, ".state.json"));
    if (!st?.items) continue;
    const day = dir; // "2026-10-22 Thu"
    posted.push({ day: dir, done: st.items.filter((i: any) => i.posted).length, of: st.items.length });
    for (const i of st.items) {
      const fkey = `video:${day}:${i.n}`;
      if (i.posted) { fate.set(fkey, "posted"); continue; }
      const lang = i.lang ?? "en", aud = AUDIENCE_TZ[lang];
      if (i.scheduled?.at) {
        fate.set(fkey, `booked for ${new Date(i.scheduled.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })}`);
        events.push({ at: new Date(i.scheduled.at).toISOString(), kind: "post", title: i.title, n: i.n, lang,
          what: `Goes live on ${CHANNEL[lang] ?? lang}${i.cover && !i.cover_set ? " · set the cover by hand after" : ""}`,
          local: aud ? `${inTz(i.scheduled.at, aud.tz)} ${aud.label}` : undefined });
      } else if (i.hold) {
        waiting.push({ day, n: i.n, lang, title: i.title, state: "held", why: String(i.hold) });
      } else {
        waiting.push({ day, n: i.n, lang, title: i.title, state: "not-booked", why: "Ready, but no slot on TikTok: publish didn't place it, or a sync found it failed" });
      }
    }
    for (const m of st.missing ?? []) {
      const [, num, lang = ""] = String(m.id).match(/^s(\d+)-(\w+)$/) ?? [];
      waiting.push({ day, n: num ? `${lang.toUpperCase()}${num}` : String(m.id), lang, title: m.hook ?? m.id, state: "not-made", why: String(m.why ?? "not made") });
    }
  }
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // A day folder that archived itself took its videos with it: anything still flagged from it is no longer waiting.
  const keyed = waiting.map((w) => ({ ...w, key: `video:${w.day}:${w.n}` }));
  const { flagged, settled } = track("video", keyed.map((w) => ({ key: w.key, sig: `${w.state}|${w.why}`, meta: { n: w.n, lang: w.lang, title: w.title, day: w.day } })),
    (k) => fate.get(k) ?? (days.some((d) => k.startsWith(`video:${d}:`)) ? "the studio stopped listing it" : "its day was archived"));
  return { events, waiting: keyed.map((w) => ({ ...w, att: flagged[w.key] })), settled, repeating, posted };
}
