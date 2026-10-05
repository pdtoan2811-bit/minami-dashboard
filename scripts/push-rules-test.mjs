// The notifier's rules against a fake clock, fake sender and fake live feed (§24). Imported by
// scripts/push-test.mjs; not run on its own.
import path from "node:path";

export async function run(jiti, root, check) {
  const { createNotifier, SUMMARY_TAG } = await jiti.import(path.join(root, "lib/push/notifier.ts"));
  let now = 1_000_000;
  const sent = [];
  const live = {};
  const devs = [{ endpoint: "https://push.example/a", finished: true }, { endpoint: "https://push.example/b", finished: false }];
  const n = createNotifier({
    now: () => now, devices: () => devs, needs: () => live, label: (sid) => `proj · ${sid}`,
    send: (dev, payload, opts) => sent.push({ dev: dev.endpoint, payload, opts }),
  });
  const need = (id, kind, extra = {}) => ({ id, kind, tool: kind === "question" ? "AskUserQuestion" : "Bash", summary: `${kind} ${id}`, ...extra });
  const raise = (sid, nd) => { live[sid] = { cwd: "/x/" + sid, need: nd }; n.onNeed(sid, "/x/" + sid, nd); };
  const settle = (sid) => { delete live[sid]; };
  const take = () => sent.splice(0);

  // 1. question with options → heads-up, two answer buttons, one nonce per device per button.
  raise("s1", need("p1", "question", { options: ["Yes", "No", "Maybe"] }));
  let out = take();
  check("question: one push per device", out.length === 2);
  check("question: heads-up, tag = sessionId", out.every((x) => x.payload.silent === false && x.payload.tag === "s1" && x.opts.urgency === "high"));
  check("question: first two options as actions", JSON.stringify(out[0].payload.actions.map((a) => a.title)) === '["Yes","No"]' && Object.keys(out[0].payload.nonces).length === 2);
  check("question: url opens the chat", out[0].payload.url === "/?open=s1");

  // 2. nonce: bound to its device, one-time, and spending one spends its sibling.
  const [a0, a1] = Object.values(out[0].payload.nonces);
  check("nonce: wrong endpoint refused", n.consume(a0, "https://push.example/b") === null);
  const b = n.consume(a0, "https://push.example/a");
  check("nonce: valid → binding", b && b.sessionId === "s1" && b.needId === "p1" && b.act.type === "answer" && b.act.label === "Yes");
  check("nonce: reuse refused", n.consume(a0, "https://push.example/a") === null);
  check("nonce: sibling spent too", n.consume(a1, "https://push.example/a") === null);

  // 3. resolved elsewhere → close pushed on the next tick.
  settle("s1");
  n.tick();
  out = take();
  check("resolve: close sent to every device", out.length === 2 && out.every((x) => x.payload.t === "close" && x.payload.tag === "s1"));

  // 4. same chat again within 5 min → silent update; after 5 min → heads-up again.
  now += 60_000;
  raise("s1", need("p2", "held"));
  out = take();
  check("dedupe: second need in 5 min is silent", out.every((x) => x.payload.silent === true));
  check("held: Open + Deny, nonce only on Deny", JSON.stringify(out[0].payload.actions.map((a) => a.action)) === '["open","deny"]' && Object.keys(out[0].payload.nonces).join() === "deny");
  check("held: no approve button anywhere", !out.some((x) => x.payload.actions.some((a) => /allow|approve/i.test(a.action + a.title))));
  settle("s1"); n.tick(); take();
  now += 5 * 60_000;
  raise("s1", need("p3", "plan"));
  out = take();
  check("dedupe: after 5 min it's heads-up again", out.every((x) => x.payload.silent === false));
  check("plan: Open only", JSON.stringify(out[0].payload.actions.map((a) => a.action)) === '["open"]' && !Object.keys(out[0].payload.nonces).length);
  settle("s1"); n.tick(); take();

  // 5. burst: 4 chats inside 30s → 3 individual + one summary; the summary closes when all settle.
  now += 10 * 60_000;
  for (const s of ["b1", "b2", "b3", "b4", "b5"]) { raise(s, need("q-" + s, "permission")); now += 1000; }
  out = take();
  const tags = out.map((x) => x.payload.tag);
  check("burst: first three individual", ["b1", "b2", "b3"].every((t) => tags.includes(t)) && !tags.includes("b4") && !tags.includes("b5"));
  const sums = out.filter((x) => x.payload.tag === SUMMARY_TAG);
  check("burst: summary heads-up once, then silent", sums.length === 4 && sums[0].payload.silent === false && sums[2].payload.silent === true && /chats need you/.test(sums[0].payload.body));
  for (const s of ["b1", "b2", "b3", "b4"]) settle(s);
  n.tick(); out = take();
  check("burst: summary stays while one member is blocked", !out.some((x) => x.payload.t === "close" && x.payload.tag === SUMMARY_TAG));
  settle("b5"); n.tick(); out = take();
  check("burst: summary closed when all settled", out.some((x) => x.payload.t === "close" && x.payload.tag === SUMMARY_TAG));

  // 6. presence: a need for a chat on screen is held, and sent when the screen goes away.
  now += 10 * 60_000;
  n.markPresence("p");
  raise("p", need("pp", "question"));
  check("presence: nothing sent while looked at", take().length === 0);
  now += 20_000; n.tick();
  check("presence: still nothing inside 45s", take().length === 0);
  n.markPresence("p", true); n.tick(); out = take();
  check("presence: sent once the page is gone", out.length === 2 && out[0].payload.tag === "p");
  settle("p"); n.tick(); take();

  // 7. finished: silent, only for turns > 60s, only to devices that want it; failure says why.
  n.onEnded("f", "/x/f", { ok: true, text: "\n  All done, 3 files changed\nmore", turnMs: 30_000 });
  check("finished: short turn → nothing", take().length === 0);
  n.onEnded("f", "/x/f", { ok: true, text: "\n  All done, 3 files changed\nmore", turnMs: 90_000 });
  out = take();
  check("finished: silent, to opted-in device only", out.length === 1 && out[0].dev.endsWith("/a") && out[0].payload.silent === true && out[0].payload.body === "All done, 3 files changed");
  n.onEnded("f", "/x/f", { ok: false, error: "error_during_execution\nstack", turnMs: 90_000 });
  out = take();
  check("finished: failure body", out[0]?.payload.body === "Failed: error_during_execution");

  // 7b. a long turn that was mostly waiting on the user, just unblocked → no "finished" on top.
  raise("w", need("w1", "question"));
  take();
  settle("w"); n.tick(); take();
  now += 10_000;
  n.onEnded("w", "/x/w", { ok: true, text: "Tea", turnMs: 120_000 });
  check("finished: suppressed right after an unblock", take().length === 0);

  // 8. a need queued behind the one on screen replaces it silently when the first settles.
  raise("q", need("q1", "held"));
  take();
  live.q = { cwd: "/x/q", need: need("q2", "held") }; // q1 answered in the app, q2 was waiting behind it
  n.tick(); out = take();
  check("queued need: silent replace, not close", out.length === 2 && out.every((x) => x.payload.t === "show" && x.payload.silent && x.payload.body === "held q2"));

  // 9. nonce expiry follows the need's own expiresAt.
  now += 20 * 60_000;
  raise("e", need("e1", "held", { expiresAt: now + 10_000 }));
  out = take();
  const dn = out[0].payload.nonces.deny;
  now += 11_000;
  check("nonce: expires with the need", n.consume(dn, out[0].dev) === null);
}
