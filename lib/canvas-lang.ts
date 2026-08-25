// WHAT LANGUAGE IS THIS MEETING IN — and every fixed string that has to follow the answer.
//
// ── The bug this exists for ─────────────────────────────────────────────────────────────────────
//
// The judge already gets this right. Its SYSTEM prompt is explicit — "Vietnamese in, Vietnamese out"
// — and the reason it gives is the whole reason this file exists too: *the board is screen-shared
// back to the people who are talking, so a card they cannot read is worse than no card.*
//
// But the CARDS were the only thing obeying it. Everything the app writes ITSELF was hardcoded
// English, sitting directly on top of Vietnamese content:
//
//     MILESTONE                     ← ours, English, in 10px tracked caps
//     Meme cut scene chạy được rồi  ← theirs, Vietnamese
//
// A cut scene is the one moment that takes the whole screen in front of a client. Stamping an English
// caption over their own sentence is exactly the "own words returned to them as noise" the judge
// prompt is written to prevent — we simply never applied the rule to ourselves.
//
// ── Why detection, and not a setting ────────────────────────────────────────────────────────────
//
// There IS a language knob already (`sttLang`), but it configures the EAR, not the room: it is often
// unset, and on a code-switching call it is a single value for a conversation that has two. The board
// itself is the better evidence — it is what the judge actually wrote, in the language it decided
// each point was made in. So the caption follows the board, which follows the room.

export type Lang = "vi" | "en";

/** Characters no English sentence contains. Vietnamese-specific letters plus every tone-marked vowel
 *  in the precomposed form the transcript arrives in. */
const VI_CHARS =
  /[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵÀÁẢÃẠẰẮẲẴẶẦẤẨẪẬÈÉẺẼẸỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌỒỐỔỖỘỜỚỞỠỢÙÚỦŨỤỪỨỬỮỰỲÝỶỸỴ]/g;

/** ⚠️ DIACRITIC COUNTING ALONE IS NOT ENOUGH, and the failure is asymmetric.
 *
 *  An English board that mentions "Hà Nội" once would flip to Vietnamese on two characters. Meanwhile
 *  a genuinely Vietnamese line can be almost bare — "Deploy vào thứ sáu" carries only three. So a
 *  ratio alone is wrong in both directions, and the words below are the second, independent signal:
 *  they are function words, so they appear in Vietnamese prose and essentially never in English. */
const VI_WORDS =
  /\b(và|của|là|không|được|người|những|này|cho|với|trong|một|các|có|thì|nhưng|đã|sẽ|nhé|rồi|mình|chúng|khi|nếu|hoặc|vẫn|cũng|phải|làm|bên|theo|về|đến|từ)\b/gi;

/** The dominant language of a body of text. Defaults to English: it is the safer wrong answer,
 *  because an English caption over English content is merely unremarkable, whereas a Vietnamese
 *  caption over an English board is visibly broken. */
export function detectLang(texts: Array<string | undefined | null>): Lang {
  const joined = texts.filter(Boolean).join(" ");
  if (!joined) return "en";

  const viChars = joined.match(VI_CHARS)?.length ?? 0;
  const viWords = joined.match(VI_WORDS)?.length ?? 0;
  const letters = joined.match(/\p{L}/gu)?.length ?? 0;
  if (!letters) return "en";

  // Two independent routes to "yes", because either signal can be thin on its own — but both need a
  // floor, so one borrowed proper noun cannot decide a whole board.
  if (viChars >= 3 && viChars / letters >= 0.02) return "vi";
  if (viWords >= 2) return "vi";
  return "en";
}

/** The board's language: read from what the judge wrote on it.
 *
 *  Labels and details only — never topic names alone. Topics are short noun phrases and often bare
 *  English product names ("Pricing", "Hetzner"), so a board judged on its headings reads as English
 *  while every card under them is Vietnamese.
 */
export function boardLang(nodes: Array<{ label?: string; detail?: string }> | undefined | null): Lang {
  if (!nodes?.length) return "en";
  const texts: Array<string | undefined> = [];
  for (const n of nodes) {
    texts.push(n.label, n.detail);
  }
  return detectLang(texts);
}

/** What a reaction MEANS, said in the room's own language.
 *
 *  ⚠️ THE EMOJI KEYS MUST STAY IN SYNC with the judge's `emoji` enum in lib/canvas-llm.ts and the
 *  folders under public/memes/. Three glyphs once existed here and in the renderer but NOT in the
 *  enum, so the judge could never emit them and the meme folders were unreachable. */
export const MOMENT_MEANING_BY_LANG: Record<Lang, Record<string, string>> = {
  en: {
    "🔥": "Strongest claim yet",
    "😮": "That landed",
    "💡": "New idea",
    "❓": "Left hanging",
    "👏": "Worth marking",
    "🤝": "Agreement",
    "🙌": "Everyone's aligned",
    "✨": "Worth keeping",
    "💯": "Full agreement",
    "🎉": "Milestone",
    "✅": "Settled",
  },
  /** Short, spoken Vietnamese — the register anh actually uses on a call, not documentation
   *  Vietnamese. These are read at a glance from across a video call, so length matters as much as
   *  accuracy: "Khẳng định mạnh nhất từ đầu buổi" is correct and unreadable at 10px. */
  vi: {
    "🔥": "Ý mạnh nhất",
    "😮": "Câu này đắt",
    "💡": "Ý tưởng mới",
    "❓": "Còn bỏ ngỏ",
    "👏": "Đáng ghi nhận",
    "🤝": "Đã đồng ý",
    "🙌": "Cả nhóm đồng thuận",
    "✨": "Đáng giữ lại",
    "💯": "Đồng ý hoàn toàn",
    "🎉": "Cột mốc",
    "✅": "Đã chốt",
  },
};

const MOMENT_FALLBACK: Record<Lang, string> = { en: "Reaction", vi: "Khoảnh khắc" };

export function momentMeaning(emoji: string, lang: Lang = "en"): string {
  return MOMENT_MEANING_BY_LANG[lang][emoji] ?? MOMENT_FALLBACK[lang];
}

/** Minami's presence badge. Sits on the shared screen for the entire call — the single longest-lived
 *  string on the board, and so the most conspicuous one to leave in the wrong language. */
export const PRESENCE_LABEL: Record<Lang, Record<"listening" | "thinking" | "idle", string>> = {
  en: { listening: "Listening", thinking: "Thinking", idle: "Idle" },
  vi: { listening: "Đang nghe", thinking: "Đang nghĩ", idle: "Đang chờ" },
};
