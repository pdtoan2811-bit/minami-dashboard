# Meeting launch — getting Minami into a call

Part of the [Minami Bento knowledge record](../KNOWLEDGE.md).

Covers the two launchers and the public path Recall's bot dials into. The canvas pipeline that runs
*after* audio arrives is §17; this is everything that has to be true before a single byte does.

---

## 18. The launch chain

Two entry points, one job:

| Script | Shape | Notes |
|---|---|---|
| `bin/Minami Call.command` | interactive, 4 steps, double-clickable | the one anh actually uses |
| `bin/meet-now.sh` | one command, 5 steps, cold-start | `bash bin/meet-now.sh <meet-url>` |
| `bin/tunnel-lib.sh` | **sourced by both** | `tunnel_dns` · `tunnel_reachable` · `tunnel_host_from_log` |

The chain: meeting app on **:3011** (never :3010, the dashboard) → `server/recall-receiver.mjs` on
**:8787** → a cloudflared quick tunnel over :8787 → the tunnel's `wss://` url handed to Recall.ai as
`RECALL_RECEIVER_URL` → `bin/minami-meet.mjs` dispatches the bot with that url in
`realtime_endpoints`.

### Mechanics that are already right

- **The receiver identifies itself.** `GET /` on :8787 answers the literal string `minami-receiver ok`.
  Every liveness check greps for that, never for "did something reply".
- **The tunnel url is written to disk** (`~/.minami/receiver-url.txt`). Quick-tunnel hostnames rotate
  on every restart and are printed only to the stdout of whatever started cloudflared; losing that
  hostname has cost a meeting.
- **Reuse is proved, not assumed.** A run's first act is to probe the recorded url end-to-end. A
  cloudflared process that has been failing for two hours is still a process.
- **`ingest` answering 401 is the success case.** It means `CANVAS_INGEST_TOKEN` loaded. 503 means it
  did not, and audio would be refused for the whole meeting.

### Gotchas

- **This Mac is not the consumer of the tunnel url. Recall's servers are.** Every DNS or reachability
  opinion this machine holds about the hostname is advisory at best — see the post-mortem below.
- **`TUNNEL_PID` is assigned inside a `$(tunnel_up)` subshell**, so the parent's `cleanup` never sees
  it and does not kill cloudflared on exit. That is why `tunnel_up` opens with a `pgrep` sweep scoped
  to *our* port — the one place the file's "recorded pids, never `pkill -f`" rule is deliberately
  relaxed, because the stale tunnel may belong to a run that has already exited.
- **`TUNNEL_WAIT` is a wall clock, not a pass count.** Budget and display must be the same number.
- **The old `dev-3011` and `tunnel-8787` logs are in `~/.minami/`, not the repo.** When a tunnel is
  restarted the log is truncated while the dying cloudflared still holds its offset, so shutdown
  errors from the *previous* tunnel appear at the tail of the *new* log. Read the timestamps, not the
  position.

> 🐛 **The launcher poisoned its own DNS, then blamed the tunnel.**
> *Reported by user: "stuck on step 3 and cannot launch"* (2026-08-24), after an earlier
> *"take so long to answer"* the same day.
>
> `trycloudflare.com` publishes an **SOA minimum of 1800**, so an NXDOMAIN for a quick tunnel's
> hostname is negative-cached for **thirty minutes**. The launcher probes the hostname the instant
> cloudflared logs it — which is seconds *before* Cloudflare publishes the record. That first probe
> earns an NXDOMAIN, the resolver pins it for 1800s, and every later probe in the run is served the
> poisoned answer. **The run could not recover no matter how long it waited.**
>
> The `dig` fallback that existed specifically to survive local DNS failures did not help, because it
> was a bare `dig` — same system/router resolver, same cache, same lie. Measured while the launcher
> sat on "3/4":
>
> ```
> system     (no answer)          <- what the launcher saw
> @1.1.1.1   104.16.231.132       <- the tunnel, live
> @8.8.8.8   104.16.230.132       <- the tunnel, live
> ```
>
> The tunnel was working the entire time, and Recall — the only party whose resolution matters — would
> have reached it. **Fix:** `tunnel_dns()` resolves through `@1.1.1.1`, then `@8.8.8.8`, then the local
> resolver last. Not a preference for public DNS in general; those are simply the only resolvers we
> have not just handed a stale negative answer to. Detection went from never to ~1s.
>
> **Two failures hid this for a whole day.** First, the wait loop ran 30 passes and added a flat `+2`
> to the displayed counter each pass — a number describing the loop's *assumptions*, not the clock, so
> a pass that also burned 5s in curl and 3s in dig still printed "+2". Second, the give-up message
> pointed at `tunnel.log`, where cloudflared's pre-checks report **PASS on every line** whether or not
> the hostname ever went live. A healthy log plus a fictional counter reads exactly like "the network
> is slow". The loop is now wall-clock bounded (`TUNNEL_WAIT=180`) and prints real elapsed against the
> real deadline, and the failure message distinguishes "a hostname was printed but never answered"
> (retry) from "cloudflared never printed a url" (read the log).

> 🐛 **The same tunnel bugs were fixed once and shipped twice.**
> `bin/meet-now.sh` carried a generation-one copy of the tunnel logic while `Minami Call.command`'s
> copy was hardened by four separate incidents. `meet-now.sh` still had all three of the bugs the
> other had already paid for: a reuse check of `curl -o /dev/null` that counts **any** response as
> alive (this is how Cloudflare's own api host answering 405 once passed as "my receiver is up", and a
> 52-minute meeting streamed its audio into nothing with every log clean); a `head -1` on the log that
> picks that api host, because cloudflared logs the api it talks to *before* its own hostname; and a
> break out of the wait the moment a hostname was **printed**, which is seconds before the edge serves
> it. **Fix:** all three live in `bin/tunnel-lib.sh` now, sourced by both, so the two cannot drift
> again. A launcher is exactly the code nobody reads until it fails at the worst possible moment.

### Not built / not verified

- No automated test drives a real cold start; the probe functions are verified by hand against a live
  tunnel under both `set -uo pipefail` and `set -euo pipefail`.
- The quick tunnel has no uptime guarantee (Cloudflare says so at startup). A named tunnel would
  remove both the rotating hostname and the 1800s negative-cache trap entirely — specified nowhere,
  built by nobody.
