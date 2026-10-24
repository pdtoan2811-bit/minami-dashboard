// Growth (§35): traffic → signup → paid by traffic source, from PostHog, pulled once a day and cached on
// disk. The page reads the cache, so it opens instantly on the phone and never waits on PostHog; the
// first request after the local date changes pulls a fresh copy (and the page can force one).
//
// Read-only: it only ever POSTs HogQL to PostHog's /query endpoint with a personal API key.
// Attribution is FIRST TOUCH (the person's $initial_referring_domain, else the event's referrer), so a
// person's visit, signup and payment all land on the same source and the ledger's rates are coherent.
// Uniques are counted per window with separate queries: summing daily uniques would count a person
// who came on three days three times.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Step = { visitors: number; signups: number | null; paid: number | null };
export type GrowthSource = { key: string; name: string; days: Step[]; week: Step; prev: Step };
export type Growth = {
  pulledAt: string;
  site: string;
  /** ISO dates, oldest first; the last one is today (partial). */
  dates: string[];
  /** The PostHog event names counted as a signup / a payment, or null when none is tracked yet. */
  events: { signup: string | null; paid: string | null };
  /** First is "All"; then sources by this week's traffic. */
  sources: GrowthSource[];
  error?: string;
};

const FILE = process.env.MINAMI_GROWTH_FILE || path.join(os.homedir(), ".minami", "growth.json");
const DAYS = 14;
// Common names, tried in order when MINAMI_GROWTH_SIGNUP_EVENT / _PAID_EVENT aren't set. ecvision
// tracks neither yet (24 Oct 2026: only $pageview and $identify), so both start as "not tracked".
const SIGNUP_GUESS = ["user_signed_up", "signed_up", "sign_up", "signup", "user signed up", "Signed Up"];
const PAID_GUESS = ["subscription_created", "subscription_started", "payment_succeeded", "checkout_completed", "purchase", "order_completed", "paid"];

type Conf = { key: string; project: string; host: string };

