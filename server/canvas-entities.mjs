// ENTITY RESOLUTION — deciding that "Minamino", "Midami" and "Minami" are one thing.
//
// The board's structure is built from what the transcript SAYS, so a misheard name does not stay a
// cosmetic problem for long. On 2026-08-12 "Minamino" became the TOPIC NAME of an entire board:
// every card in the meeting hung off a word anh never said, because the judge read the raw transcript
// and the raw transcript was wrong.
//
// The vocabulary layer (canvas-vocab.mjs) fixes mishearings it has been TAUGHT. This fixes the ones
// it has not — which is every new product, person and feature, i.e. the ones that matter most in the
// meeting where they are first discussed.
//
// ── How mentions are matched ────────────────────────────────────────────────────────────────────
// Phonetically, in a way that survives Vietnamese. English phonetic algorithms (Soundex, Metaphone)
// encode English orthography and mangle "được" into nothing useful, so they are the wrong tool for a
// bilingual meeting. Instead: strip diacritics, fold case, and compare by normalised edit distance.
//
//   minamino → minami   distance 2 / 8  → 0.75 similar
//   midami   → minami   distance 1 / 6  → 0.83 similar
//   minato   → minami   distance 2 / 6  → 0.67 similar  ← correctly NOT merged
//
// The threshold sits between the last two. That gap is narrow on purpose: merging two names that are
// genuinely different is far worse than leaving one unresolved, because a wrong merge silently
// rewrites something a human said and there is no way to notice from the board.
//
// ── Anchors, and why they matter ────────────────────────────────────────────────────────────────
// A known term from the vocabulary is an ANCHOR: anything near it resolves TO it, whatever the counts
// say. Without anchors the canonical form is whichever spelling happened to be most frequent, and a
// name mangled consistently would win against the correct one heard twice. Anchors make the answer a
// fact anh has stated rather than a popularity contest.
//
// Everything else is open vocabulary — products, people, features, companies, ideas — because the
// entity set has to be whatever THIS conversation is about, not a taxonomy fixed in advance.

/** Fold to a comparable skeleton: no diacritics, no case, letters and digits only. */
function skeleton(s) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // combining marks — "được" → "duoc"
    .replace(/đ/gi, "d")               // Vietnamese đ has no combining form
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Levenshtein, iterative with one row. Runs on every candidate pair on a 2-vCPU box. */
function distance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/** 1 = identical, 0 = nothing in common. Normalised by the LONGER string so "mi" and "minami" are
 *  not called similar just because the short one fits inside the long one. */
export function similarity(a, b) {
  const x = skeleton(a);
  const y = skeleton(b);
  if (!x || !y) return 0;
  return 1 - distance(x, y) / Math.max(x.length, y.length);
}

/** Above this, two mentions are the same entity. Calibrated on real mishearings — see the header.
 *  Short strings are held to a stricter standard because one character is a much larger share of
 *  them: "qone" and "gone" are 0.75 similar and are not the same word. */
const NEAR = 0.75;
const SHORT_NEAR = 0.9;
const SHORT = 5;

/** Tokens of a name, folded. */
const tokens = (s) => s.split(/[\s\-_/]+/).map(skeleton).filter(Boolean);

/** A token distinctive enough that sharing it means something. Short words ("ai", "app", "the") are
 *  shared by everything and prove nothing. */
const distinctive = (t) => t.length >= 5;

/** Are these two mentions the same entity?
 *
 *  ⚠️ WHOLE-STRING EDIT DISTANCE IS NOT ENOUGH for multi-word names, and a real meeting proved it.
 *  "Easy Vision AI" was heard five ways in one call — EC Vision, Ecom Vision, IC Vision, e-commerce
 *  vision — and produced FOUR separate topics. Scored whole-string against the anchor they land at
 *  0.47-0.58, far below any threshold that is safe for single words, because the mangled word inflates
 *  the distance while the perfectly-matched word ("Vision") contributes nothing extra.
 *
 *  Comparing TOKEN BY TOKEN sees what a human sees: one word is identical, one is mangled. */
