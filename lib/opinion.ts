// Opinion Reveal (§38): the weekly interview behind Video Studio's opinion video. Thomas, 2026-10-29: "a weekly video
// that I put my own thoughts into, based on the actual news that week" — answered here as a chat that feels like
// "friend ranting via chat… send multiple messages for a question and a finish button to wrap the answer"
// (the pick: pitch opinion-interview V2, ~/ecvision/pitches).
//
// Video Studio owns the file: `scripts/opinion.mjs draft` writes <studio>/harness/opinion/<week>/interview.json on
// Friday, `lock` closes it on Saturday noon. This page only appends his messages and sets take / lead / skip on a
// story while the interview is `open`. The take is his messages joined with nothing added (CLAUDE.md there, Never #4),
// so the wrap is done here, by code, never by a model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STUDIO = process.env.VIDEO_STUDIO_DIR || path.join(os.homedir(), "tiktok-studio");
const DIR = path.join(STUDIO, "harness", "opinion");

export type Msg = { text: string; at: string; q: 1 | 2; guess?: boolean };
export type Story = {
  id: string; tag: string; day: string; headline: string; fact: string; news: string; source: string;
  q: [string, string]; guess: string; messages: Msg[]; asked2?: boolean;
  take: string | null; confirmed: boolean; lead: boolean; skipped: boolean;
};
export type Interview = {
  week: string; range: string; opens: string; closes: string; status: "open" | "locked" | "no-video";
  minTakes: number; stories: Story[];
};

const weeks = () => (fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((w) => /^\d{4}-W\d\d$/.test(w)).sort() : []);
const fileOf = (week: string) => {
  if (!/^\d{4}-W\d\d$/.test(week)) throw new Error("bad week");
  return path.join(DIR, week, "interview.json");
};

export function current(): { interview: Interview | null; weeks: string[]; studio: string } {
  const all = weeks(), w = all.at(-1);
  const interview = w ? (JSON.parse(fs.readFileSync(fileOf(w), "utf8")) as Interview) : null;
  return { interview, weeks: all, studio: STUDIO };
}

/** "half. like the proof is public" + "but solved??" → one take, his words only: trimmed, a full stop where a line
 *  had no end mark. Nothing reworded, nothing added. */
export function joinTake(msgs: Msg[]): string {
  return msgs.map((m) => m.text.trim()).filter(Boolean).map((t) => (/[.!?…)"'”]$/.test(t) ? t : t + ".")).join(" ");
}

export type OpinionOp =
  | { op: "say"; week: string; story: string; text: string; q: 1 | 2; guess?: boolean }
  | { op: "ask2"; week: string; story: string }
  | { op: "wrap"; week: string; story: string }
  | { op: "edit"; week: string; story: string; take: string }
  | { op: "confirm"; week: string; story: string }
  | { op: "reopen"; week: string; story: string }
  | { op: "lead"; week: string; story: string; on: boolean }
  | { op: "skip"; week: string; story: string; on: boolean };

export function apply(a: OpinionOp): Interview {
  const f = fileOf(a.week);
  const iv = JSON.parse(fs.readFileSync(f, "utf8")) as Interview;
  // The studio's lock is the deadline; after it the file is the night's input and must not move under it.
  if (iv.status !== "open") throw new Error(`this week is ${iv.status === "locked" ? "locked" : "closed with no video"}`);
  const s = iv.stories.find((x) => x.id === a.story);
  if (!s) throw new Error("no such story");
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
    case "confirm": if (!s.take) throw new Error("nothing to confirm yet"); s.confirmed = true; break;
    case "reopen": s.take = null; s.confirmed = false; break;
    // One story leads the video (its line is the hook), so starring one un-stars the rest.
    case "lead": for (const x of iv.stories) x.lead = a.on && x.id === s.id; break;
    case "skip": s.skipped = a.on; if (a.on) s.lead = false; break;
  }
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(iv, null, 2) + "\n");
  fs.renameSync(tmp, f); // atomic: the studio's lock may read it at any moment
  return iv;
}
