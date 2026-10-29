// Opinion Reveal (§38): Thomas's own takes on the AI news, for Video Studio's weekly opinion video. He opens /opinion
// whenever he likes, picks any recent story and rants about it in the chat he picked (pitch opinion-interview V2:
// "friend ranting via chat… multiple messages for a question and a finish button to wrap the answer"). Thomas,
// 2026-10-29, on the first version (one weekly interview, closed outside Fri–Sat): "should not block my access like
// this, but I can randomly visit and pick topic to read/express opinion on".
//
// Video Studio owns the topics and the lock (`scripts/opinion.mjs`): topics.json is refreshed daily from the daily
// episodes; Saturday noon the takes confirmed since the last video become that week's interview.json. This page only
// writes takes/<id>.json — one file per story, so it never races the studio's writers. The take is his messages joined
// with nothing added (Video Studio's Never #4), so the wrap is done here, by code, never by a model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STUDIO = process.env.VIDEO_STUDIO_DIR || path.join(os.homedir(), "tiktok-studio");
const DIR = path.join(STUDIO, "harness", "opinion");
const TAKES = path.join(DIR, "takes");
const MIN_TAKES = 3; // scripts/opinion.mjs MIN_TAKES
const FRESH_DAYS = 10; // scripts/opinion.mjs FRESH_DAYS: older stories no longer make a weekly video

export type Msg = { text: string; at: string; q: 1 | 2; guess?: boolean };
export type Topic = {
  id: string; source: string; day: string; dayLabel: string; tag: string; headline: string; fact: string; news: string;
  q: [string, string]; guess: string;
};
export type Take = {
  id: string; messages: Msg[]; asked2?: boolean; take: string | null; confirmed: boolean; confirmedAt?: string;
  lead: boolean; skipped: boolean; usedIn?: string; updatedAt?: string;
};
export type Story = Topic & Take;
export type Week = { waiting: number; minTakes: number; nextLock: string; fresh: string };

const blank = (id: string): Take => ({ id, messages: [], take: null, confirmed: false, lead: false, skipped: false });
const ymd = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const takeFile = (id: string) => {
  if (!/^[a-z0-9-]{3,40}$/.test(id)) throw new Error("bad topic id");
  return path.join(TAKES, `${id}.json`);
};
function readTake(id: string): Take {
  try { return { ...blank(id), ...JSON.parse(fs.readFileSync(takeFile(id), "utf8")) }; } catch { return blank(id); }
}
function writeTake(t: Take) {
  fs.mkdirSync(TAKES, { recursive: true });
  const f = takeFile(t.id), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...t, updatedAt: new Date().toISOString() }, null, 2) + "\n");
  fs.renameSync(tmp, f); // atomic: the Saturday lock may read it at any moment
}
function topics(): Topic[] {
  try { return (JSON.parse(fs.readFileSync(path.join(DIR, "topics.json"), "utf8")).topics ?? []) as Topic[]; } catch { return []; }
}
/** The coming Saturday noon (scripts/opinion.mjs nextLock). */
function nextLock(now = new Date()) {
  const d = new Date(now); d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  if (d <= now) d.setDate(d.getDate() + 7);
  return d;
}

export function list(): { stories: Story[]; week: Week; studio: string } {
  const fresh = (() => { const d = new Date(); d.setDate(d.getDate() - FRESH_DAYS); return ymd(d); })();
  const stories = topics().map((t) => ({ ...t, ...readTake(t.id) }));
  const waiting = stories.filter((s) => s.confirmed && !s.skipped && s.take?.trim() && !s.usedIn && s.day >= fresh).length;
  return { stories, week: { waiting, minTakes: MIN_TAKES, nextLock: nextLock().toISOString(), fresh }, studio: STUDIO };
}

/** "half. like the proof is public" + "but solved??" → one take, his words only: trimmed, a full stop where a line
 *  had no end mark. Nothing reworded, nothing added. */
export function joinTake(msgs: Msg[]): string {
  return msgs.map((m) => m.text.trim()).filter(Boolean).map((t) => (/[.!?…)"'”]$/.test(t) ? t : t + ".")).join(" ");
}

export type OpinionOp =
  | { op: "say"; story: string; text: string; q: 1 | 2; guess?: boolean }
  | { op: "ask2"; story: string }
  | { op: "wrap"; story: string }
  | { op: "edit"; story: string; take: string }
  | { op: "confirm"; story: string }
  | { op: "reopen"; story: string }
  | { op: "lead"; story: string; on: boolean }
  | { op: "skip"; story: string; on: boolean };

export function apply(a: OpinionOp): Story {
  const topic = topics().find((t) => t.id === a.story);
  if (!topic) throw new Error("no such topic");
  const s = readTake(topic.id);
  switch (a.op) {
    case "say": {
      const text = String(a.text ?? "").trim().slice(0, 2000);
      if (!text) throw new Error("empty message");
      s.messages.push({ text, at: new Date().toISOString(), q: a.q === 2 ? 2 : 1, ...(a.guess ? { guess: true } : {}) });
      s.skipped = false;
      break;
    }
    case "ask2": s.asked2 = true; break;
    case "wrap": s.take = joinTake(s.messages); s.confirmed = false; break;
    case "edit": s.take = String(a.take ?? "").trim().slice(0, 2000) || null; break;
    case "confirm": if (!s.take) throw new Error("nothing to confirm yet"); s.confirmed = true; s.confirmedAt = new Date().toISOString(); break;
    // a take already in a video stays as it was there; reopening starts it again for a later one
    case "reopen": s.take = null; s.confirmed = false; delete s.usedIn; break;
    case "lead":
      // one lead among the takes waiting for the next video: its line is the hook
      if (a.on) for (const o of list().stories) if (o.id !== s.id && o.lead && !o.usedIn) writeTake({ ...readTake(o.id), lead: false });
      s.lead = a.on;
      break;
    case "skip": s.skipped = a.on; if (a.on) s.lead = false; break;
  }
  writeTake(s);
  return { ...topic, ...s };
}
