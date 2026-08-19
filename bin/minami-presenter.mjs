#!/usr/bin/env node
// MINAMI PRESENTER — our own browser joins the meeting and screen-shares the canvas at 1080p.
//
//   node bin/minami-presenter.mjs <meet-url> [canvas-url]
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// Recall renders the bot's page at a fixed 1280x720 @ 15fps on EVERY variant, including web_gpu.
// That cap is Recall's, not Google's — a human sharing a screen in Meet gets 1080p, which is exactly
// the discrepancy anh spotted. So the output leg moves here and Recall keeps the input leg, which it
// does superbly: per-participant audio tagged with real roster names.
//
//   Recall bot    → audio IN   (proven on a real meeting, keep it)
//   this presenter → video OUT  (1080p, because it is just Chrome doing what Chrome does)
//
// ── How the screen share is started without a human ─────────────────────────────────────────────
// getDisplayMedia normally opens a picker that requires a click. Two Chrome flags remove it:
//
//   --auto-select-desktop-capture-source=<title>   pick the matching window/tab, no picker
//   --auto-accept-this-tab-capture                 skip the "share this tab?" confirmation
//
// The canvas is loaded in a SECOND tab with a known title, and the picker matches on that title. This
// is why the canvas page's <title> matters and must stay stable.
//
// ── The thing that decides whether this works at all: SIGN-IN ───────────────────────────────────
// Measured against a real meeting 2026-08-12: a signed-out browser is refused outright — Meet renders
// "You can't join this video call" and never offers the name box. Anonymous guest join is not a
// fallback for this; it is a dead end.
//
// So the presenter must be a signed-in Google account. Automating the sign-in FORM is the wrong move
// — it is precisely what Google's anti-automation defences exist to stop, and a large part of what
// Recall actually sells is a fleet of accounts that stay logged in.
//
// The way through is to never automate it: sign in ONCE by hand into a persistent profile, and reuse
// that profile forever. The session cookie survives restarts and reboots.
//
//     node bin/minami-presenter.mjs --login          # opens a browser; sign in, then close it
//     node bin/minami-presenter.mjs <meet-url>       # every run after that
//
// ── What else this needs ────────────────────────────────────────────────────────────────────────
//   · a Chrome/Chromium with a real display. On the Hetzner box that means Xvfb — headless Chrome
//     cannot screen-share, because there is no screen. `xvfb-run -s "-screen 0 1920x1080x24"`.
//   · someone to admit it, exactly like the Recall bot.
//
// ── Read this before running it against a client call ───────────────────────────────────────────
// This automates a Google Meet client, which their ToS does not clearly permit. It is fine for your
// own internal meetings. Do not point it at someone else's call without asking them first.

import { chromium } from "playwright";
import { spawn } from "node:child_process";

const CHROME_BIN = process.env.CHROME_BIN
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const MEET = process.argv[2];
const CANVAS = process.argv[3] || process.env.RECALL_CANVAS_URL || "http://localhost:3010/canvas?broadcast=1";
const NAME = process.env.PRESENTER_NAME || "Minami";
/** The canvas tab's document.title — what the capture flag matches on. */
const TAB_TITLE = process.env.PRESENTER_TAB_TITLE || "Minami Bento — Claude Code mission control";

if (!MEET) {
  console.error("usage: node bin/minami-presenter.mjs <meet-url> [canvas-url]");
  console.error("       node bin/minami-presenter.mjs --login     (once, to sign in)");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Where the signed-in Google session lives. One directory, reused forever. */
const PROFILE = process.env.PRESENTER_PROFILE || `${process.env.HOME}/.minami/presenter-profile`;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false, // screen capture needs a real display; use xvfb-run on the server

  // REAL CHROME, NOT BUNDLED CHROMIUM — and this is what makes sign-in possible at all.
  //
  // Google refuses to authenticate an automated browser: "This browser or app may not be secure."
  // Hit on the first attempt here. Two things cause it, and both have to go:
  //   · Playwright's bundled Chromium is not Google Chrome, and Google can tell.
  //   · `--enable-automation` (a Playwright default) sets navigator.webdriver and announces itself.
  // `channel: "chrome"` uses the Chrome actually installed on the machine; ignoreDefaultArgs strips
  // the flag; --disable-blink-features=AutomationControlled removes the residual webdriver signal.
  //
  // If Google still refuses, the fallback needs no sign-in at all: quit Chrome, copy your real
  // profile — cp -R "~/Library/Application Support/Google/Chrome/Default" — over PROFILE, and the
  // session comes with it.
  channel: "chrome",
  ignoreDefaultArgs: ["--enable-automation"],

  viewport: null, // let the real window drive the size; a fixed viewport fights --window-size
  permissions: ["camera", "microphone"],
  args: [
    "--disable-blink-features=AutomationControlled",
    "--auto-accept-this-tab-capture",
    // BOTH matchers, and how that was arrived at is worth recording.
    //
    // `--auto-select-tab-capture-source-by-title` alone never matched anything, and that was
    // invisible for three runs because Chrome DOES NOT FAIL when a matcher misses — it shares the
    // first available tab instead. With a stray about:blank open that produced a blank white share
    // while every log line said "SHARING"; closing about:blank produced no share at all, which is
    // what finally proved the matcher was the problem rather than the fallback.
    //
    // `--auto-select-desktop-capture-source` is the older, more widely supported flag and matches
    // tabs by title too. It was removed earlier for grabbing the Meet window — but that was while the
    // canvas title was still being overwritten by Next, so nothing matched and Chrome fell back to a
    // window. With the title pinned and verified before the share, it resolves to the canvas tab.
    `--auto-select-desktop-capture-source=${TAB_TITLE}`,
    `--auto-select-tab-capture-source-by-title=${TAB_TITLE}`,
    // Meet checks for a camera and mic. Fakes keep it from blocking on hardware that isn't there,
    // and a fake mic is also the honest choice: this client is a display, and it must never transmit
    // audio from the room it is sitting in.
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--window-size=1920,1080",
  ],
});
const browser = { close: () => ctx.close() };

