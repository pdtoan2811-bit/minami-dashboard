import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isBusy, liveActivity, liveStats, sendMessage } from "@/lib/agent/manager";
import { getSession, listSessions, topicOf } from "@/lib/claude-sessions";
import { primeRepoState } from "@/lib/repo-state";
import { botPost, botReact, findCard, minamiPrompt, myThreadReplies, type TeamCard } from "@/lib/team-inbox";

/** The folder to talk about a question in: the local checkout of the repo it names, so the chat can read
 *  the code being asked about. team-ask sends only the repo's basename, so match that against the
 *  folders you've actually worked in (newest first), skipping worktrees — a recycled one may vanish
 *  under the chat. Home when nothing matches; the card's own text is still the whole question. */
export function folderFor(repo: string): string {
  if (repo) {
    for (const s of listSessions().sort((a, b) => b.lastActivity - a.lastActivity)) {
      if (!s.cwd || topicOf(s.cwd).isolatedAs) continue;
      if (path.basename(s.cwd) === repo && fs.existsSync(s.cwd)) return s.cwd;
    }
    for (const guess of [path.join(os.homedir(), repo), path.join(os.homedir(), "dev", repo)]) if (fs.existsSync(guess)) return guess;
  }
  return os.homedir();
}

/** Start a dashboard chat with its first message already in it and return the session id (§25). The
 *  session is born server-side because a pane has no way to start with a message in it; once `init`
 *  lands the manager aliases it to `live:<id>`, which is what a pane opened on that id attaches to. The
 *  id arrives a second or two after spawn, so wait here — the client gets one answer instead of
 *  polling for a session it can't name yet. */
export async function startTeamChat(key: string, cwd: string, message: string): Promise<string | null> {
  await primeRepoState(cwd).catch(() => null);
  let { sessionId } = sendMessage({ key, cwd, message });
  for (let i = 0; !sessionId && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    sessionId = liveStats().details.find((d) => d.key === key)?.sessionId ?? null;
  }
  return sessionId ?? null;
}

// ── "Để Minami trả lời" ──────────────────────────────────────────────────────────────────────────
// One Minami chat per card, remembered on disk. The button is a link, and a link gets clicked twice, opened
// on the phone and then the Mac, reloaded: each of those must land on the chat that already exists,
// never start a second one. On disk rather than in memory because a deploy restarts the server between
// the click and the second look — and because the Slack bridge below has to pick its threads back up.
const FILE = path.join(os.homedir(), ".minami", "team-minami.json");
type Talk = {
  sessionId: string; at: number;
  // The Slack talk thread (absent on chats from before it existed: those auto-answered, nothing to bridge).
  key?: string; cwd?: string; thread?: string;
  /** Newest of your thread replies already handed to the chat. */
  seen?: string;
  /** `ended.at` of the newest turn already posted to the thread. */
  posted?: number;
  done?: boolean;
};
type Seen = Record<string, Talk>;
const readSeen = (): Seen => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")) as Seen; } catch { return {}; } };
function patch(ts: string, p: Partial<Talk>): void {
  const seen = readSeen();
  seen[ts] = { ...seen[ts], ...p } as Talk;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(seen, null, 1));
}

// Two clicks that arrive together (Slack opens the link, the phone retries) both find nothing on disk
// before either has a session id to write; the in-flight promise makes the second wait for the first.
const starting = new Map<string, Promise<string | null>>();

/** The chat already on this card, if a click started one (or is starting one right now). */
export async function minamiChatFor(ts: string): Promise<string | null> {
  return readSeen()[ts]?.sessionId ?? (await starting.get(ts)) ?? null;
}

export async function minamiAnswers(card: TeamCard): Promise<{ sessionId: string | null; fresh: boolean }> {
  const had = await minamiChatFor(card.ts);
  if (had) return { sessionId: had, fresh: false };
  const p = (async () => {
    const port = process.env.PORT || "3000";
    const key = `team-minami-${card.ts.replace(/\D/g, "")}`;
    const cwd = folderFor(card.repo);
    // The thread first, so your replies have somewhere to go while the first explanation is still being
    // written. Posting failing isn't fatal: the chat still works in the dashboard.
    const head = await botPost(`:robot_face: *Minami đang đọc câu hỏi của ${card.asker}* — ${card.headline || card.topic}\nTrả lời trong thread này để hỏi thêm. Khi muốn gửi, nói "trả lời đi" (kèm lựa chọn nếu có).`).catch(() => null);
    const sid = await startTeamChat(key, cwd, minamiPrompt(card, `http://127.0.0.1:${port}`));
    if (sid) {
      patch(card.ts, { sessionId: sid, at: Date.now(), key, cwd, ...(head?.ok && head.ts ? { thread: head.ts, seen: head.ts, posted: 0 } : {}) });
      startMinamiBridge();
    }
    return sid;
  })();
  starting.set(card.ts, p);
  try { return { sessionId: await p, fresh: true }; } finally { starting.delete(card.ts); }
}

