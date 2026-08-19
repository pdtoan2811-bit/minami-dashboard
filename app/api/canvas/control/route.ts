// MANUAL CONTROL OF A LIVE BOARD — what the canvas clicks talk to.
//
// Everything here exists because the automatic path is sometimes wrong and anh is sitting right
// there. Speech-to-text mishears names constantly; the judge occasionally invents a card. Until now
// the only way to intervene was to say a wake word and hope the ear caught it — which fails exactly
// when the ear is the thing that is failing. These are the same corrections, made with a mouse.
//
//   POST { action: "listen", seconds }              arm command mode — see the note on why
//   POST { action: "fix", from, to, scope }         correct a name, in this call or for good
//   POST { action: "tidy" }                         regroup now
//
// ── The two vocabularies, and why they are separate ─────────────────────────────────────────────
//   scope: "call"       lives on the session and dies with it. For the one-off — a client's name, a
//                       product nobody will mention again. Wrong corrections cost one meeting.
//   scope: "universal"  written to ~/.minami/canvas-vocab.json, so every future call knows it.
//
// The default is "call" deliberately. A universal fix is a permanent claim about language, made in
// the middle of a meeting with no chance to think — the safe default is the one that expires.
//
// ⚠️ The vault sync job (com.thomas.minami-vocab) rewrites `terms` every 30 minutes but PRESERVES
// `fixes`, so a universal correction made here is not clobbered by the next sync. That is load-
// bearing: the two writers share a file and only one of them owns each half of it.

import { loadVocab, saveVocab } from "@/server/canvas-vocab.mjs";
import { parseTyped, applyCommand, describeCommand, type CommandHost } from "@/lib/canvas-commands";

const TOKEN = process.env.CANVAS_INGEST_TOKEN || "";
const OPEN = process.env.CANVAS_INGEST_OPEN === "1";

/** ── WHY THE CANVAS ITSELF IS ALLOWED IN WITHOUT A BEARER TOKEN ─────────────────────────────────
 *
 *  The buttons on the canvas run in a BROWSER, and a browser cannot hold CANVAS_INGEST_TOKEN. The
 *  obvious fix — ship the token into the page — is the wrong one twice over: it puts a credential in
 *  a JS bundle, and that bundle is the tab anh SCREEN-SHARES into meetings.
 *
 *  So local, same-origin control is opt-in instead. With CANVAS_LOCAL_CONTROL=1 a request whose
 *  Origin is loopback may drive the board without a token. That is proportionate in present mode,
 *  where the app is deliberately NOT tunnelled and only the audio receiver is exposed — the surface
 *  is a page on anh's own machine.
 *
 *  ⚠️ It is NOT proportionate if the app is ever tunnelled again (bot auto-share sets
 *  RECALL_CANVAS_URL and makes /canvas public). Origin is client-controlled, so a public app plus
 *  this flag means anyone who can reach it can rewrite a live board. Leave the flag off in that mode.
 *  Default is off, so this can only be turned on deliberately. */
const LOCAL_CONTROL = process.env.CANVAS_LOCAL_CONTROL === "1";

function localOrigin(req: Request): boolean {
  const o = req.headers.get("origin") || req.headers.get("referer") || "";
  try {
    const h = new URL(o).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  } catch { return false; }
}

type Session = {
  /** Set by the ingest route when the session is created. Needed here so a repaint publishes onto the
   *  board that meeting owns — without it, every dock action (rename, undo, tidy) would land in the
   *  legacy bucket and a pinned viewer would never see the change. */
  id?: string;
  board: {
    cards: () => Array<{ id: string; label: string; detail?: string }>;
    reviseById: (r: { id: string; label?: string; detail?: string }) => boolean;
    removeLast: () => ({ id: string; label: string } | null);
    restore: (n: unknown) => boolean;
    topicId: (name: string) => string;
    apply: (a: Record<string, unknown>, lines: string[]) => unknown;
    graph: (meta?: Record<string, unknown>) => unknown;
    cards2?: never;
  };
  topic?: string;
  ended: boolean;
  touchedAt: number;
  commandUntil?: number;
  stt?: string;
  sttLang?: string;
  room?: boolean;
  roster?: string[];
  fixes?: Record<string, string>;
  forceTidy?: boolean;
  /** Cards removed by undo, newest last — the redo stack. Kept on the session so it dies with the
   *  meeting; a redo stack that outlived a call would restore a card into somebody else's board. */
  undone?: unknown[];
};

/** The meeting a click is about is the one that is live. There is only ever one in practice, but
 *  picking the most recently touched non-ended session means a stale session from an earlier call can
 *  never absorb a correction meant for the current one. */