// ── ONE-TIME SIGN-IN ────────────────────────────────────────────────────────────────────────────
if (MEET === "--login") {
  const p = await ctx.newPage();
  await p.goto("https://accounts.google.com/");
  console.log("\n  Sign in to the account Minami should present as, then CLOSE the browser window.");
  console.log(`  The session is saved to ${PROFILE} and reused by every later run.\n`);
  await p.waitForEvent("close", { timeout: 0 }).catch(() => {});
  await ctx.close();
  process.exit(0);
}

// CLOSE THE STRAY about:blank FIRST.
//
// launchPersistentContext opens one by default, and it is not harmless: when
// --auto-select-tab-capture-source-by-title fails to match, Chrome does not error — it falls back to
// the first available tab and shares THAT. about:blank is first, so the meeting gets a blank white
// rectangle while every log line still says "SHARING". Removing the candidate is what turns a silent
// wrong-source fallback into a loud failure we can see.
for (const p of ctx.pages()) {
  if (p.url() === "about:blank") await p.close().catch(() => {});
}

// THE CANVAS RUNS IN ITS OWN CHROME PROCESS, IN APP MODE.
//
// Every attempt to select it inside the presenter's own browser failed the same way. Chrome's
// matchers select by TITLE, and a browser window is titled after its active tab — so "Minami Canvas"
// matched the window that also held the Meet tab, and Meet got shared into Meet. A popup did not help
// either: Playwright opens window.open() as a tab.
//
// `--app=<url>` is the escape. It creates a real OS window with no tab strip, containing exactly one
// page, titled by that page. Desktop capture enumerates OS windows, so the presenter's browser can
// now match a window that provably contains only the canvas. There is nothing else inside it to leak.
//
// A second process rather than a second context, because app mode is a launch flag.
const canvasProc = spawn(CHROME_BIN, [
  `--app=${CANVAS}`,
  `--user-data-dir=${PROFILE}-canvas`,
  "--window-size=1920,1080",
  "--window-position=0,0",
  "--no-first-run",
  "--no-default-browser-check",
], { detached: true, stdio: "ignore" });
canvasProc.unref();
log(`canvas window launched in app mode (pid ${canvasProc.pid})`);
// Give Chrome time to paint and settle its window title before anything looks for it.
await new Promise((r) => setTimeout(r, 6000));
// The app window's title comes from the page itself. Next sets it to its metadata title, so the
// matcher must use THAT, not an invented one — there is no page handle here to override it with.
log(`canvas window → ${CANVAS}  (matching window title: "${TAB_TITLE}")`);

const meet = await ctx.newPage();
await meet.goto(MEET, { waitUntil: "domcontentloaded" });
log(`opened ${MEET}`);

// Meet's DOM is not a contract and these selectors will rot. Each step is therefore best-effort and
// logged, so a failure says WHICH step broke rather than "it didn't work".
async function tryClick(page, selectors, what) {
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2500 })) {
        await el.click({ timeout: 2500 });
        log(`  ✓ ${what}`);
        return true;
      }
    } catch { /* next selector */ }
  }
  log(`  – ${what}: not found (Meet's DOM may have changed)`);
  return false;
}

await meet.waitForTimeout(3500);

// FAIL FAST AND SAY WHY. A signed-out browser gets this screen and nothing else — no name box, no
// join button — so without this check the run just times out in the "waiting to be admitted" loop
// and looks like nobody let it in. Observed on a real meeting before the persistent profile existed.
if (await meet.locator('text=You can\'t join this video call').first().isVisible({ timeout: 1500 }).catch(() => false)) {
  log("REFUSED: Meet will not admit this browser — it is not signed in.");
  log("Run `node bin/minami-presenter.mjs --login` once, sign in, then retry.");
  await browser.close();
  process.exit(2);
}