function isNear(a, b, anchored = false) {
  const ta = tokens(a);
  const tb = tokens(b);

  // Single words: whole-string, with a stricter bar for short ones where one character is a large
  // share of the word ("qone" vs "gone").
  if (ta.length <= 1 || tb.length <= 1) {
    const s = similarity(a, b);
    const short = Math.min(skeleton(a).length, skeleton(b).length) <= SHORT;
    return s >= (short ? SHORT_NEAR : NEAR);
  }

  const [shortSide, longSide] = ta.length <= tb.length ? [ta, tb] : [tb, ta];

  // An ANCHOR is a term anh has explicitly declared, so a shared distinctive word carries weight —
  // but NOT on its own. The first version accepted any mention sharing one distinctive token, and the
  // test immediately absorbed "Computer Vision" into "Easy Vision AI". Sharing "vision" is not
  // evidence; it is the most common word in that entity's name.
  //
  // The discriminator is what the OTHER tokens look like. "EC" and "IC" are two-character fragments —
  // that is what a mangled word looks like coming out of an ASR. "Computer" is a whole English word
  // that happens not to be "Easy". So: a shared distinctive token counts only when every unshared
  // token is either near its counterpart or too short to be a real word.
  if (anchored && shortSide.some((t) => distinctive(t) && longSide.includes(t))) {
    const unshared = shortSide.filter((t) => !longSide.includes(t));
    const plausible = unshared.every(
      (t) => t.length <= 3 ||
        longSide.some((u) => 1 - distance(t, u) / Math.max(t.length, u.length) >= 0.4),
    );
    if (plausible) return true;
  }

  // Otherwise every token must have a plausible counterpart, and at least one must be a real match.
  // The floor is what keeps "Computer Vision" out of "Easy Vision": both share "vision", but
  // "computer" and "easy" have nothing in common.
  let exact = 0;
  for (const t of shortSide) {
    const best = Math.max(...longSide.map((u) => (1 - distance(t, u) / Math.max(t.length, u.length))));
    if (best >= 0.9) exact++;
    else if (best < 0.4) return false;
  }
  return exact >= 1;
}

/** Candidate entity mentions in a line.
 *
 *  Capitalised runs, plus anything already anchored. Capitalisation is a weak signal in Vietnamese and
 *  a weak signal in ASR output generally — which is why anchors do the heavy lifting and this only
 *  has to catch the rest. Deliberately permissive: a wrong candidate that never repeats is dropped by
 *  the MIN_MENTIONS floor below, so the cost of over-collecting is nil. */
function candidates(line, anchors = []) {
  // Drop the speaker prefix — "phạm đức toàn: ..." would otherwise make every speaker an entity, and
  // the roster already gives us those reliably.
  const body = line.replace(/^[^:]{0,40}:\s*/, "");
  const out = [];

  // ANCHORS ARE FOUND DIRECTLY, not inferred from capitalisation.
  //
  // The heuristics below exist to DISCOVER unknown names. For a term already in the vocabulary there
  // is nothing to discover — so searching for it plainly, case-insensitively, is both simpler and
  // strictly more correct. Without this, "MINAMI is here", "minami again" and "Minami once more"
  // produced ZERO entities: the first two fail the capitalisation rule and the third is dropped by the
  // sentence-initial guard. An entity that opens a sentence is the most natural way to say it.
  for (const a of anchors) {
    const rx = new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    for (const m of body.matchAll(rx)) out.push(m[0]);
  }
  for (const m of body.matchAll(/\b([A-Z][\p{L}0-9]*(?:[ -][A-Z][\p{L}0-9]*){0,3})\b/gu)) {
    const t = m[1].trim();
    if (t.length < 3) continue;
    const first = t.split(/[ -]/)[0].toLowerCase();
    if (STOP.has(first)) continue;
    // A lone capitalised word opening a sentence is grammar, not a name.
    if (!t.includes(" ") && sentenceInitial(body, m.index ?? 0)) continue;
    out.push(t);
  }
  return out;
}

