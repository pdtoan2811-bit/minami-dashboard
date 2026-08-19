// VOICE COMMANDS — the way anh tells Minami something she missed.
//
// This exists because of a real moment. Mid-meeting on 2026-08-17 anh said "Minami, bây giờ tôi muốn
// làm một bản thuyết trình" and nothing happened, because there was no command layer at all — the line
// went to the judge like any other sentence and became, at best, a card about wanting to present.
//
// ── Why commands are intercepted BEFORE the judge ────────────────────────────────────────────────
// A command is an instruction ABOUT the board, not content FOR it. Left in the transcript it gets
// judged, so "Minami, ghi lại: giá $50" risks becoming a card titled "Minami asks to note the price"
// instead of a card that says "giá $50". Intercepting means the words after the verb are used
// VERBATIM — which is the entire point, since anh reaches for a command precisely when the automatic
// path got it wrong.
//
// ── Why matching is diacritic-insensitive but capture is not ────────────────────────────────────
// ASR drops Vietnamese tone marks constantly: "chủ đề mới" comes back as "chu de moi" often enough
// that matching on the accented form alone would make the feature feel broken at random. But the text
// anh is dictating must keep its diacritics or the card is unreadable. So the KEYWORDS are matched
// against a folded copy while the PAYLOAD is sliced out of the original string, using an index map
// built during folding. Folding and slicing the same string would strip the tone marks from the card.
//
// Bilingual because anh code-switches mid-sentence; requiring one language would mean remembering
// which one Minami is in, which is exactly the kind of friction that stops a feature being used.

export type Command =
  | { kind: "topic"; text: string }
  | { kind: "card"; cardKind: "note" | "decision" | "action" | "question"; text: string }
  | { kind: "fix"; from: string; to: string }
  | { kind: "undo" }
  | { kind: "tidy" };

/** Fold to lowercase ASCII-ish for MATCHING, and return a map from folded index → original index.
 *
 *  A plain `.normalize("NFD").replace(...)` changes the string's length, so a match offset in the
 *  folded text points at the wrong character in the original. The map is what makes it safe to match
 *  on one and slice from the other. */
function fold(s: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D")
      .toLowerCase();
    for (const c of ch) { folded += c; map.push(i); }
  }
  return { folded, map };
}

/** The wake word, plus the way ASR keeps mangling it. canvas-vocab corrects most of these before we
 *  get here, but a command must not be lost just because the vocabulary layer had not seen a spelling
 *  yet — a missed command is worse than a missed word, because anh will assume the feature is broken. */
const WAKE = /\b(minami|mi\s*nami|mi\s*na\s*mi|minamino|midami|my\s*nami)\b[\s,.:!–—-]*/;

/** Longest patterns first: "new topic" must win over "note", and "khong phai" must be tried before a
 *  bare capture verb swallows the whole sentence. */
const VERBS: Array<{ re: RegExp; make: (payload: string) => Command | null }> = [
  // ── set the topic ──────────────────────────────────────────────────────────────────────────
  { re: /^(chu de moi|chu de|new topic|topic|section moi|new section)\b[\s,:.-]*/,
    make: (t) => (t ? { kind: "topic", text: t } : null) },

  // ── capture verbatim ───────────────────────────────────────────────────────────────────────
  { re: /^(ghi lai|ghi chu|note that|note down|note|capture|write down)\b[\s,:.-]*/,
    make: (t) => (t ? { kind: "card", cardKind: "note", text: t } : null) },
  { re: /^(chot lai|chot|quyet dinh|decision|decide|we decided)\b[\s,:.-]*/,
    make: (t) => (t ? { kind: "card", cardKind: "decision", text: t } : null) },
  { re: /^(viec can lam|can lam|hanh dong|action item|action|todo|to do)\b[\s,:.-]*/,
    make: (t) => (t ? { kind: "card", cardKind: "action", text: t } : null) },
  { re: /^(cau hoi|question|open question)\b[\s,:.-]*/,
    make: (t) => (t ? { kind: "card", cardKind: "question", text: t } : null) },

  // ── housekeeping (no payload) ──────────────────────────────────────────────────────────────
  { re: /^(bo cai vua roi|bo cai do|xoa cai vua roi|undo|remove that|delete that)\b/,
    make: () => ({ kind: "undo" }) },
  { re: /^(don lai|don dep|sap xep lai|gom lai|tidy|tidy up|clean up|regroup)\b/,
    make: () => ({ kind: "tidy" }) },
];

/** "không phải X mà là Y" / "not X but Y" / "X should be Y" — handled apart from the verb table
 *  because it has TWO payloads rather than one. */
// Numbered groups, not named ones: the project's TS target predates ES2018, where named groups became
// available, and tsc rejects them outright rather than downlevelling.
const FIX_PATTERNS: RegExp[] = [
  /^khong phai\s+(.+?)\s+ma la\s+(.+)$/,
  /^not\s+(.+?)\s+but\s+(.+)$/,
  /^(.+?)\s+(?:should be|is spelled|spelled)\s+(.+)$/,
];

