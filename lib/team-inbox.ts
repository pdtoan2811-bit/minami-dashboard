// The team inbox (§25): questions a teammate's Claude sent you through team-ask, readable and
// answerable from the dashboard instead of only from a Slack card on your phone.
//
// This reverses a line in lib/team-forward.ts ("the dashboard has no Slack of its own") on purpose.
// That rule was about ASKING: a session already holds team-ask as an MCP server, so asking through it
// is free. ANSWERING has no such path — team-ask has no tool that answers a card sitting in your own
// DM — and the reason to read here at all is the AI chat beside the card, which Slack can't give you.
//
// It stays a thin client of team-ask's own protocol, never a second implementation of it:
//   READ   the bot's DM with you (conversations.history, include_all_metadata). Every card carries
//          `cc_team_ask_question` metadata whose `ctx` is the full ContextSpec — the same object the
//          📖 modal is rebuilt from — so nothing is scraped out of rendered blocks except open/closed.
//   ANSWER a `cc_team_ask_answer` relay in the card's thread. That is the message team-ask itself
//          writes when a click lands on a machine that doesn't own the topic; the owning machine
//          reconciles it within ~20s whichever machine wrote it. So the dashboard is just one more
//          "other machine", and team-ask needs no change to accept it.
//
// Plain DMs and attached files are a different matter: the bot can't read a DM between two humans,
// and it has no files:read. Both are gated on an optional user token (SLACK_USER_TOKEN, scopes
// im:history + files:read + chat:write) and the UI says exactly which permission is missing rather
// than showing an empty list that looks like "nobody wrote".
//
// Tokens are read from team-ask's .env (or the environment) and never logged, returned or echoed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEAM_ASK_DIR = process.env.MINAMI_TEAM_ASK_DIR || path.join(os.homedir(), "dev", "team-ask");
const QUESTION_EVENT = "cc_team_ask_question";
const RELAY_EVENT = "cc_team_ask_answer";
const SUBMIT_ACTION = "answer_submit"; // team-ask's ACTION_SUBMIT — present only while a card is open
const CACHE_MS = 20_000; // team-ask reconciles every ~20s; polling Slack faster buys nothing
const CARD_DAYS = 14;
const DM_DAYS = 7;

export type TeamQuestion = { q: string; options: { label: string; description: string }[]; rec?: string; reason?: string };
export type TeamFile = { name: string; lines: number; text: string };
export type TeamCard = {
  ts: string; at: number; asker: string; askerKey: string; topic: string; headline?: string; repo: string; context: string;
  doing?: string; whyNow?: string; blocking?: string; settled?: string[]; kind?: "ask" | "review"; review?: { ask: string; steps?: string[] };
  questions: TeamQuestion[]; files: TeamFile[];
  /** open: waiting on you · sent: you answered here, team-ask hasn't picked it up yet · answered · expired */
  state: "open" | "sent" | "answered" | "expired";
  summary?: string;
};
export type DmFile = { id: string; name: string; mimetype: string; size: number };
export type TeamDm = { ts: string; at: number; from: string; fromKey: string; channel: string; text: string; files: DmFile[] };
export type TeamInbox = {
  ok: boolean; reason?: string;
  cards: TeamCard[];
  dms: TeamDm[];
  /** What is switched off, in words the UI can show as-is. Empty = everything works. */
  gates: { dms?: string; files?: string };
};
export type Answer = { picked: string[]; text?: string } | null;

type Member = { key: string; name: string; slack?: string };
type Conf = { bot?: string; user?: string; meKey?: string; me?: Member; team: Member[] };

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(path.join(TEAM_ASK_DIR, ".env"), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* no team-ask on this machine */ }
  return out;
}

function conf(): Conf {
  const env = readEnv();
  let team: Member[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(TEAM_ASK_DIR, env.TEAM_FILE || "team.json"), "utf8"));
    if (Array.isArray(raw)) team = raw.filter((m) => m?.key).map((m) => ({ key: m.key, name: m.name || m.key, slack: m.slack }));
  } catch { /* empty roster */ }
  const meKey = process.env.MINAMI_ASK_ME || env.CC_ASK_ME;
  return {
    bot: process.env.SLACK_BOT_TOKEN || env.SLACK_BOT_TOKEN,
    // Separate name first so a box can hold a user token for the dashboard without team-ask seeing it.
    user: process.env.MINAMI_SLACK_USER_TOKEN || env.MINAMI_SLACK_USER_TOKEN || env.SLACK_USER_TOKEN,
    meKey, me: team.find((m) => m.key === meKey), team,
  };
}

