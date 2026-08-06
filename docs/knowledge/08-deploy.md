# Deployment

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md) — the index lists every doc and
which `§` ids live where. Section numbers are stable: code comments cite them.

---

## 8. Deployment

`bin/serve.sh` builds then swaps a **production** server on `:3000`, killing only the process bound
to that port. Production mode is deliberate: `next dev`'s Fast Refresh hot-patches the running page,
so using the dashboard to edit the dashboard's own code would change React's hook signatures
mid-session and crash the very tab driving the edit.

**The home page is local-only.** It reads `~/.claude/projects` and drives the local `claude` login,
so on Vercel it renders and finds nothing. Only `/dashboard` is remote-safe.

### The deploy has to outlive whoever asked for it

`serve.sh` alone is not usable from a chat pane, and a chat pane is where deploy requests actually come
from. That pane's `claude` is a *grandchild* of the `next-server` the script must kill, so an inline run
kills its own requester mid-sentence — and `serve.sh` would veto it first anyway, since the requesting
turn is itself "busy". The deadlock is structural: the caller can never be quiet while it is calling.

`bin/deploy.sh` breaks it by **detaching before waiting**. It walks its own process ancestry looking for
the PID bound to `:3000`; finding it means "I am inside the thing I'm about to kill", so it re-execs
itself into a new session (macOS has no `setsid` — it forks through `python3`'s `os.setsid()`, since a
plain `&` leaves the child in a process group a group-kill can still reach), then waits for the box to
go quiet, swaps, and verifies into `~/.minami/deploy.log`. Waiting rather than `--force` is what keeps
the deploy polite to *other* panes: `serve.sh`'s own veto still runs after the wait.

### `next build` is not a safe way to check that code compiles

`npm run build` writes `.next` **in place**, and the live server keeps its manifests in memory. So a
"harmless" verification build leaves a server handing out HTML that references CSS and JS hashes which
no longer exist on disk: every asset 400s, the page never hydrates, and the dashboard renders as
unstyled text stuck on "Reading local sessions…" — no tiles, no panes, no browser preview. It survives
a reload. Only a restart clears it.

Use **`npm run build:check`** (`NEXT_DIST_DIR=.next-verify next build`) instead. `deploy.sh` is the one
thing allowed to overwrite `.next`, because it restarts the server in the same breath.

**`next dev` clobbers `.next` exactly the same way — and it is the easier mistake to make.** The rule
is not "don't run `npm run build`", it's **never let any Next command default its dist dir**. Always go
through the npm scripts (`dev:iterate` sets `NEXT_DIST_DIR=.next-dev`, `build:check` sets
`.next-verify`); the moment you type a bare `npx next dev` you have silently pointed a dev server at
the live server's build output.

> 🐛 **A deploy skipped its own wait, then vetoed itself — and `--verify-only` called the wreckage
> healthy.** *Investigated at user request after a failed deploy (2026-08-03 12:21).* Five hypotheses
> were tested against the logs and the running box; two were disproved, which is why they're recorded:
>
> | # | Hypothesis | Verdict |
> |---|---|---|
> | 1 | The drain token rotated mid-deploy, so probes 403'd | **Disproved** — token file unchanged since 2026-07-29, server booted 2026-08-03 |
> | 2 | The failure was silent, so nobody knew | **Disproved** — a `deploy/error` event fired at 12:25:22 |
> | 3 | `busy_now()` conflates "can't tell" with "no server" | **Confirmed — the cause** |
> | 4 | The requesting turn counts itself as busy | **Confirmed**, self-resolving but it burns wait budget |
> | 5 | Cross-folder sessions block the deploy | **Confirmed**, by design — they live in the same process |
> | 6 | `verify()` passes on a broken app | **Confirmed**, independently serious |
>
> **The cause (3).** `busy_now()` returned `""` for *every* failure — 403, 500, timeout, malformed body —
> and the wait loop read `""` as "no server, nothing to protect" and broke out. The log shows the whole
> shape: `▸ 2 turn(s) in flight — waiting up to 300s`, then `▸ no health endpoint — proceeding`, then
> serve.sh reaching that same endpoint one second later and vetoing with 2 busy. One unlucky poll
> disabled the guard. A 403 body is `{"error":"unauthorized"}` — valid JSON, no `busy` key, indistinguishable
> from a dead server under the old test. Now three-valued: a count, `""` **only** on curl exit 7
> (connection refused), and `"?"` for anything else — which keeps waiting and fails *closed* after 30s.
>
> **The second bug (6).** `verify()` asserted `GET / -> 200`, which a broken app passes: `next start`
> serves HTML from in-memory manifests, so after `.next` is overwritten underneath it the page still
> returns 200 while every asset it references 400s. Measured — `--verify-only` printed
> `✓ server on :3000 is answering` about a dashboard that was unstyled text, having *also* printed
> `BUILD_ID ?` and ignored it. It now fails on an empty `BUILD_ID` and fetches the page's own
> `/_next/static/*` URLs, demanding they resolve. Same lesson as everything else in this file: probe the
> thing that cannot lie.
>
> **Alert body.** The failure alert tailed `prod.log`, which only holds the last server *boot* — so an
> alert titled "Deploy failed" carried the previous deploy's `✓ Ready in 180ms`. It now leads with the
> deploy log, where serve.sh's actual refusal is written.
>
> **Autopilot inherits all of this**, because `lib/autopilot/runner.ts` deploys by spawning
> `bin/deploy.sh --detach` and never inspects the result — it relies entirely on these alerts being
> truthful.