/** Env first; else KEY=VALUE lines from MINAMI_GROWTH_ENV_FILE (on the author's box, ecvision's own config). */
function conf(): Conf | null {
  const env: Record<string, string | undefined> = { ...process.env };
  const f = process.env.MINAMI_GROWTH_ENV_FILE?.replace(/^~(?=\/)/, os.homedir());
  if (!env.POSTHOG_PERSONAL_API_KEY && f && fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*(POSTHOG_[A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  }
  const key = env.POSTHOG_PERSONAL_API_KEY, project = env.POSTHOG_PROJECT_ID;
  if (!key || !project) return null;
  return { key, project, host: (env.POSTHOG_API_HOST || "https://us.posthog.com").replace(/\/$/, "") };
}

async function hogql(c: Conf, query: string): Promise<unknown[][]> {
  const r = await fetch(`${c.host}/api/projects/${c.project}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`PostHog ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as { results?: unknown[][] }).results ?? [];
}

/** A HogQL string literal for an event name we picked ourselves (env or the guess list). */
const lit = (s: string) => `'${s.replace(/[^\w $.:-]/g, "")}'`;

const SRC = `coalesce(nullIf(person.properties.$initial_referring_domain, ''), nullIf(properties.$referring_domain, ''), '$direct')`;
const NOT_LOCAL = `coalesce(properties.$host, '') NOT LIKE 'localhost%' AND coalesce(properties.$host, '') NOT LIKE '127.%'`;
// The team, left out of every count: anyone in the project's internal cohort (MINAMI_GROWTH_EXCLUDE_COHORT,
// PostHog's own "Internal / Test users" — email @ecvision.ai or $internal_or_test_user), and anyone who
// has opened /admin in 90 days. On 24 Oct the cohort matched nobody (ecvision identified people without
// an email), so the /admin rule is what held until ecvision's identify started sending those properties.
function notTeam(): string {
  const cohort = Number(process.env.MINAMI_GROWTH_EXCLUDE_COHORT) || 0;
  const admin = `person_id NOT IN (SELECT person_id FROM events WHERE event = '$pageview' AND properties.$pathname LIKE '/admin%' AND timestamp >= now() - INTERVAL 90 DAY)`;
  return cohort ? `${admin} AND person_id NOT IN COHORT ${cohort}` : admin;
}

/** Referring domain → the name a growth manager says. Null = internal (dropped from the list). */
export function sourceName(dom: string, site: string): string | null {
  const d = dom.toLowerCase().replace(/^www\./, "");
  if (d === "$direct" || d === "") return "Direct";
  if (d.startsWith("localhost") || d.startsWith("127.") || (site && d === site.replace(/^www\./, ""))) return null;
  const known: [RegExp, string][] = [
    [/(^|\.)google\./, "Google"], [/(^|\.)bing\.com$/, "Bing"], [/(^|\.)(linkedin\.com|lnkd\.in)$/, "LinkedIn"],
    [/(^|\.)(chatgpt\.com|openai\.com)$/, "ChatGPT"], [/(^|\.)perplexity\.ai$/, "Perplexity"],
    [/(^|\.)(facebook\.com|fb\.com|m\.facebook\.com)$/, "Facebook"], [/(^|\.)(t\.co|x\.com|twitter\.com)$/, "X"],
    [/(^|\.)youtube\.com$/, "YouTube"], [/(^|\.)reddit\.com$/, "Reddit"], [/(^|\.)duckduckgo\.com$/, "DuckDuckGo"],
  ];
  return known.find(([re]) => re.test(d))?.[1] ?? d;
}

async function pull(): Promise<Growth> {
  const c = conf();
  if (!c) throw new Error("PostHog isn't configured: set POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID (or MINAMI_GROWTH_ENV_FILE).");

  const seen = new Set((await hogql(c, `SELECT event FROM events WHERE timestamp > now() - INTERVAL 90 DAY GROUP BY event LIMIT 500`)).map((r) => String(r[0])));
  const pick = (envName: string | undefined, guess: string[]) => (envName ? envName : guess.find((g) => seen.has(g)) ?? null);
  const signup = pick(process.env.MINAMI_GROWTH_SIGNUP_EVENT, SIGNUP_GUESS), paid = pick(process.env.MINAMI_GROWTH_PAID_EVENT, PAID_GUESS);

  const evs = ["'$pageview'", ...(signup ? [lit(signup)] : []), ...(paid ? [lit(paid)] : [])].join(", ");
  const count = (cond: string) => [
    `uniqIf(person_id, event = '$pageview'${cond})`,
    signup ? `uniqIf(person_id, event = ${lit(signup)}${cond})` : "0",
    paid ? `uniqIf(person_id, event = ${lit(paid)}${cond})` : "0",
  ];
  const from = `toStartOfDay(now()) - INTERVAL ${DAYS - 1} DAY`, wk = `toStartOfDay(now()) - INTERVAL 6 DAY`;
  const where = `event IN (${evs}) AND timestamp >= ${from} AND ${NOT_LOCAL} AND ${notTeam()}`;
  const windows = [...count(` AND timestamp >= ${wk}`), ...count(` AND timestamp < ${wk}`)].join(", ");

  const [daily, bySrc, total, host] = await Promise.all([
    hogql(c, `SELECT toString(toDate(timestamp)) AS d, ${SRC} AS dom, ${count("").join(", ")} FROM events WHERE ${where} GROUP BY d, dom LIMIT 5000`),
    hogql(c, `SELECT ${SRC} AS dom, ${windows} FROM events WHERE ${where} GROUP BY dom LIMIT 1000`),
    hogql(c, `SELECT ${windows} FROM events WHERE ${where}`),
    hogql(c, `SELECT properties.$host AS h, count() AS n FROM events WHERE event = '$pageview' AND timestamp >= ${from} AND ${NOT_LOCAL} GROUP BY h ORDER BY n DESC LIMIT 1`),
  ]);
  const dailyTotal = await hogql(c, `SELECT toString(toDate(timestamp)) AS d, ${count("").join(", ")} FROM events WHERE ${where} GROUP BY d LIMIT 100`);

  const site = String(host[0]?.[0] ?? "").replace(/^www\./, "");
  const today = new Date();
  const dates = Array.from({ length: DAYS }, (_, i) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (DAYS - 1 - i))).toISOString().slice(0, 10));
  const step = (v: unknown, s: unknown, p: unknown): Step => ({ visitors: Number(v) || 0, signups: signup ? Number(s) || 0 : null, paid: paid ? Number(p) || 0 : null });
  const zero = () => step(0, 0, 0);
  const add = (a: Step, b: Step): Step => ({ visitors: a.visitors + b.visitors, signups: a.signups == null ? null : a.signups + (b.signups ?? 0), paid: a.paid == null ? null : a.paid + (b.paid ?? 0) });

  // Several raw domains map to one name (google.com, google.com.vn): their per-window uniques are
  // summed, which can double-count a person who came from both. Rare enough to accept for a daily view.
  const by = new Map<string, GrowthSource>();
  const get = (name: string) => by.get(name) ?? (by.set(name, { key: name, name, days: dates.map(zero), week: zero(), prev: zero() }), by.get(name)!);
  for (const r of bySrc) {
    const name = sourceName(String(r[0]), site);
    if (!name) continue;
    const s = get(name);
    s.week = add(s.week, step(r[1], r[2], r[3]));
    s.prev = add(s.prev, step(r[4], r[5], r[6]));
  }
  for (const r of daily) {
    const name = sourceName(String(r[1]), site), i = dates.indexOf(String(r[0]));
    if (!name || i < 0) continue;
    const s = get(name);
    s.days[i] = add(s.days[i], step(r[2], r[3], r[4]));
  }
  const all: GrowthSource = { key: "All", name: "All", days: dates.map(zero), week: step(total[0]?.[0], total[0]?.[1], total[0]?.[2]), prev: step(total[0]?.[3], total[0]?.[4], total[0]?.[5]) };
  for (const r of dailyTotal) { const i = dates.indexOf(String(r[0])); if (i >= 0) all.days[i] = step(r[1], r[2], r[3]); }

  const sources = [...by.values()].filter((s) => s.week.visitors || s.prev.visitors).sort((a, b) => b.week.visitors - a.week.visitors || b.prev.visitors - a.prev.visitors);
  return { pulledAt: new Date().toISOString(), site, dates, events: { signup, paid }, sources: [all, ...sources] };
}

function readCache(): Growth | null {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")) as Growth; } catch { return null; }
}

const localDay = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
let inflight: Promise<Growth> | null = null;

/** The cached pull; pulls first when there is none, it is from an earlier local day, or `force`. */
export async function getGrowth(force = false): Promise<Growth> {
  const cached = readCache();
  if (cached && !force && !cached.error && localDay(new Date(cached.pulledAt)) === localDay(new Date())) return cached;
  // One pull at a time: the phone and the desktop opening the page together must not double the queries.
  inflight ??= pull()
    .then((g) => { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(g)); return g; })
    .finally(() => { inflight = null; });
  try {
    return await inflight;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // A failed pull keeps yesterday's numbers on screen with the error beside them, rather than a blank page.
    return cached ? { ...cached, error } : { pulledAt: new Date().toISOString(), site: "", dates: [], events: { signup: null, paid: null }, sources: [], error };
  }
}