/** An entity needs to be said this many times before it earns a place on the board. One mention is
 *  usually a mishearing or an aside; two is a subject. */
const MIN_MENTIONS = 2;

/** Words that start sentences constantly and are never the subject of anything.
 *
 *  ⚠️ The FIRST word of a candidate is checked against this, not the whole phrase. Against the real
 *  transcript the first version promoted "And I", "Just" and "Like" to entities — every one of them a
 *  sentence-initial capital, which in ASR output is the most common capital there is. Filtering on the
 *  leading word kills the phrase form too, which a whole-string check never would. */
const STOP = new Set([
  "the", "this", "that", "these", "those", "and", "but", "so", "or", "if", "because",
  "ok", "okay", "yeah", "yes", "no", "not", "well", "just", "like", "actually", "maybe",
  "i", "we", "you", "he", "she", "it", "they", "there", "here", "my", "our", "your",
  "what", "how", "why", "when", "where", "who", "then", "now", "also", "still", "let",
  "oh", "wow", "hmm", "yo", "hey", "please", "thanks", "sorry",
  "minami", // an anchor, not a discovered entity
]);

/** Is this match at the start of a sentence?
 *
 *  A single capitalised word there carries no information — English and ASR both capitalise the first
 *  word of every sentence, so "Sometimes" is not a product. Multi-word runs are kept even at a
 *  sentence start, because "Easy Vision AI" opening a sentence is still an entity. */
function sentenceInitial(body, index) {
  const before = body.slice(0, index).trimEnd();
  return before === "" || /[.!?:]$/.test(before);
}

