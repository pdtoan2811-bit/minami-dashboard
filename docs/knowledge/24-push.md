# Web push — the phone buzzes when a chat needs you

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 24. Notifications — `lib/push/*`, `public/sw.js`, `lib/push-client.ts`, `/api/push/*`

The installed phone app (§23) only knew a chat was blocked while it was open. A question asked while
the phone was in a pocket waited until the next time someone happened to look. Push closes that gap.
Built 2026-10-05 to a spec agreed with the user.

### The pieces

```
manager.ts liveEvents ("need" / "ended")          ← emitted where pending entries are created / turns end
  → lib/push/server.ts   startPush(), once per process (globalThis guard), from instrumentation.ts
  → lib/push/notifier.ts the rules — pure, clock/sender/feed injected
  → lib/push/webpush.ts  VAPID (RFC 8292) + aes128gcm (RFC 8291), node:crypto only
  → push service (FCM for Chrome) → public/sw.js → showNotification
public/sw.js action tap → POST /api/push/act { nonce, endpoint } → manager answer()/decide()
lib/push/store.ts        ~/.minami/push.json (MINAMI_PUSH_FILE): VAPID keys + devices + per-device prefs
```

**Why hand-rolled, not the `web-push` package.** It isn't installed, and installing a dependency on
this box is its own hazard (`npm install` prunes devDependencies in main and de-symlinks
`node_modules` in a worktree). The protocol is about a hundred lines of HMAC, ECDH and AES-GCM.
`encrypt()` reproduces RFC 8291 Appendix A byte for byte (`node scripts/push-test.mjs`).

**The VAPID key pair is generated once and must never change.** Every subscription is bound to the
public key it was made against. A new key makes every push 403 at the push service, and nothing on
the phone shows it. `enablePush()` compares the existing subscription's key with the server's and
re-subscribes on a mismatch, so deleting `push.json` is recoverable by toggling once per device.

### The rules (`lib/push/notifier.ts`)

| Event | Notification |
|---|---|
| need: question / plan / held / permission | heads-up (`renotify`, not `requireInteraction`), tag = sessionId, title `<project> · <chat title>`, body = `need.summary` |
| another need, same chat, < 5 min since its last heads-up | same tag, **silent** update |
| > 3 chats raise needs within 30s | one `minami-summary` "N chats need you" (heads-up once, then silent); closed when all its chats settle |
| need settled anywhere | `{ t: "close", tag }` push; the worker closes it |
| turn ended, `turnMs` > 60s | silent notice on the chat's tag: first line of the reply, or `Failed: <first line>`; per-device pref, default on |
| chat on screen (presence ping < 45s) | nothing; sent when the pings stop if the chat is still blocked |

**Buttons.** Chrome on Android renders two at most. A single single-select question gets its first two
options (`needOf` only sets `options` in that case). Held and permission steps get Open and Deny.
Plans and other questions get Open. There is no approve button for any tool. A Bash command, an edit,
a merge or a plan is approved by reading it, and a lock screen shows one truncated line. Deny only
stops a step. `Binding.act` has no "allow" variant, so the type system won't let one be minted.

**"Settled" is detected by polling, not by a new event.** A pending prompt is removed in six places in
the manager: answer, decide, the hold timeout, Stop, session end and close. A `resolved` emit would
need all six, and a missed one leaves a notification with live-looking buttons. While any notification
is outstanding, `tick()` reads `liveActivity()` every 3s. It stops when nothing is outstanding. If a
second need was queued behind the one on screen, the notification is replaced silently instead of
closed.

**The finished notice skips a turn that was just unblocked.** `turnMs` includes time spent blocked on the
user. In the end-to-end run, answering "Left or right?" produced a "finished" notification for the
same chat a few seconds later, because the turn had been open for 60s+ while waiting on the answer.
A turn that ends within 60s of a notified need being settled now sends nothing.

### Security (`/api/push/act`)

The dashboard is unauthenticated on the tailnet. `/api/push/act` accepts only a nonce:

- 144 random bits, minted per action button per device, held in memory.
- Bound to `{ sessionId, needId, action, device endpoint }`. A nonce presented with another endpoint is
  refused and stays valid for its own device.
