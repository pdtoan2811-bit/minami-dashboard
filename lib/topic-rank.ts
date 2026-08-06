// Ranking the topics worth reopening — used by the "Recent" tab of the new-topic picker (§5d).
//
// The problem this solves is NOT "sort by last activity". Pure recency is what makes the list noise:
// one throwaway question asked in ~/Downloads five minutes ago outranks the project you've lived in
// for three weeks, and the list you actually want — "where am I working right now" — is buried under
// folders you touched once. The board's own `weight` (reqs + tokens/5000) has the opposite failure:
// it's a lifetime total, so a project you finished last month sits at the top forever.
//
// So the score is DEPTH decayed by AGE, with a third term for the signal neither of those carries:
// whether you came BACK. Returning to a folder on separate days is the strongest evidence a topic is
// real work rather than a one-off, and it's the term that most reliably sorts "focused" above "busy
// once". A single frantic afternoon in a scratch folder can out-message a real project; it cannot
// out-return one.
export type RankSession = { lastActivity: number; messages: number; tokensIn: number; tokensOut: number };
export type RankTopic = { name: string; cwd: string; sessions: RankSession[] };

/** One row of the picker's Recent tab. Flattened deliberately: `FolderPicker` gets what it draws and
 *  nothing more, so it doesn't take a dependency on the board's `Project` shape or on session records
 *  it has no use for. */
export type RecentTopic = { name: string; cwd: string; why: string; last: number; active: boolean; icon?: string };

/** Score halves every this many days of silence. A week keeps "last sprint" visible but sinking. */
const HALF_LIFE_DAYS = 7;
/** How much one extra day-you-came-back is worth against raw volume. Tuned against this box's real
 *  board: high enough that an 8-chat/5-day project beats a 1-chat/500-message dump, low enough that a
 *  daily one-line check-in doesn't beat sustained work. */
const RETURN_WEIGHT = 1.6;
/** Below this a topic is a scratch folder, not a topic: too thin to have been real work. Applied as a
 *  floor rather than a score term because no amount of recency should promote a 2-message folder — and
 *  a floor is explainable to the user in a way a magic threshold buried in a polynomial is not. */
const MIN_REQS = 6;
/** Drop anything scoring below this fraction of the leader. The limit is a ceiling, not a quota — a box
 *  with three real projects should offer three rows, not pad to eight with folders you're done with. */
const RELATIVE_FLOOR = 0.2;
const DAY = 86_400_000;
/** A topic in a temp directory is never somewhere you work — the OS deletes it. These are test
 *  fixtures, `mktemp` scratch and smoke-run leftovers, and they rank respectably on volume alone
 *  (a 4-chat/163-message fixture out-scores plenty of real folders) while being pure noise here.
 *  Excluded outright rather than scored down, because no amount of activity makes /tmp a project. */
const TRANSIENT = [/^\/tmp\//, /^\/private\/tmp\//, /^\/var\/folders\//, /^\/private\/var\/folders\//];
/** `$HOME` exactly — never a subdirectory of it. This app already treats a session in the home folder
 *  as the FOLDERLESS case (the picker's "No folder →" starts one there and labels it "CLI"), so it
 *  surfaces as a topic named after the user — "thomas" — which is an artifact of `basename(cwd)`, not
 *  a project you chose. Same path assumption as `shortPath` in FolderPicker; this is a local-only
 *  macOS/Linux tool, so the two-segment home path is safe to encode. */
const HOME_DIR = /^\/(Users|home)\/[^/]+$/;
const isTransient = (cwd: string) => HOME_DIR.test(cwd) || TRANSIENT.some((re) => re.test(cwd));

export type RankedTopic<T> = {
  topic: T;
  score: number;
  /** Distinct calendar days with activity — "you came back this many times". */
  days: number;
  chats: number;
  reqs: number;
  last: number;
  /** Why this ranked where it did, in the user's terms. Shown in the list so the order isn't magic. */
  why: string;
};

/**
 * Rank topics by focus. Pure and side-effect free (`now` is injected) so it can be unit-tested and so
 * a render never depends on wall-clock drift between two calls in the same frame.
 */
export function rankTopics<T extends RankTopic>(topics: T[], now: number, limit = 8): RankedTopic<T>[] {
  const out: RankedTopic<T>[] = [];
  for (const t of topics) {
    const ss = t.sessions || [];
    if (!ss.length || !t.cwd || isTransient(t.cwd)) continue;
    const reqs = ss.reduce((a, s) => a + (s.messages || 0), 0);
    const tokens = ss.reduce((a, s) => a + (s.tokensIn || 0) + (s.tokensOut || 0), 0);
    const last = Math.max(...ss.map((s) => s.lastActivity || 0));
    // Local calendar days, deliberately: "did I come back tomorrow" is a question about the user's
    // day, and a UTC bucket splits an evening session from the morning that continued it.
    const days = new Set(ss.map((s) => new Date(s.lastActivity).toDateString())).size;
    if (reqs < MIN_REQS) continue;

    // Log-scaled so the top project doesn't flatten everything below it — the board's biggest topic
    // here is ~40× the median by volume, and on a linear scale nothing else would ever place.
    const substance = Math.log1p(reqs + tokens / 5000);
    const loyalty = RETURN_WEIGHT * Math.log1p(Math.max(0, days - 1));
    const ageDays = Math.max(0, (now - last) / DAY);
    const recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    const score = (substance + loyalty) * recency;

    out.push({ topic: t, score, days, chats: ss.length, reqs, last, why: whyLabel(ss.length, days) });
  }
  out.sort((a, b) => b.score - a.score);
  const cut = (out[0]?.score ?? 0) * RELATIVE_FLOOR;
  return out.filter((x) => x.score >= cut).slice(0, limit);
}

// Says what earned the placing, in plain terms. "3 chats" alone reads as a stat; "3 chats over 2 days"
// is the actual reason it outranks a bigger one-day dump.
function whyLabel(chats: number, days: number): string {
  const c = `${chats} chat${chats === 1 ? "" : "s"}`;
  return days > 1 ? `${c} over ${days} days` : c;
}