/** Parse one transcript line into a command, or null if it is ordinary speech.
 *
 *  Returns null for a bare wake word with nothing after it — "Minami?" is someone checking she is
 *  there, not an instruction, and turning it into an empty card would be worse than ignoring it. */
export function parseCommand(line: string): Command | null {
  const { folded, map } = fold(line);
  const wake = WAKE.exec(folded);
  if (!wake) return null;

  const afterFolded = folded.slice(wake.index + wake[0].length);
  const afterStart = map[wake.index + wake[0].length] ?? line.length;
  if (!afterFolded.trim()) return null;

  for (const p of FIX_PATTERNS) {
    const m = p.exec(afterFolded.trim());
    if (m) {
      // Sliced from the ORIGINAL so the corrected spelling keeps its diacritics and capitals.
      const rest = line.slice(afterStart);
      const cut = (needle: string) => {
        const idx = fold(rest).folded.indexOf(needle);
        return idx < 0 ? needle : rest.slice(idx, idx + needle.length).trim();
      };
      const from = cut(m[1].trim());
      const to = cut(m[2].trim());
      if (from && to) return { kind: "fix", from: strip(from), to: strip(to) };
    }
  }

  for (const v of VERBS) {
    const m = v.re.exec(afterFolded);
    if (!m) continue;
    const payloadStart = afterStart + (map[wake.index + wake[0].length + m[0].length] ?? 0) - (map[afterStart] ?? 0);
    // Map back through the folded index rather than arithmetic on lengths, which diverge when a
    // character folds to more than one (or zero) characters.
    const foldedPayloadIdx = wake.index + wake[0].length + m[0].length;
    const origIdx = map[foldedPayloadIdx] ?? payloadStart;
    return v.make(strip(line.slice(origIdx)));
  }
  return null;
}

const strip = (s: string) => s.trim().replace(/^[\s,:.–—-]+/, "").replace(/[\s.]+$/, "");

/** A short, human confirmation to flash on the canvas, so a command visibly LANDS. A command that
 *  works silently is indistinguishable from one that was never heard, and anh would stop trusting it. */
export function describeCommand(c: Command): string {
  switch (c.kind) {
    case "topic": return `topic: ${c.text}`;
    case "card": return `${c.cardKind}: ${c.text}`;
    case "fix": return `${c.from} → ${c.to}`;
    case "undo": return "remove last card";
    case "tidy": return "tidy the board";
  }
}


/** ── APPLYING A COMMAND, ONCE ────────────────────────────────────────────────────────────────────
 *
 *  Both callers route through here: the ingest path (a command that was SPOKEN) and the control path
 *  (one that was TYPED into the dock). They were about to become two copies of the same five-branch
 *  switch, and this repo has been bitten repeatedly by exactly that — two judge defaults in two
 *  files, a vocab seed the loader ignored. Two copies of "what a command does" would drift the moment
 *  one of them gained a sixth command.
 *
 *  The vocabulary write is a CALLBACK rather than an import, so this module stays free of node:fs and
 *  the caller keeps ownership of scope — ingest teaches the universal file, the dock can choose. */
export type CommandBoard = {
  topicId: (name: string) => string;
  cards: () => Array<{ id: string; label: string; detail?: string }>;
  reviseById: (r: { id: string; label?: string; detail?: string }) => boolean;
  removeLast: () => { id: string; label: string } | null;
  apply: (a: Record<string, unknown>, lines: string[]) => unknown;
};

export type CommandHost = {
  board: CommandBoard;
  topic?: string;
  forceTidy?: boolean;
  undone?: unknown[];
};

/** Returns a short human line describing what happened, for logging and for the on-screen flash. */
export function applyCommand(
  host: CommandHost,
  c: Command,
  rememberFix: (from: string, to: string) => void,
): string {
  if (c.kind === "topic") {
    host.topic = c.text;
    host.board.topicId(c.text);
    return `topic: ${c.text}`;
  }
  if (c.kind === "card") {
    host.board.apply(
      { op: "card", kind: c.cardKind, label: c.text, topic: host.topic, source: c.text },
      [c.text],
    );
    return `${c.cardKind}: ${c.text}`;
  }
  if (c.kind === "fix") {
    rememberFix(c.from, c.to);
    const re = new RegExp(c.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    let n = 0;
    for (const card of host.board.cards()) {
      if (re.test(card.label) || re.test(card.detail ?? "")) {
        host.board.reviseById({
          id: card.id,
          label: card.label.replace(re, () => c.to),
          detail: (card.detail ?? "").replace(re, () => c.to) || undefined,
        });
        n++;
      }
    }
    return `${c.from} → ${c.to} (${n} card${n === 1 ? "" : "s"})`;
  }
  if (c.kind === "undo") {
    const gone = host.board.removeLast();
    if (gone) { host.undone = host.undone ?? []; host.undone.push(gone); }
    return gone ? `removed: ${gone.label}` : "nothing to remove";
  }
  host.forceTidy = true;
  return "tidy queued";
}

/** Parse text that anh TYPED as a command. The wake word is optional here — he is typing into a box
 *  labelled "command", so demanding he also type "Minami," would be pure ceremony. */
export function parseTyped(text: string): Command | null {
  return parseCommand(text) ?? parseCommand(`Minami ${text}`);
}