> 🐛 **Reached for `npx next dev` and broke the live dashboard.** `npm run dev:iterate` failed to start
> — the shell profile exports `NODE_ENV=production`, which makes Next skip the dev CSS pipeline and
> 500 every route on `@import "tailwindcss"`. The workaround was `NODE_ENV=development npx next dev
> --port 3001`, which fixed the symptom and **dropped `NEXT_DIST_DIR` with it**, so three dev-server
> runs wrote into `.next` underneath the production server. Damage is the same as a bare build:
> `.next/BUILD_ID` emptied, and `/` still returned 200 from in-memory manifests while its referenced
> `webpack-*.js` and `*.css` both returned **400** (measured). It also poisons the compile gate —
> `tsconfig.json` includes `.next/types/**/*.ts`, so a deleted dev-only route leaves a stale
> `validator.ts` that fails `build:check` with `Cannot find module '../../app/<route>/page.js'` long
> after the file is gone. The correct workaround keeps both variables:
> `NODE_ENV=development NEXT_DIST_DIR=.next-dev npx next dev --port 3001` — or better, fix the script.

> 🐛 **Verified the build, broke the dashboard — three turns running.** Each turn ended with a
> `npm run build` to prove the change compiled, then a detached deploy. The build desynced `.next` from
> the running server immediately; the deploy that would have repaired it waited for the box to go quiet
> and **aborted after 300s** because other panes stayed busy — so the box sat on a broken build with
> nothing in the log saying so. The `✋ still busy … aborting` line is not a warning that the app is
> fine; after a bare build it means the app is broken until a deploy actually lands.
> *Surfaced by user as "the browser preview is showing nothing".*

> 🐛 **`next dev` returned 500 for every route, for a whole day.** `instrumentation.ts` starts Autopilot
> behind `NEXT_RUNTIME === "nodejs"` — but that guard runs at *runtime* while webpack resolves imports
> *statically*, and Next compiles instrumentation for the **edge** runtime too (verified: the webpack
> callback fires with `nextRuntime="edge"`, with no middleware in the app). So the edge pass walked into
> `lib/autopilot/runner.ts` and died on `node:child_process` — then, once that was patched, on
> `node:fs`, then on the Agent SDK. Deferring the import doesn't help; webpack follows dynamic imports
> too. `next build` tolerated all of it, so production was fine and nothing complained — the only
> casualty was the preview workflow, silently. Fixed by cutting the graph at the ROOT of that subtree
> (`config.externals` for the exact specifier, edge only, external type `var` because the edge target is
> compiled as a script and `module` fails there). Scoped to edge alone, so a stray `node:` import in
> client code still fails loudly, as it should.

Two entry points, chosen by where you're standing — `docs/DEPLOY.md` is the protocol:

| From | Command | Why |
|---|---|---|
| A dashboard chat pane | `bash bin/deploy.sh --detach` | The requester dies with the server; detaching is mandatory. |
| Finder / Terminal | double-click `Redeploy Minami.command` | Not a child of the server, so it can run inline — and prompt `[w]ait / [f]orce / [q]uit` when panes are busy. |

