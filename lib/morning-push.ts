// The 07:30 push (§37): the top three threads to pick up, so the morning resume starts from the phone's
// lock screen instead of from a hunt through tiles. Measured: 19 of 30 next-day resumes landed between
// 08:00 and 11:00, and the phone is mostly a morning device.
//
// Only the live server sends it. The preview server (`npm run dev:iterate`, which also disables
// autopilot) loads this module too, and two servers would push the digest twice.
const AT = { h: 7, m: 30 };
const G = globalThis as unknown as { __minamiMorning?: NodeJS.Timeout };

function msUntilNext(): number {
  const now = new Date();
  const t = new Date(now);
  t.setHours(AT.h, AT.m, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime() - now.getTime();
}

async function send() {
  try {
    // Over the local API rather than importing lib/threads: instrumentation is compiled for every
    // runtime, and pulling the session parser into its graph broke the build (node:child_process).
    const { broadcast } = await import("@/lib/push/server");
    const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/threads`);
    const top = ((await r.json())?.threads ?? []).slice(0, 3) as { state: string; project: string; title: string }[];
    if (!top.length) return;
    const body = top.map((t) => `${t.state === "waiting" ? "● " : ""}${t.project}: ${t.title}`).join("\n");
    broadcast("Pick up where you left off", body, "/", "minami-morning");
  } catch (e) { console.warn("[morning] push failed:", e); }
}

export function startMorningPush() {
  if (process.env.MINAMI_AUTOPILOT_DISABLE === "1" || process.env.MINAMI_MORNING_PUSH === "0") return;
  if (G.__minamiMorning) return;
  const arm = () => { G.__minamiMorning = setTimeout(() => { void send(); arm(); }, msUntilNext()); G.__minamiMorning.unref?.(); };
  arm();
}
