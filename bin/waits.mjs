#!/usr/bin/env node
// Who holds every open task's next move, in one glance (§37). The text twin of the board's lanes.
//
// Thomas, 2026-10-29: "check the latest logs task and subtask waiting. I got confused fast". Answering it
// took ad-hoc python over /api/threads, five chats' transcripts and three worktrees' git status. This prints
// the same `wait` the board groups by (lib/threads.ts), so a chat asked "what's waiting?" runs one command.
//
//   node bin/waits.mjs [--port 3000] [--all]     --all adds paused tasks
const args = process.argv.slice(2);
const port = args.includes("--port") ? args[args.indexOf("--port") + 1] : process.env.PORT || "3000";
const all = args.includes("--all");

const LANES = [
  ["you", "✋ YOU"],
  ["machine", "⏳ RUNNING"],
  ["task", "↪ ANOTHER TASK"],
  ["paused", "· PAUSED"],
  ["done", "✓ DONE, CLOSING"],
];

const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

let d;
try { d = await (await fetch(`http://127.0.0.1:${port}/api/threads`)).json(); }
catch (e) { console.error(`✗ dashboard not answering on :${port} (${e.message})`); process.exit(1); }

const open = d.threads.filter((t) => t.state !== "queued");
const n = (h) => open.filter((t) => t.wait?.holder === h).length;
console.log(`${n("you")} need you · ${n("machine")} running · ${n("task")} stuck on another task · ${n("paused")} paused · ${n("done")} done`);
for (const [h, label] of LANES) {
  if (h === "paused" && !all) continue;
  const rows = open.filter((t) => t.wait?.holder === h);
  if (!rows.length) continue;
  console.log(`\n${label}`);
  for (const t of rows) {
    const met = t.dod?.length ? ` ${t.dod.filter((x) => x.done).length}/${t.dod.length}` : "";
    console.log(`  ${clip(t.title, 48).padEnd(48)}${met.padEnd(5)} ${ago(t.at).padStart(4)}  ${t.project}`);
    console.log(`      ${t.step && h === "you" ? "✋ " + t.step.q : t.wait.what}${t.wait.detail ? " · " + t.wait.detail : ""}`);
  }
}