type SlackRes = { ok: boolean; error?: string; needed?: string; [k: string]: unknown };
async function slack(method: string, token: string, params: Record<string, unknown>, json = false): Promise<SlackRes> {
  const r = await fetch(`https://slack.com/api/${method}`, json
    ? { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(params) }
    : { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  return (await r.json()) as SlackRes;
}
const missing = (r: SlackRes) => (r.error === "missing_scope" ? `the Slack token lacks ${r.needed || "a scope"}` : r.error || "Slack error");

// ── reading the cards ────────────────────────────────────────────────────────────────────────────
type Msg = { ts: string; user?: string; bot_id?: string; text?: string; reply_count?: number; latest_reply?: string; blocks?: Block[]; metadata?: { event_type?: string; event_payload?: Record<string, unknown> }; files?: { id: string; name?: string; title?: string; mimetype?: string; size?: number }[] };
type Block = { type: string; text?: { text?: string }; elements?: Block[] & { action_id?: string; text?: string }[]; action_id?: string };

const hasSubmit = (blocks: Block[] = []) => JSON.stringify(blocks).includes(`"${SUBMIT_ACTION}"`);
const plain = (b?: Block) => (b?.text?.text || "").trim();

/** The files team-ask attaches to a card go into its thread as text — a header section
 *  (":page_facing_up: *name* · N dòng") followed by rich_text_preformatted chunks — so the bot's own
 *  im:history reads them in full and no files:read is needed for these. */
function filesOf(replies: Msg[]): TeamFile[] {
  const out: TeamFile[] = [];
  for (const m of replies) {
    const head = plain(m.blocks?.[0]);
    if (!head.startsWith(":page_facing_up:")) continue;
    const name = /\*(.+?)\*/.exec(head)?.[1] || "file";
    const lines = Number(/·\s*(\d+)/.exec(head)?.[1] || 0);
    const text = (m.blocks || []).slice(1).map((b) => (b.elements || []).map((e) => ((e as Block).elements || []).map((x) => (x as { text?: string }).text || "").join("")).join("")).join("");
    out.push({ name, lines, text });
  }
  return out;
}

let channelCache: { bot?: string; dm: Record<string, string> } = { dm: {} };
let inboxCache: { at: number; data: TeamInbox } | null = null;
const repliesCache = new Map<string, { latest: string; replies: Msg[] }>();
/** Answers sent from here but not yet reconciled — shown as "sent" until the card closes. */
const sentHere = new Set<string>();
/** Only files that appeared in a DM we listed may be proxied — /api/team/file is not a general Slack fetcher. */
const allowedFiles = new Set<string>();

async function botChannel(c: Conf): Promise<string> {
  if (channelCache.bot) return channelCache.bot;
  const r = await slack("conversations.open", c.bot!, { users: c.me!.slack! });
  if (!r.ok) throw new Error(missing(r));
  channelCache.bot = (r.channel as { id: string }).id;
  return channelCache.bot;
}

async function replies(token: string, channel: string, m: Msg): Promise<Msg[]> {
  const latest = m.latest_reply || m.ts;
  const hit = repliesCache.get(m.ts);
  if (hit && hit.latest === latest) return hit.replies;
  const r = await slack("conversations.replies", token, { channel, ts: m.ts, limit: 100, include_all_metadata: true });
  const list = r.ok ? ((r.messages as Msg[]) || []).slice(1) : [];
  repliesCache.set(m.ts, { latest, replies: list });
  return list;
}

function cardOf(m: Msg, thread: Msg[], meSlack: string, team: Member[]): TeamCard | null {
  const p = m.metadata?.event_payload || {};
  let ctx: Partial<TeamCard> & { questions?: TeamQuestion[] } = {};
  try { ctx = JSON.parse(String(p.ctx || "{}")); } catch { /* an older card without ctx */ }
  const open = hasSubmit(m.blocks);
  const head = plain(m.blocks?.[0]) + " " + (m.blocks?.[0]?.elements || []).map((e) => (e as { text?: string }).text || "").join(" ");
  const relayed = thread.some((r) => r.metadata?.event_type === RELAY_EVENT && r.metadata.event_payload?.ts === m.ts && r.metadata.event_payload?.by === meSlack);
  const state: TeamCard["state"] = open ? (relayed || sentHere.has(m.ts) ? "sent" : "open") : head.includes(":hourglass:") ? "expired" : "answered";
  if (!open) sentHere.delete(m.ts);
  return {
    ts: m.ts, at: Math.round(Number(m.ts) * 1000),
    asker: String(ctx.asker || team.find((t) => t.key === p.asker)?.name || p.asker || "a teammate"), askerKey: String(p.asker || ""),
    topic: String(ctx.topic || p.topic || "Question"), headline: ctx.headline, repo: String(ctx.repo || ""), context: String(ctx.context || ""),
    doing: ctx.doing, whyNow: ctx.whyNow, blocking: ctx.blocking, settled: ctx.settled, kind: ctx.kind, review: ctx.review,
    questions: Array.isArray(ctx.questions) ? ctx.questions : [],
    files: filesOf(thread),
    state,
    summary: open ? undefined : (m.text || "").replace(/^:[a-z_]+:\s*/, "").slice(0, 200),
  };
}

async function readDms(c: Conf, gates: TeamInbox["gates"]): Promise<TeamDm[]> {
  if (!c.user) {
    gates.dms = "Plain messages need a Slack user token (scopes im:history, chat:write) — set SLACK_USER_TOKEN in team-ask's .env.";
    gates.files = "Files sent as attachments need files:read on that same user token.";
    return [];
  }
  const out: TeamDm[] = [];
  const oldest = Date.now() / 1000 - DM_DAYS * 86400;
  for (const m of c.team.filter((x) => x.key !== c.meKey && x.slack)) {
    try {
      let ch = channelCache.dm[m.key];
      if (!ch) {
        const r = await slack("conversations.open", c.user, { users: m.slack! });
        if (!r.ok) { gates.dms = `Can't open DMs: ${missing(r)}.`; return out; }
        ch = channelCache.dm[m.key] = (r.channel as { id: string }).id;
      }
      const h = await slack("conversations.history", c.user, { channel: ch, limit: 30, oldest });
      if (!h.ok) { gates.dms = `Can't read DMs: ${missing(h)}.`; return out; }
      for (const msg of (h.messages as Msg[]) || []) {
        if (msg.user !== m.slack) continue; // their side only — your own replies are context Slack already shows
        const files = (msg.files || []).map((f) => ({ id: f.id, name: f.name || f.title || "file", mimetype: f.mimetype || "", size: f.size || 0 }));
        files.forEach((f) => allowedFiles.add(f.id));
        out.push({ ts: msg.ts, at: Math.round(Number(msg.ts) * 1000), from: m.name, fromKey: m.key, channel: ch, text: msg.text || "", files });
      }
    } catch (e) {
      gates.dms = `Can't reach Slack: ${(e as Error).message}`;
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function teamInbox(force = false): Promise<TeamInbox> {
  if (!force && inboxCache && Date.now() - inboxCache.at < CACHE_MS) return inboxCache.data;
  const c = conf();
  const empty = (reason: string): TeamInbox => ({ ok: false, reason, cards: [], dms: [], gates: {} });
  if (!c.bot) return empty("team-ask isn't set up on this machine (no SLACK_BOT_TOKEN).");
  if (!c.me?.slack) return empty("team-ask doesn't know who you are — set CC_ASK_ME to your key in team.json.");
  const gates: TeamInbox["gates"] = {};
  try {
    const channel = await botChannel(c);
    const h = await slack("conversations.history", c.bot, { channel, limit: 80, include_all_metadata: true, oldest: Date.now() / 1000 - CARD_DAYS * 86400 });
    if (!h.ok) return empty(`Can't read the team-ask DM: ${missing(h)}.`);
    const cards: TeamCard[] = [];
    for (const m of ((h.messages as Msg[]) || []).filter((x) => x.metadata?.event_type === QUESTION_EVENT)) {
      // Only open cards need their thread (files, a relay already sent); closed ones are history.
      const thread = hasSubmit(m.blocks) && m.reply_count ? await replies(c.bot, channel, m) : [];
      const card = cardOf(m, thread, c.me.slack, c.team);
      if (card) cards.push(card);
    }
    const dms = await readDms(c, gates);
    const data: TeamInbox = { ok: true, cards, dms, gates };
    inboxCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    return empty(`Can't reach Slack: ${(e as Error).message}`);
  }
}

export async function findCard(ts: string): Promise<TeamCard | null> {
  return (await teamInbox()).cards.find((x) => x.ts === ts) || null;
}
export async function findDm(ts: string): Promise<TeamDm | null> {
  return (await teamInbox()).dms.find((x) => x.ts === ts) || null;
}

/** Answer a card exactly as a click on another machine would: a relay in its thread. One Answer per
 *  question, in order; `null` leaves a question unanswered. */
export async function answerCard(ts: string, answers: Answer[], generalText?: string): Promise<{ ok: boolean; error?: string }> {
  const c = conf();
  if (!c.bot || !c.me?.slack) return { ok: false, error: "team-ask isn't set up on this machine" };
  const card = await findCard(ts);
  if (!card) return { ok: false, error: "That question is gone — withdrawn or older than two weeks." };
  if (card.state === "answered" || card.state === "expired") return { ok: false, error: `Already ${card.state}.` };
  const norm = card.questions.map((_, i) => {
    const a = answers[i];
    if (!a) return null;
    const picked = (a.picked || []).filter((l) => typeof l === "string");
    const text = typeof a.text === "string" && a.text.trim() ? a.text.trim() : undefined;
    return picked.length || text ? { picked, ...(text ? { text } : {}) } : null;
  });
  if (norm.every((a) => !a) && !generalText?.trim()) return { ok: false, error: "Nothing picked." };
  const human = norm.map((a) => [a?.picked.join(", "), a?.text].filter(Boolean).join(" — ") || "-").join(" | ");
  const channel = await botChannel(c);
  const r = await slack("chat.postMessage", c.bot, {
    channel, thread_ts: ts,
    text: `:white_check_mark: <@${c.me.slack}> answered from Minami: ${human}`,
    metadata: { event_type: RELAY_EVENT, event_payload: { ts, answers_json: JSON.stringify(norm), general_text: generalText?.trim() || "", by: c.me.slack, at: Date.now() } },
  }, true);
  if (!r.ok) return { ok: false, error: missing(r) };
  sentHere.add(ts);
  inboxCache = null;
  return { ok: true };
}

/** Reply to a teammate's plain DM, as you (user token). */
export async function replyDm(ts: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const c = conf();
  if (!c.user) return { ok: false, error: "Replying needs a Slack user token with chat:write." };
  const dm = await findDm(ts);
  if (!dm) return { ok: false, error: "That message isn't in the inbox any more." };
  const r = await slack("chat.postMessage", c.user, { channel: dm.channel, text }, true);
  if (!r.ok) return { ok: false, error: missing(r) };
  inboxCache = null;
  return { ok: true };
}

/** Stream a DM attachment through the server — the browser can't send the token itself. */
export async function fetchFile(id: string): Promise<Response> {
  const c = conf();
  if (!c.user) return new Response("needs a Slack user token with files:read", { status: 403 });
  if (!allowedFiles.has(id)) return new Response("unknown file", { status: 404 });
  const info = await slack("files.info", c.user, { file: id });
  if (!info.ok) return new Response(missing(info), { status: 403 });
  const f = info.file as { url_private_download?: string; url_private?: string; mimetype?: string; name?: string };
  const url = f.url_private_download || f.url_private;
  if (!url) return new Response("no download url", { status: 404 });
  const r = await fetch(url, { headers: { authorization: `Bearer ${c.user}` } });
  return new Response(r.body, { status: r.status, headers: { "content-type": f.mimetype || "application/octet-stream", "content-disposition": `inline; filename="${encodeURIComponent(f.name || id)}"`, "cache-control": "private, max-age=300" } });
}

/** The first message of an Explain chat: everything the card carries, plus the instruction to help
 *  you decide — not to decide for you, and not to answer through team-ask (the dashboard sends it). */
export function explainPrompt(card: TeamCard): string {
  const L: string[] = [];
  L.push(`${card.asker}'s Claude asked me this through team-ask (Slack). Help me understand it and decide — I'll send the answer myself from the dashboard, so do NOT call ask_team or check_team_answers, and don't post anything to Slack.`);
  L.push(`\n# ${card.headline || card.topic}\nRepo: ${card.repo || "?"}${card.context ? ` · ${card.context}` : ""}`);
  if (card.doing) L.push(`\n## What they're doing\n${card.doing}`);
  if (card.whyNow) L.push(`\n## Why they're asking me\n${card.whyNow}`);
  if (card.blocking) L.push(`\n## What it blocks\n${card.blocking}`);
  if (card.settled?.length) L.push(`\n## Already settled (not reopened)\n${card.settled.map((s) => `- ${s}`).join("\n")}`);
  if (card.review) L.push(`\n## Review asked\n${card.review.ask}${card.review.steps?.length ? "\n" + card.review.steps.map((s, i) => (/^\d+[.)]/.test(s) ? s : `${i + 1}. ${s}`)).join("\n") : ""}`);
  card.questions.forEach((q, i) => {
    L.push(`\n## Question ${i + 1}: ${q.q}`);
    q.options.forEach((o) => L.push(`- **${o.label}**${o.label === q.rec ? " ⭐ (their recommendation)" : ""} — ${o.description}`));
    if (q.reason) L.push(`Their reasoning: ${q.reason}`);
  });
  for (const f of card.files) L.push(`\n## Attached: ${f.name} (${f.lines} lines)\n\`\`\`\n${f.text.slice(0, 20000)}\n\`\`\``);
  L.push(`\nStart with: what is actually being decided, in two or three plain sentences; then for each question what each option means for ME and what you'd pick and why. If this folder has the code it touches, check it before you answer.`);
  return L.join("\n");
}

export function explainDmPrompt(dm: TeamDm): string {
  const files = dm.files.length ? `\n\nAttached: ${dm.files.map((f) => f.name).join(", ")} (open them in the dashboard's inbox if you need the contents pasted here).` : "";
  return `${dm.from} sent me this on Slack. Explain what they're asking or telling me, what they need from me, and draft a short reply I could send. Don't post anything to Slack yourself.\n\n> ${dm.text.replace(/\n/g, "\n> ")}${files}`;
}
