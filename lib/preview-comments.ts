// Preview comments (§21) — the shared vocabulary between three parties that never import each other:
//
//   the app being previewed   runs public/inspect-core.js  (plain JS, no build, any framework)
//   the pop-out wrapper       app/preview/[session]        (React, dashboard origin)
//   the bound chat session    receives ONE user turn        (text + image paths, §11)
//
// Everything here is client-safe and pure: types for the postMessage protocol, the pin model the
// wrapper keeps, and `composeMessage` — the one function that turns pins into the turn Claude reads.
// The script is not TypeScript and cannot import this file, so the protocol is documented twice on
// purpose: here as types, there as comments. Change one, change the other.

/** Every frame on the channel carries this tag; the wrapper and the script ignore anything without it. */
export const TAG = "minami-inspect";

// Intent chips (Q11). The word becomes the label after the pin number in the message, which is how
// a `Style` pin tells the session no logic should change without the note having to say so.
export const INTENTS = ["Fix", "Style", "Move", "Remove", "Ask", "Copy"] as const;
export type Intent = (typeof INTENTS)[number];

/** Bounding box in the app's viewport coordinates (CSS px, scroll already applied). */
export type Box = { x: number; y: number; w: number; h: number };

/** What the script knows about one element. `components` is empty for non-React pages. */
export type ElementInfo = {
  selector: string;
  components: string[];
  tag: string;
  text: string;
  box: Box;
};

/** One recorded error inside the app — console, window, rejection, fetch/XHR, or the Next.js overlay. */
export type AppError = {
  ts: number;
  kind: "console" | "error" | "rejection" | "network" | "overlay";
  message: string;
  frame?: string;
};

// ── script → wrapper ────────────────────────────────────────────────────────────────────────────
export type ScriptMsg =
  // Sent on load to the parent (targetOrigin "*": nothing secret in it) so the wrapper knows the hook
  // is present. Re-sent after every navigation/HMR reload, which is what triggers re-anchoring.
  | { tag: typeof TAG; t: "hello"; url: string; title: string; viewport: { w: number; h: number } }
  // Live hover feedback while a mark tool is armed.
  | { tag: typeof TAG; t: "hover"; el: ElementInfo | null }
  // A click landed while `pin` was armed; `crop` is a PNG data URL or null if rendering failed.
  | { tag: typeof TAG; t: "picked"; reqId: string; el: ElementInfo; crop: string | null }
  // A rectangle drag finished: everything that intersects it, plus a crop of the region.
  | { tag: typeof TAG; t: "region"; reqId: string; box: Box; els: ElementInfo[]; crop: string | null }
  // Answer to `anchor`: fresh boxes for the selectors that still exist, null for the ones that don't.
  | { tag: typeof TAG; t: "anchored"; boxes: Record<string, Box | null> }
  // The error buffer changed (a new entry). The wrapper keeps its own copy and clears on send.
  | { tag: typeof TAG; t: "errors"; errors: AppError[] }
  // Scroll/resize inside the app — pin markers are positioned by the wrapper, so it must re-place them.
  | { tag: typeof TAG; t: "viewport"; scroll: { x: number; y: number }; size: { w: number; h: number } }
  // A wrapper hotkey pressed while the APP had focus (which it does after any click in it). The
  // script never acts on these itself beyond Escape; the wrapper owns the tool state.
  | { tag: typeof TAG; t: "key"; key: "p" | "r" | "m" | "n" | "Escape" | "Send" }
  // An in-app marker was clicked: reopen that pin's note. Works in Browse mode (the badge takes
  // pointer events) and under the armed overlay (the script hit-tests through it).
  | { tag: typeof TAG; t: "marker"; n: number };

// ── wrapper → script ────────────────────────────────────────────────────────────────────────────
export type WrapperMsg =
  // The reply to `hello`. From this point the script pins its targetOrigin to the origin this came
  // from — the handshake is what lets the script be included with any `src` (relative, another port)
  // without knowing the dashboard's origin up front.
  | { tag: typeof TAG; t: "connect" }
  // "Are you there?" — the script answers with a fresh `hello`. Sent on every iframe `load`, because
  // the script's own hello fires at parse time, which on a slow dev compile can be many seconds
  // before `load`; judging presence by that timestamp is what made a hooked page look unhooked.
  | { tag: typeof TAG; t: "ping" }
  // Which tool is armed. `null` disarms: the app is fully interactive again.
  | { tag: typeof TAG; t: "arm"; tool: "pin" | "rect" | null }
  // Re-anchor after a reload (Q7): the wrapper's pins by selector; the script answers `anchored`.
  | { tag: typeof TAG; t: "anchor"; selectors: string[] }
  // Draw numbered markers inside the app for the pins the wrapper holds (so they scroll with content).
  | { tag: typeof TAG; t: "markers"; markers: { n: number; selector: string | null; box: Box | null; state: "open" | "sent" }[] }
  // Clear the script's error buffer (the wrapper just sent it).
  | { tag: typeof TAG; t: "clearErrors" };

