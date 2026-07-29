# Redeploy protocol

Minami Bento hosts every live Claude session **inside its own web server**. A deploy replaces that
server, so it ends every in-flight turn on the box — including, quite possibly, the turn that asked for
the deploy. That one fact is why there is a protocol at all.

Two ways to ship. Pick by **where you are standing**.

---

## A. From Finder / Terminal — `Redeploy Minami.command`

Double-click **`Redeploy Minami.command`** in the project folder.

This Terminal window is not a child of the server, so the swap cannot kill the thing driving it. You get
the full build output live, and:

- If other chats are mid-turn, it names them and asks: **[w]** wait for them, **[f]** force through and
  cut them off, **[q]** quit.
- On success it verifies and prints `✓ done — reload http://localhost:3000`.
- The window stays open until you press return, so a failure is readable rather than a flash.

> First run from Finder: macOS may need `chmod +x "Redeploy Minami.command"` (already set in git), and
> Gatekeeper may ask once — right-click → Open.

---

## B. From a dashboard chat pane — say "redeploy"

Say any of: **"redeploy"**, **"push this to production"**, **"apply the changes to :3000"**.

The agent must run exactly this and nothing else:

```bash
bash bin/deploy.sh --detach
```

It returns in under a second and reports the log path. Then the agent finishes its reply **without
waiting** — the deploy is on its own now.

What happens after that, with no one watching:

1. The script waits for the box to go quiet (up to 5 min) — including *this* turn, which only ends when
   the agent stops talking. That is the whole reason for `--detach`.
2. It runs `bin/serve.sh`: preflight veto → build → drain (every pane gets a `restarting` notice) → swap.
3. It verifies against things that cannot lie (below) and writes the verdict to the log.
4. Your panes reconnect to the new build and reconcile from the on-disk JSONL. Nothing in the
   transcript is lost.

**Your panes will blink.** That is the deploy, not a crash.

### Checking the result

The requesting session dies with the old server, so it can never report the outcome itself. Ask in any
pane afterwards, or run:

```bash
bash bin/deploy.sh --verify-only     # what is serving right now
tail -30 ~/.minami/deploy.log      # what the deploy did
```

### The one rule for agents

Never run `bin/serve.sh` — or `bin/deploy.sh` without `--detach` — from inside a dashboard pane. If you
do, `deploy.sh` catches it: it walks its own process ancestry, sees the `:3000` server above it, and
detaches anyway with a note. The safety net exists because forgetting is the normal case, but state the
intent with the flag.

---

## Flags

| Command | Behaviour |
|---|---|
| `bash bin/deploy.sh` | Wait for quiet (300 s ceiling), swap, verify. Blocks. |
| `bash bin/deploy.sh --detach` | Same, detached into its own session; logs to `~/.minami/deploy.log`. |
| `bash bin/deploy.sh --now` | Skip the wait. `serve.sh` still vetoes if a turn is in flight. |
| `bash bin/deploy.sh --force` | Swap even mid-turn. Cuts live conversations off. |
| `bash bin/deploy.sh --wait 900` | Change the quiet-window ceiling. |
| `bash bin/deploy.sh --verify-only` | Probe what is serving. Changes nothing. |
| `npm run deploy` | Same as bare `bash bin/deploy.sh`. |

Extra assertions for routes that only exist in the new build — `400` rather than `404` proves a POST-only
route exists *and* its validation ran:

```bash
DEPLOY_PROBES="/api/fs/mkdir:400|405,/api/agent/browser/file:400" bash bin/deploy.sh --detach
```

---

## How success is judged

"The script exited 0" is not evidence. `next build` writes `.next` in place underneath the running
server, so a build can succeed while the swap silently fails and the *old* process keeps serving — that
happened, and it looked exactly like a successful deploy (`KNOWLEDGE.md` §8). So the verification asserts:

- **The server PID changed.** Proves the old process is gone, not merely that *a* server answers.
- **`.next/BUILD_ID` changed.** Proves new bytes on disk. Unchanged is reported, not failed — you may
  genuinely have deployed no code change.
- `GET /` and `GET /kb` return 200, plus any `DEPLOY_PROBES`.

---

## When it goes wrong

| Symptom | What it means | Do this |
|---|---|---|
| `✋ still busy after 300s` | Another pane ran long. Nothing was touched. | Re-run, or `--force` if you know what it kills. |
| `✗ same process as before the swap` | Build succeeded, swap didn't. Old build still serving. | `tail -50 ~/.minami/prod.log`, then re-run. |
| `✗ nothing is listening on :3000` | New server failed to boot (often `EADDRINUSE`). | `tail -50 ~/.minami/prod.log`; `lsof -ti tcp:3000`. |
| Build fails on missing `typescript`/`tailwindcss` | `NODE_ENV=production` made `npm install` prune devDeps. | `npm install --include=dev`. |
| Panes show "restarting" then reconnect | Normal. That's the drain notice. | Nothing. |

The knowledge base at **`localhost:4400`** (`npm run kb`, or double-click `Open Knowledge Base.command`)
is deliberately a separate server, so it stays readable while `:3000` is down — which is exactly when
you need it.