function activeSession(): { id: string; s: Session } | null {
  const store = (globalThis as { __canvasSessions?: Map<string, Session> }).__canvasSessions;
  if (!store) return null;
  let best: { id: string; s: Session } | null = null;
  for (const [id, s] of store) {
    if (s.ended) continue;
    if (!best || s.touchedAt > best.s.touchedAt) best = { id, s };
  }
  return best;
}

/** ⚠️ MUTATING THE BOARD IS NOT THE SAME AS SHOWING IT.
 *
 *  The canvas renders the PUBLISHED document, not the session's board object — those are two
 *  different things, and ingest is what normally moves one into the other. Without this, every
 *  control here mutated the board correctly, returned 200, flashed "đã thêm thẻ" — and nothing on
 *  screen changed until the next utterance happened to publish. A control that reports success while
 *  the screen stays still is worse than one that fails, because anh would click it again.
 *
 *  Failure is logged, never thrown: a dropped repaint costs one frame, and the mutation already
 *  landed. */
async function repaint(req: Request, s: Session) {
  try {
    await fetch(new URL("/api/canvas", req.url), {
      method: "POST",
      // ⚠️ THE TOKEN. /api/canvas POST is authenticated now, and the app's own repaints were the
      // first casualty — 401 on every publish while audio kept flowing, so the shared board simply
      // stopped updating with nothing on screen to say why.
      headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
      body: JSON.stringify({ ...(s.board.graph({ status: "live" }) as object), meetingId: s.id ?? "" }),
    });
  } catch (e) {
    console.error("[control] repaint failed:", e instanceof Error ? e.message : e);
  }
}