// ── the wrapper's pin model ─────────────────────────────────────────────────────────────────────
export type Pin = {
  id: string;
  n: number;
  kind: "pin" | "rect" | "page" | "move";
  note: string;
  intent: Intent | null;
  /** The anchored element (pin), the source element (move); absent for rect and page. */
  el?: ElementInfo;
  /** The destination element for `move`. */
  to?: ElementInfo;
  /** The dragged region (rect) with what it contained. */
  region?: { box: Box; els: ElementInfo[] };
  /** Where the crop landed on disk after upload (§11 pastes dir) — the path is what goes in the turn. */
  cropPath?: string | null;
  /** The data URL until upload, for the wrapper's own thumbnail. */
  cropData?: string | null;
  /** Last known box in app coordinates; null once re-anchoring found the element gone. */
  box: Box | null;
  state: "open" | "sent";
  url: string;
};

export type PageContext = { url: string; viewport: { w: number; h: number } };

const px = (n: number) => Math.round(n);
const boxStr = (b: Box) => `${px(b.w)}×${px(b.h)} @ (${px(b.x)},${px(b.y)})`;
const chain = (el: ElementInfo) => (el.components.length ? el.components.join(" > ") : `<${el.tag}>`);
const quote = (s: string) => `"${s.replace(/\s+/g, " ").trim()}"`;

/** One element, on one line, the way Claude will grep for it. */
function elLine(el: ElementInfo): string {
  const parts = [chain(el), `\`${el.selector}\``];
  return parts.join(" · ");
}

/**
 * The turn the bound session receives. Deterministic and plain: numbered pins, one intent word, the
 * component chain and selector on their own line, the crop's path as bare text (which is how §11
 * attaches it — the path IS the payload), then the errors, then the verify nudge. Kept as prose
 * rather than JSON because the session reads it once and acts; a human reading the transcript later
 * should be able to as well.
 */
export function composeMessage(pins: Pin[], ctx: PageContext, errors: AppError[], opts: { verify: boolean } = { verify: true }): string {
  const open = pins.filter((p) => p.state === "open");
  const lines: string[] = [];
  const count = open.length === 1 ? "1 comment" : `${open.length} comments`;
  lines.push(`[Preview comments] ${ctx.url} · ${ctx.viewport.w}×${ctx.viewport.h} · ${count}`);
  lines.push("");
  for (const p of open) {
    const n = circled(p.n);
    const head = [n, p.intent ? `${p.intent} —` : "—", p.note.trim() ? quote(p.note) : "(no note)"].join(" ");
    lines.push(head);
    if (p.kind === "pin" && p.el) {
      lines.push(`   ${elLine(p.el)}`);
      const facts = [] as string[];
      if (p.el.text) facts.push(`text: ${quote(p.el.text.slice(0, 200))}`);
      facts.push(p.box ? boxStr(p.box) : "element no longer on the page");
      lines.push(`   ${facts.join(" · ")}`);
    } else if (p.kind === "rect" && p.region) {
      // Innermost names: the outermost is the page, which every element in the region shares.
      const names = uniq(p.region.els.map((e) => e.components.at(-1) || `<${e.tag}>`)).slice(0, 8);
      lines.push(`   region ${boxStr(p.region.box)}${names.length ? ` containing ${names.join(", ")}` : ""}`);
      for (const e of p.region.els.slice(0, 6)) lines.push(`   - ${elLine(e)}${e.text ? ` · ${quote(e.text.slice(0, 80))}` : ""}`);
    } else if (p.kind === "move" && p.el && p.to) {
      lines.push(`   from ${elLine(p.el)}`);
      lines.push(`   to   ${elLine(p.to)}`);
    } else if (p.kind === "page") {
      lines.push(`   (whole page)`);
    }
    if (p.cropPath) lines.push(`   ${p.cropPath}`);
    lines.push("");
  }
  if (errors.length) {
    lines.push(`Errors since last send (${errors.length}):`);
    for (const e of errors.slice(-12)) {
      const where = e.frame ? ` — ${e.frame}` : "";
      lines.push(`  [${e.kind}] ${e.message.replace(/\s+/g, " ").trim().slice(0, 300)}${where}`);
    }
    lines.push("");
  }
  if (opts.verify && open.some((p) => p.kind !== "page")) {
    lines.push("After making the changes, open the same URL in the browser tool and screenshot each pinned selector; show before/after for each pin in your reply.");
  }
  return lines.join("\n").trimEnd();
}

/** A message with no pins and only errors — the toolbar's red badge. */
export function composeErrorsOnly(ctx: PageContext, errors: AppError[]): string {
  const lines = [`[Preview errors] ${ctx.url} · ${errors.length} since last send`, ""];
  for (const e of errors.slice(-20)) {
    const where = e.frame ? ` — ${e.frame}` : "";
    lines.push(`[${e.kind}] ${e.message.replace(/\s+/g, " ").trim().slice(0, 400)}${where}`);
  }
  lines.push("", "Find the cause and fix it; tell me which file it was.");
  return lines.join("\n");
}

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
export function circled(n: number): string {
  return n >= 1 && n <= 20 ? CIRCLED[n - 1] : `(${n})`;
}

function uniq<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }

/** The layout line the Enable-comments flow asks the session to add. */
export function installSnippet(dashboardOrigin: string, framework: "next" | "html"): string {
  const src = `${dashboardOrigin}/inspect.js`;
  if (framework === "next") {
    return `{process.env.NODE_ENV === "development" && <script src="${src}" />}`;
  }
  return `<script src="${src}"></script>`;
}

export function isPreviewUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return (url.protocol === "http:" || url.protocol === "https:") && /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(url.hostname);
  } catch { return false; }
}