export function createEntityIndex(vocab = { terms: [], fixes: {} }) {
  /** canonical name → { name, count, variants:Set, anchored:boolean } */
  /** canonical name → { name, count, variants:Map<string,number>, anchored } */
  const byName = new Map();
  /** skeleton → canonical name, so repeat lookups are free */
  const cache = new Map();
  /** Bumped by prune(); a cluster records the sweep it was created in. */
  let sweeps = 0;

  // Anchors first, so a near miss always resolves TO the correct spelling.
  for (const t of vocab.terms ?? []) {
    byName.set(t, { name: t, count: 0, variants: new Map([[t, 0]]), anchored: true, seenAt: 0 });
  }

  /** Resolve a mention to an existing entity, or null. */
  function resolve(mention) {
    const key = skeleton(mention);
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    for (const e of byName.values()) {
      for (const v of e.variants.keys()) {
        if (isNear(mention, v, e.anchored)) {
          cache.set(key, e.name);
          return e.name;
        }
      }
    }
    return null;
  }

  return {
    /** Drop clusters that were mentioned once and never again.
     *
     *  Every capitalised word becomes a candidate cluster, so a long meeting accumulates thousands of
     *  one-off entries to promote a handful — measured: 2000 utterances held ~4000 clusters for 3 real
     *  entities. The memory is survivable; the cost is that resolving an UNSEEN mention scans every
     *  cluster and its variants, so the layer gets slower exactly as the meeting gets longer.
     *
     *  Singletons older than the last sweep are noise by definition: a real subject gets said again. */
    prune() {
      for (const [k, e] of byName) {
        if (!e.anchored && e.count < MIN_MENTIONS && e.seenAt < sweeps) byName.delete(k);
      }
      sweeps++;
      cache.clear();
    },

    /** Feed a transcript line. Returns entities newly promoted to the board. */
    observe(line) {
      const promoted = [];
      const anchorNames = [...byName.values()].filter((e) => e.anchored).map((e) => e.name);
      const anchorSet = new Set(anchorNames.map((a) => a.toLowerCase()));
      for (const c of candidates(line, anchorNames)) {
        // STOP applies to DISCOVERY, never to anchors. "minami" is in the stop list to keep it from
        // being invented as a new entity — and that entry was silently discarding every real mention
        // of the anchor, so the one name the vocabulary cares most about resolved to nothing.
        if (!anchorSet.has(c.toLowerCase()) && STOP.has(c.toLowerCase())) continue;
        const hit = resolve(c);
        if (hit) {
          const e = byName.get(hit);
          const wasBelow = e.count < MIN_MENTIONS;
          e.count++;
          // Record the variant so future mishearings of the MISHEARING also resolve — the cluster
          // widens as it sees more of the ways this word gets mangled.
          //
          // ⚠️ NEVER record a variant that is a token-subset of the canonical name. "Vision" resolves
          // to "Easy Vision AI" and must not become a variant of it, because rewrite() would then
          // replace "Vision" INSIDE the canonical form and cascade: "EC Vision" became
          // "Easy Easy Vision AI AI". A variant has to be a different way of saying the whole thing,
          // not a piece of it.
          const cTokens = tokens(c);
          const nameTokens = tokens(e.name);
          const isSubset = cTokens.length < nameTokens.length && cTokens.every((t) => nameTokens.includes(t));
          if (!isSubset) e.variants.set(c, (e.variants.get(c) ?? 0) + 1);

          // ⚠️ THE CANONICAL FORM MUST NOT BE WHICHEVER MANGLING ARRIVED FIRST.
          //
          // First-seen-wins put "Kubernets" on the board permanently and filed the correct
          // "Kubernetes" as a variant OF the typo. For an unanchored cluster the best available
          // evidence is frequency — a name said correctly three times and mangled once should render
          // correctly — with length as the tie-break, since mishearings truncate far more often than
          // they elaborate. Anchored clusters never re-canonicalise: anh stated that spelling.
          if (!e.anchored) {
            let best = e.name;
            let bestCount = e.variants.get(e.name) ?? 0;
            for (const [v, n] of e.variants) {
              if (n > bestCount || (n === bestCount && v.length > best.length)) { best = v; bestCount = n; }
            }
            if (best !== e.name) {
              byName.delete(e.name);
              e.name = best;
              byName.set(best, e);
            }
          }
          if (wasBelow && e.count >= MIN_MENTIONS) promoted.push(e.name);
          continue;
        }
        byName.set(c, { name: c, count: 1, variants: new Map([[c, 1]]), anchored: false, seenAt: sweeps });
        cache.set(skeleton(c), c);
      }
      return promoted;
    },

    /** Rewrite every known variant in a piece of text to its canonical form.
     *
     *  Longest variant first, so "Easy Vision AI" is replaced before "Easy" can match inside it. */
    rewrite(text) {
      let out = text;
      const pairs = [];
      for (const e of byName.values()) {
        for (const v of e.variants.keys()) if (v !== e.name) pairs.push([v, e.name]);
      }
      pairs.sort((a, b) => b[0].length - a[0].length);
      if (!pairs.length) return out;

      // ONE PASS, not one pass per variant. Replacing sequentially lets an earlier replacement be
      // matched by a later rule — which is how "EC Vision" turned into "Easy Easy Vision AI AI".
      // A single alternation visits every character once and cannot revisit its own output.
      const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(`\\b(${pairs.map(([w]) => esc(w)).join("|")})\\b`, "gi");
      const lookup = new Map(pairs.map(([w, r]) => [w.toLowerCase(), r]));
      return out.replace(rx, (m) => lookup.get(m.toLowerCase()) ?? m);
    },

    /** Entities worth putting on a board, most-discussed first. */
    entities() {
      return [...byName.values()]
        .filter((e) => e.count >= MIN_MENTIONS)
        .sort((a, b) => b.count - a.count)
        .map((e) => ({ name: e.name, count: e.count, variants: [...e.variants.keys()] }));
    },

    /** Variants seen for an entity, for the mid-meeting rewrite of cards already on the board. */
    variantsOf(name) {
      return [...(byName.get(name)?.variants?.keys() ?? [])];
    },
  };
}