// ── the Slack bridge ─────────────────────────────────────────────────────────────────────────────
// Carries the talk between the thread and the chat: a finished turn goes up, your replies come down.
// Polls, for the reason lib/agents/runner.ts gives: a server-side subscribe() counts as a connected
// client and switches off the idle reaper and the unanswered-prompt backstop. Slack has no push to
// this process either — team-ask's socket belongs to whichever machine Slack picks, not to us.
const POLL_MS = 5_000;
const CARD_EVERY_MS = 60_000;
const SLACK_MAX = 3_800;
const lastCardCheck = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;
let ticking = false;

/** Start the bridge if any thread is still open. Idempotent; called at boot and when a talk starts. */
export function startMinamiBridge(): void {
  if (timer) return;
  if (!Object.values(readSeen()).some((t) => t.thread && !t.done)) return;
  timer = setInterval(() => { void tick(); }, POLL_MS);
  timer.unref?.();
}

/** Claude's markdown → Slack mrkdwn, enough for a phone: bold, headings, links. */
function mrkdwn(t: string): string {
  return t.replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^#{1,6}\s+(.+)$/gm, "*$1*").replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<$2|$1>");
}

function lastAssistantText(sessionId: string): string {
  try {
    const page = getSession(sessionId);
    for (let i = page.turns.length - 1; i >= 0; i--) {
      const t = page.turns[i];
      if (t.role === "assistant" && t.text.trim()) return t.text.trim();
    }
  } catch { /* transcript not readable yet */ }
  return "";
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const all = readSeen();
    const live = Object.entries(all).filter(([, t]) => t.thread && !t.done);
    if (!live.length) { if (timer) clearInterval(timer); timer = null; return; }
    const act = liveActivity();
    for (const [cardTs, t] of live) {
      try { await step(cardTs, t, act); } catch (e) { console.error("[minami] team talk bridge:", cardTs, e); }
    }
  } finally { ticking = false; }
}

async function step(cardTs: string, t: Talk, act: ReturnType<typeof liveActivity>): Promise<void> {
  const thread = t.thread!;
  // A finished turn not yet posted. The session id can move on a resume, so look it up by key too.
  const sid = liveStats().details.find((d) => d.key === t.key)?.sessionId || t.sessionId;
  if (sid !== t.sessionId) patch(cardTs, { sessionId: sid });
  const tile = act[sid];
  if (tile?.ended && !tile.busy && tile.ended.at > (t.posted || 0)) {
    const text = tile.ended.ok ? lastAssistantText(sid) : `:warning: Lượt này bị lỗi (${tile.ended.error || "unknown"}). Nhắn lại trong thread để thử lại.`;
    if (text) for (let i = 0; i < text.length; i += SLACK_MAX) await botPost(mrkdwn(text.slice(i, i + SLACK_MAX)), thread);
    patch(cardTs, { posted: tile.ended.at });
  }

  // Your replies, handed over one batch at a time and only between turns: a message sent mid-turn
  // would be a second prompt racing the first.
  if (!isBusy(t.key!)) {
    const mine = await myThreadReplies(thread, t.seen || thread);
    if (mine.length) {
      const message = mine.map((m) => `[Slack] ${m.text}`).join("\n\n");
      patch(cardTs, { seen: mine[mine.length - 1].ts });
      try {
        sendMessage({ key: t.key!, cwd: t.cwd || os.homedir(), message, resume: sid });
      } catch (e) {
        // The manager refuses when this conversation is live under another key (you resumed it in a
        // pane). Say so once rather than retrying the same refusal every five seconds.
        await botPost(`:warning: Chưa chuyển được: ${(e as Error).message}`, thread);
        return;
      }
      for (const m of mine) await botReact(m.ts, "eyes");
    }
  }

  // The card closed (sent from here, answered on the card, expired): say so once and stop watching.
  if (Date.now() - (lastCardCheck.get(cardTs) || 0) > CARD_EVERY_MS) {
    lastCardCheck.set(cardTs, Date.now());
    const card = await findCard(cardTs);
    if (!card || card.state === "answered" || card.state === "expired") {
      if (!isBusy(t.key!)) {
        await botPost(card?.state === "expired" ? ":hourglass: Câu hỏi đã hết hạn — dừng theo dõi thread này." : ":white_check_mark: Câu hỏi đã được trả lời — dừng theo dõi thread này.", thread);
        patch(cardTs, { done: true });
      }
    }
  }
}