- Single use. Spending one spends its sibling (the other button on the same notification).
- Expires with the need (`expiresAt`, the hold auto-deny) or after 15 min, whichever is first.
- Re-checked against the live prompt: an answer nonce works only on a single `AskUserQuestion`, and a
  deny nonce never answers a question.
- Then it calls `answer()` / `decide()` with the key from `pendingFor()`, the same functions the
  pane's buttons reach through `/api/agent/answer` and `/api/agent/permission`.

The route never takes a sessionId or a decision from the request. The nonces are in memory, so a
server restart invalidates them. A restart also kills every session and its pending prompts, so the
nonces could not have done anything afterwards anyway.

`/api/push/subscribe` accepts `https:` endpoints only. The server POSTs to every stored endpoint on
every need, so accepting `http://127.0.0.1:…` would let anyone on the tailnet make it send requests
to local services.

### The service worker has no fetch handler

That is deliberate. A worker that cached HTML or JS would pin the installed app to the build it cached.
That is the bug `lib/use-build-refresh.ts` fixed (§23), and the fix depends on `/api/build` and the
reload both reaching the network. With no fetch listener every request bypasses the worker. Verified:
the page is controlled and `/api/build` still returns the live id. `/sw.js` is served `no-cache` and
registered with `updateViaCache: "none"`, so a fixed worker reaches the phone with the next deploy.

**Opening a chat from a tap.** The worker focuses an existing window first, because the permission to
raise a window lasts only briefly after the tap. It then posts `{ type: "minami:open", sessionId }`.
If the page acknowledges within 700ms (`usePushRegistration({ onOpen })`), it switches chats in
place. Otherwise the worker navigates to `/?open=<id>`. With no window open it calls
`openWindow('/?open=<id>')`. If an action fails (already answered, nonce expired, server
mid-deploy), the worker opens the chat, so a tap always does something.

### Known limits

- **Close pushes cost Chrome's budget.** Chrome expects each push to show a notification
  (`userVisibleOnly`). A push that only closes one is tolerated a few times. Past that, Chrome may
  show its own "This site has been updated in the background". This was not observed in testing, and
  a server cannot avoid it. If it shows up, the fix is to stop sending closes for needs older than a
  few minutes.
- **Android hasn't been tested on a device.** Delivery was verified on desktop Chrome through real
  FCM. Android uses the same FCM path, but how the two action buttons render, and whether the
  heads-up appears with the screen off, still need checking on the Find N5 / Flip 7.
- Presence only works where the page calls `usePushPresence(sessionId)`. Until that is wired in, a
  chat being read on the phone can still buzz.

### Verification (2026-10-05)

Production build on :3019 (`MINAMI_AUTOPILOT_DISABLE=1`, `MINAMI_PUSH_FILE` in /tmp), Google Chrome
via Playwright, headless, notifications granted:

| Check | Result |
|---|---|
| RFC 8291 Appendix A vector, decrypt round-trip, VAPID signature verifies | pass (`scripts/push-test.mjs`) |
| 27 rule checks (heads-up/silent, 5-min dedupe, burst summary, presence defer, finished, nonce binding/expiry/reuse) | pass, same script |
| Settings toggle → permission → subscribe → `push.json` gets an `fcm.googleapis.com` device, file mode 0600 | pass |
| Server-encrypted push → FCM 201 → Chrome decrypted it → worker showed it | pass |
| Real Haiku session asks "Tea or coffee?" → notification with Tea / Coffee buttons, tag = sessionId | pass |
| Worker `runAction(Coffee)` → `/api/push/act` → turn resumed and replied "Coffee" | pass |
| Same nonce again → 403; nonce with a forged endpoint → 403; bare `{sessionId, decision}` → 400 | pass |
| Question answered via `/api/agent/answer` (as the pane does) → server close push → notification gone | pass |
| Held `Write` step → Open + Deny (nonce only on Deny) → Deny from worker → file not written, turn replied "denied" | pass |
| Tap with a page that acks → handled in place, no navigation; without ack → navigated to `/?open=` | pass |
| Bad nonce → falls back to opening `/?open=` | pass |

The test transcripts were deleted afterwards.