**Verification is on facts, not exit codes.** The requesting session is dead by the time the swap lands,
so the log is the only witness — and "exit 0" is exactly the signal that lied in the 🐛 below. It asserts
the **server PID changed** (the old process is gone, not merely that *a* server answers) and reports
whether **`.next/BUILD_ID` changed** (unchanged is reported, not failed — you may have compiled no
change), plus `GET /` and `/kb`, plus a probe list. The useful assertion for "the new route exists" is
**anything that is not a 404** — `404` means the old build is still serving. A POST-only route answers
`400` *or* `405` to a GET depending on whether it validates the body or rejects the method, so probes
accept alternatives: `/api/fs/mkdir:400|405`. The defaults live in `bin/deploy.sh` itself;
`DEPLOY_PROBES` still overrides for one-offs (see the 🐛 in §10 for why the default moved into the repo).

### Gotchas
- `INGEST_TOKEN` genuinely gates metrics writes. `READ_KEY` ships as `NEXT_PUBLIC_*`, so it is
  compiled into the browser bundle — obscurity, not auth. Real privacy needs the deploy gated.
- **`npm install` prunes devDependencies when `NODE_ENV=production` is set in the shell** (it is, in
  this environment) — which silently removes `typescript` and `tailwindcss` and breaks the build.
  Use `npm install --include=dev`.

> 🐛 **A deploy can wait forever for a box that will never go quiet.** `deploy.sh --wait` polls
> `/api/agent/health` for `busy == 0` **across every session on the machine** — correct, since the
> restart kills all of them, but it means quiet is a property of the *box*, not the repo. A pane at
> `phase=awaiting` (a permission prompt or `AskUserQuestion`) is busy **forever**: `s.busy` clears only
> on a `result` message, and `canUseTool`'s promise never resolves until a human clicks. The auto-deny
> backstop in `lib/agent/manager.ts` doesn't help — it returns early at `if (s.subs.size !== 0) return`,
> so it only rescues panes with *no* subscribers (tab closed). An open tab sitting on a prompt is never
> rescued. Observed 2026-07-29: a deploy launched at 16:57 waited its full window while a blocked pane
> in `/tmp/minami-permtest` — an unrelated scratch folder — held the box busy. The deploy aborted having
> touched nothing, which is the safe outcome but reads exactly like "nothing happened". **Lengthening
> `--wait` makes the deadlock longer, not shorter.** Check for `phase=awaiting` *before* deploying —
> `.claude/skills/minami-flow/orient.sh` does this — and clear those panes first.

> 🐛 **serve.sh built successfully and swapped nothing.** Line 20 read `":$PORT…"`. Under a shell
> without a valid UTF-8 locale (`LC_CTYPE=UTF-8`, which macOS doesn't recognise) bash swallowed the
> multibyte `…` into the variable name, so `set -u` aborted the script — *after* the build, *before*
> the swap. The old server kept serving and the failure looked like a successful deploy. Fixed by
> bracing: `${PORT}`.

> 🐛 **`npm install` on this box silently uninstalls the build.** The author's shell exports
> `NODE_ENV=production` and npm is configured `omit=dev`, so a bare `npm install` / `npm ci` **prunes
> devDependencies** — including `typescript`. Next only reads `tsconfig.json` `paths` when TypeScript
> is installed, so with it gone every `@/…` import stops resolving and the build dies with a wall of
> `Module not found: Can't resolve '@/components/…'`. The trap is that the files are all present and
> the alias config is correct, so the error points nowhere near the cause; worse, webpack reports only
> the first entrypoint's five failures, which makes a global breakage look like one bad route.
> Observed 2026-07-31 during an open-source audit — the diagnosis burned several rebuilds and briefly
> produced a false "this repo doesn't build from a clean clone" conclusion, because every control
> build was run against the same pruned `node_modules`.
>
> **Install with `NODE_ENV=development npm ci --include=dev`; build with NODE_ENV left alone.**
> Inverting that also fails: `NODE_ENV=development next build` trips Next's non-standard-NODE_ENV
> warning and then dies in static generation with `<Html> should not be imported outside of
> pages/_document` on `/404` and `/500` — a masked error that has nothing to do with the real problem.
> The two commands want opposite values, which is exactly why this is easy to get wrong.
> CI is unaffected: GitHub Actions runners don't set `NODE_ENV`.

---