// Meet's own pre-join dialog does exactly what we want in one click, and it is the reliable path:
// "Continue without microphone and camera". A presenter that transmits the room's audio back into
// the room is a feedback loop, and a black camera tile is just noise in the grid.
await tryClick(meet, [
  'button:has-text("Continue without microphone and camera")',
  'button:has-text("Continue without microphone")',
], "declined mic + camera");

// Fall back to the individual toggles if that dialog didn't appear.
await tryClick(meet, ['[aria-label*="Turn off microphone"]', '[data-is-muted="false"][aria-label*="microphone" i]'], "mic off");
await tryClick(meet, ['[aria-label*="Turn off camera"]', '[data-is-muted="false"][aria-label*="camera" i]'], "camera off");

// Type a display name if Meet is asking for one (the signed-out guest path).
try {
  const nameBox = meet.locator('input[aria-label*="name" i], input[placeholder*="name" i]').first();
  if (await nameBox.isVisible({ timeout: 3000 })) {
    await nameBox.fill(NAME);
    log(`  ✓ name "${NAME}"`);
  }
} catch { /* signed in, or no name prompt */ }

await tryClick(meet, [
  'button:has-text("Ask to join")',
  'button:has-text("Join now")',
  '[aria-label*="Ask to join" i]',
  '[aria-label*="Join now" i]',
], "requested to join");

log("waiting to be ADMITTED…");
const admitted = await meet
  .locator('[aria-label*="Leave call" i], [aria-label*="Present now" i], [aria-label*="Share screen" i]')
  .first()
  .waitFor({ state: "visible", timeout: 300_000 })
  .then(() => true)
  .catch(() => false);

if (!admitted) {
  log("never admitted — leaving");
  await browser.close();
  process.exit(1);
}
log("✓ in the call");

/** Everything clickable and visible, with its text. Meet's DOM is not a contract and guessing at it
 *  twice has already cost two meetings — so when a step fails, the script reports what WAS there
 *  instead of leaving us to imagine it. */
async function dumpClickables(page, label) {
  const items = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, [role="button"], [role="menuitem"], li, [jsname]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 0.05) continue;
      const text = (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 60);
      const aria = el.getAttribute("aria-label") || "";
      if (!text && !aria) continue;
      out.push(`${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[${el.getAttribute("role")}]` : ""} · "${text}" · aria="${aria.slice(0, 60)}"`);
    }
    return [...new Set(out)].slice(0, 45);
  }).catch(() => []);
  log(`  ── ${label}: ${items.length} clickable ──`);
  for (const i of items) log(`     ${i}`);
}

// Start presenting. The flags above mean the picker should resolve itself to the canvas tab.
await meet.waitForTimeout(2500);
if (!(await tryClick(meet, [
  '[aria-label*="Present now" i]',
  '[aria-label*="Share screen" i]',
  '[aria-label*="Present" i]',
  'button:has-text("Present now")',
], "opened present menu"))) {
  await dumpClickables(meet, "call controls (present button not found)");
}

await meet.waitForTimeout(1800);

// If --auto-select-tab-capture-source-by-title did its job there is NO picker to click, and hunting
// for one and reporting "not found" made a perfectly good run read as a failure. Check whether the
// share already started before deciding anything is wrong.
const alreadySharing = await meet
  .locator('text=/stop presenting/i').first()
  .isVisible({ timeout: 2500 }).catch(() => false);

if (alreadySharing) {
  log("  ✓ picker auto-resolved to the canvas tab (no click needed)");
} else if (!(await tryClick(meet, [
  'li:has-text("A tab")', 'span:has-text("A tab")',
  '[role="menuitem"]:has-text("tab")', 'button:has-text("tab")',
  'li:has-text("A window")', '[role="menuitem"]:has-text("window")',
], "chose a tab"))) {
  await dumpClickables(meet, "present menu (tab option not found)");
}

await meet.waitForTimeout(3000);
await meet.screenshot({ path: "/tmp/presenter-state.png" }).catch(() => {});
// Shoot the CANVAS tab too. "Nothing is streaming" has two very different causes — the wrong tab was
// captured, or the right tab is blank — and they are indistinguishable from the Meet side.
log(`open tabs: ${ctx.pages().map((p) => `"${p.url().slice(0, 46)}"`).join(", ")}`);
const presenting = await meet.locator('text=/stop presenting/i').first().isVisible({ timeout: 3000 }).catch(() => false);
log(presenting ? "✓ SHARING — Meet reports a presentation is live" : "✗ NOT SHARING — no 'Stop presenting' control found");
log("screenshot: /tmp/presenter-state.png");
log("Ctrl-C to stop and leave the call.");

const bye = async () => { try { process.kill(-canvasProc.pid); } catch {} try { await browser.close(); } catch {} process.exit(0); };
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
await new Promise(() => {}); // hold the call open
