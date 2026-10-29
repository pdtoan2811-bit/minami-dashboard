// Next.js instrumentation hook — register() runs once per server instance (`next dev` AND `next
// start`), before any request is handled. Stable since Next 15, no config flag needed.
//
// Safety net for the live-drive agent (lib/agent/manager.ts): several Agent SDK calls return promises
// that are intentionally fire-and-forget from route handlers (e.g. Query.setPermissionMode(), called
// from the mode-toggle route with no reason to block the response on it). Each such call site should
// attach its own `.catch()` — see setMode() — but this is the backstop for whatever still slips
// through. Without ANY process-level handler, Node's default behavior on an unhandled promise
// rejection is to crash the whole process — silently killing every open chat pane over one bad promise
// in one unrelated pane. This logs instead of crashing.
//
// `uncaughtException` is different: continuing after one is explicitly unsafe (Node's own docs say
// so — the process may be in a corrupted state), so this logs for visibility and then exits, rather
// than dying silently with no trace of why.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  process.on("unhandledRejection", (reason) => {
    console.error("[minami] unhandled rejection (recovered, not crashing):", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[minami] uncaught exception — exiting to avoid an inconsistent process state:", err);
    process.exit(1);
  });

  // Autopilot (lib/autopilot/runner.ts). Started here rather than lazily from a route because its
  // FIRST job is crash recovery: if the previous server died holding a conflicted merge, the checkout
  // is broken right now, and nobody should have to visit a page to get that undone. It reads its own
  // on-disk switch and does nothing at all while that is off, which is the shipped default.
  try {
    const { startAutopilot } = await import("@/lib/autopilot/runner");
    startAutopilot();
  } catch (e) {
    console.error("[minami] autopilot failed to start (the app is fine without it):", e);
  }

  // Web push (lib/push/server.ts, §24). Here rather than lazily because a need raised while no page
  // is open — the phone in a pocket — is the entire point; nothing would ever visit a route first.
  // It subscribes to liveEvents and does nothing else until a device has subscribed.
  try {
    const { startPush } = await import("@/lib/push/server");
    await startPush();
  } catch (e) {
    console.error("[minami] web push failed to start (the app is fine without it):", e);
  }

  // The 07:30 "pick up where you left off" push (lib/morning-push.ts, §37).
  try {
    const { startMorningPush } = await import("@/lib/morning-push");
    startMorningPush();
  } catch (e) {
    console.error("[minami] morning push failed to start:", e);
  }

  // The Today plan runs itself (lib/today-autorun.ts, §26): here because the point is that nobody has to
  // open the page for the morning's to-dos to start.
  try {
    const { startTodayAutorun } = await import("@/lib/today-autorun");
    startTodayAutorun();
  } catch (e) {
    console.error("[minami] today autorun failed to start:", e);
  }

  // "Để Minami trả lời" Slack talk threads (lib/team-chat.ts, §25). Here because a deploy restarts the
  // server mid-conversation, and your next reply in the thread should still reach the chat.
  try {
    const { startMinamiBridge } = await import("@/lib/team-chat");
    startMinamiBridge();
  } catch (e) {
    console.error("[minami] team talk bridge failed to start:", e);
  }
}