export async function POST(req: Request) {
  const bearerOk = TOKEN && req.headers.get("authorization") === `Bearer ${TOKEN}`;
  const localOk = LOCAL_CONTROL && localOrigin(req);
  if (!bearerOk && !localOk && !OPEN) {
    if (!TOKEN) return Response.json({ ok: false, error: "ingest token not configured" }, { status: 503 });
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { action?: string; from?: string; to?: string; scope?: string; seconds?: number; kind?: string; text?: string; preview?: boolean; model?: string; lang?: string; room?: boolean };
  try { body = await req.json(); } catch { return Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }); }

  /** Clamp every free-text field before it reaches a parser. Measured by the audit: a 2MB `text`
   *  spends ~500ms inside the command parser's per-character fold, and 8MB spends ~500ms in the
   *  grounding normaliser — on the single thread also serving the SSE stream the meeting is watching.
   *  4000 characters is far above any real card or command. */
  for (const k of ["text", "from", "to", "model", "lang"] as const) {
    const v = (body as Record<string, unknown>)[k];
    if (typeof v === "string" && v.length > 4000) {
      return Response.json({ ok: false, error: `${k} too long` }, { status: 413 });
    }
  }

  const found = activeSession();
  if (!found) return Response.json({ ok: false, error: "no live meeting" }, { status: 409 });
  const { id: meetingId, s } = found;
  s.touchedAt = Date.now();

  // ── DISCONNECT ON DEMAND ──────────────────────────────────────────────────────────────────────
  // Ending the Google Meet does not necessarily remove the bot: it leaves when Recall's own
  // automatic_leave decides the room is empty, which can be minutes of billed time after anh has
  // stopped caring. The meeting id IS the bot id, so one call closes it from here.
  //
  // Ordered leave-then-end deliberately: stopping the billing clock matters more than the archive,
  // and the end path is resilient to being called with the bot already gone.
  if (body.action === "disconnect") {
    const key = process.env.RECALL_API_KEY || "";
    const region = process.env.RECALL_REGION || "ap-northeast-1";
    let left = "skipped";
    if (key && meetingId && meetingId !== "default") {
      try {
        const r = await fetch(`https://${region}.recall.ai/api/v1/bot/${encodeURIComponent(meetingId)}/leave_call/`, {
          method: "POST", headers: { Authorization: `Token ${key}` },
        });
        left = String(r.status);
      } catch (e) { left = e instanceof Error ? e.message.slice(0, 40) : "failed"; }
    }
    let ended: unknown = null;
    try {
      const r = await fetch(new URL("/api/canvas/ingest", req.url), {
        method: "POST",
        headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
        body: JSON.stringify({ meetingId, event: "end", title: body.text || undefined }),
      });
      ended = await r.json().catch(() => null);
    } catch { /* the archive is best-effort; the bot leaving is not */ }
    return Response.json({ ok: true, disconnected: true, leaveStatus: left, summary: (ended as { summary?: unknown })?.summary ?? null });
  }

  // ── ARM COMMAND MODE ──────────────────────────────────────────────────────────────────────────
  // Inside this window the next thing anh says is treated as a command WITHOUT the wake word.
  //
  // The wake word is the weakest link in the whole command feature: it is a proper noun, and proper
  // nouns are precisely what the ear gets wrong — "Minami" came back as "Mi Nami", "Minamino",
  // "Voice Spell". A command that depends on hearing the name correctly fails hardest in the
  // situation it exists to rescue. A button does not depend on the ear at all.
  if (body.action === "listen") {
    const secs = Math.min(60, Math.max(5, Number(body.seconds) || 15));
    s.commandUntil = Date.now() + secs * 1000;
    return Response.json({ ok: true, listening: secs, until: s.commandUntil });
  }

  // ── TYPE A CARD STRAIGHT ONTO THE BOARD ───────────────────────────────────────────────────────
  // The keyboard is the one input path that cannot be misheard. Voice capture exists for speed, but
  // when the ear has just mangled a name three times, asking anh to say it a fourth time is the wrong
  // answer — typing it is the only way to be certain what lands.
  if (body.action === "card") {
    const text = (body.text || "").trim();
    if (!text) return Response.json({ ok: false, error: "need text" }, { status: 400 });
    const kind = ["note", "decision", "action", "question"].includes(String(body.kind)) ? String(body.kind) : "note";
    // Grounded against its own text, the same check the judge's output must pass — typed input gets
    // no exemption from the rule that everything on the board traces to something real.
    s.board.apply({ op: "card", kind, label: text, topic: s.topic, source: text }, [text]);
    await repaint(req, s);
    return Response.json({ ok: true, added: kind, text });
  }

  if (body.action === "undo") {
    const gone = s.board.removeLast();
    if (gone) { s.undone = s.undone ?? []; s.undone.push(gone); }
    await repaint(req, s);
    return Response.json({ ok: true, removed: gone?.label ?? null, canRedo: (s.undone?.length ?? 0) > 0 });
  }

  if (body.action === "redo") {
    const back = s.undone?.pop();
    if (!back) return Response.json({ ok: true, restored: null, canRedo: false });
    s.board.restore(back);
    await repaint(req, s);
    return Response.json({ ok: true, restored: (back as { label?: string }).label ?? null, canRedo: (s.undone?.length ?? 0) > 0 });
  }

  // ── ABORT ─────────────────────────────────────────────────────────────────────────────────────
  // An armed mic with no way out is a trap: anh clicks Listen, changes his mind, and the next
  // sentence he says to a CUSTOMER gets parsed as a command and put on the shared board. Cancelling
  // has to be as cheap as arming.
  if (body.action === "cancel") {
    s.commandUntil = undefined;
    return Response.json({ ok: true, cancelled: true });
  }

  // ── A TYPED COMMAND ───────────────────────────────────────────────────────────────────────────
  // Same grammar as the spoken one, same applier — typing "new topic: Pricing" must do exactly what
  // saying it does, or the dock becomes a second, subtly different product.
  if (body.action === "command") {
    const text = (body.text || "").trim();
    if (!text) return Response.json({ ok: false, error: "need text" }, { status: 400 });
    const cmd = parseTyped(text);
    if (!cmd) return Response.json({ ok: false, error: "not a command", hint: "try: new topic: … / note that … / decision … / not X but Y / undo / tidy" }, { status: 422 });
    const said = applyCommand(s as unknown as CommandHost, cmd, (f, t) => {
      // Typed commands default to THIS CALL, matching the rename panel — a permanent language change
      // should be a deliberate checkbox, never a side effect of typing quickly.
      s.fixes = s.fixes ?? {};
      s.fixes[f.toLowerCase()] = t;
    });
    await repaint(req, s);
    return Response.json({ ok: true, ran: describeCommand(cmd), detail: said });
  }

  // ── SWITCH THE EAR, MID-CALL ──────────────────────────────────────────────────────────────────
  // Different meetings are different acoustic problems: an English-only call and a Vietnamese call
  // carrying English terminology are not the same task, and no single model has won both on this
  // voice. Switching takes effect on the NEXT chunk — a few seconds — because the current one is
  // already in flight, and it lasts only for this meeting.
  if (body.action === "ear") {
    /** ⚠️ AN EMPTY STRING MEANT "RESET", AND FALSY MEANT "IGNORED".
     *
     *  The dock's "Default" row posts model:"" — falsy, so this left s.stt untouched while still
     *  answering ok and flashing "Ear → Default". Once an ear was switched mid-call there was no way
     *  back, and since nothing validates the model id, one typo made every later chunk 502 with the
     *  only recovery being a server restart mid-meeting. `undefined` now means "not mentioned";
     *  empty string means "clear the override". */
    if (body.model !== undefined) s.stt = String(body.model) || undefined;
    if (body.lang !== undefined) s.sttLang = body.lang === null ? undefined : String(body.lang);
    return Response.json({ ok: true, ear: s.stt ?? "(default)", lang: s.sttLang === "" ? "auto" : s.sttLang ?? "(default)" });
  }

  // ── ROOM MODE ─────────────────────────────────────────────────────────────────────────────────
  // On when several people share anh's microphone. Clearing it also clears the roster: the names
  // belonged to a room that is no longer the situation.
  if (body.action === "room") {
    s.room = body.room !== false;
    if (!s.room) s.roster = undefined;
    return Response.json({ ok: true, room: s.room, roster: s.roster ?? [] });
  }

  if (body.action === "tidy") {
    s.forceTidy = true;
    return Response.json({ ok: true, tidyQueued: true });
  }

  // ── CORRECT A NAME ────────────────────────────────────────────────────────────────────────────
  /** LIST THE DICTIONARY. Adding corrections blind is how the same rule gets typed three times and
   *  how anh cannot tell whether a name is already handled. "Is Easy Vision already mapped?" was
   *  unanswerable from inside a call until this existed. */
  if (body.action === "dictionary") {
    const vocab = loadVocab();
    return Response.json({
      ok: true,
      universal: Object.entries(vocab.fixes ?? {}).map(([from, to]) => ({ from, to })),
      call: Object.entries(s.fixes ?? {}).map(([from, to]) => ({ from, to })),
      terms: (vocab.terms ?? []).slice(0, 200),
    });
  }

  if (body.action === "fix") {
    /** ⚠️ ONE NAME, MANY WAYS OF SAYING IT. This took a single `from`, so teaching the ear that
     *  "ecvision" is heard as "Easy Vision", "Easy Vision AI", "E C Vision" and "EC Vision" meant
     *  four trips through the panel — during a live call, while the wrong name accumulated on the
     *  board. A mishearing is rarely singular: an accent that defeats a decoder defeats it in several
     *  directions at once.
     *
     *  Comma or newline separated, so "Easy Vision, Easy Vision AI, E C Vision" is one action. */
    const froms = String(body.from || "")
      .split(/[,\n]+/).map((x) => x.trim()).filter(Boolean)
      // Longest first, so "Easy Vision AI" is consumed before "Easy Vision" can match inside it and
      // leave a stray " AI" behind — the same rule correctText follows.
      .sort((a, b) => b.length - a.length);
    const from = froms[0] ?? "";
    const to = (body.to || "").trim();
    if (!froms.length || !to) return Response.json({ ok: false, error: "need from and to" }, { status: 400 });
    const universal = body.scope === "universal";

    /** PREVIEW FIRST. A rename rewrites text on cards that are already on a shared screen, and the
     *  regex is case-insensitive and substring-based — "AI" would happily rewrite the middle of
     *  another word. Showing exactly which cards change, before anything changes, turns a blind
     *  mutation into a decision. Nothing is written on a preview. */
    if (body.preview) {
      /** ⚠️ A SEPARATE, NON-GLOBAL REGEX FOR THE TESTS. `.test()` on a /g regex advances lastIndex
       *  and it was never reset between cards, so the preview SKIPPED matches — it reported 2 of 3
       *  and the apply then changed all 3. A safeguard that undercounts is worse than none, because
       *  it is trusted. */
      const escP = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const probe = new RegExp(froms.map(escP).join("|"), "i");
      const re0 = new RegExp(froms.map(escP).join("|"), "gi");
      const hits = s.board.cards()
        .filter((c) => probe.test(c.label) || probe.test(c.detail ?? ""))
        .map((c) => ({ id: c.id, before: c.label, after: c.label.replace(re0, () => to) }));
      return Response.json({ ok: true, preview: true, from, to, matches: hits.length, cards: hits.slice(0, 8) });
    }

    if (universal) {
      const vocab = loadVocab();
      for (const f of froms) vocab.fixes[f.toLowerCase()] = to;
      saveVocab(vocab);
    } else {
      s.fixes = s.fixes ?? {};
      for (const f of froms) s.fixes[f.toLowerCase()] = to;
    }

    // Retroactive, always. Teaching only the future leaves the wrong name sitting on the board anh is
    // looking at, which reads as the correction having been ignored.
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // One alternation over every variant, still longest-first, so a card saying "Easy Vision AI" is
    // rewritten once and completely rather than partially by the shorter rule.
    const re = new RegExp(froms.map(esc).join("|"), "gi");
    const probeApply = new RegExp(froms.map(esc).join("|"), "i");
    let touched = 0;
    for (const c of s.board.cards()) {
      if (probeApply.test(c.label) || probeApply.test(c.detail ?? "")) {
        s.board.reviseById({
          id: c.id,
          label: c.label.replace(re, () => to),
          detail: (c.detail ?? "").replace(re, () => to) || undefined,
        });
        touched++;
      }
    }
    if (touched) await repaint(req, s);
    return Response.json({ ok: true, from, froms, to, scope: universal ? "universal" : "call", cardsUpdated: touched });
  }

  return Response.json({ ok: false, error: `unknown action ${body.action}` }, { status: 400 });
}
