# Shared tunnel probing for the meeting launchers. Sourced, never executed.
#
#   bin/Minami Call.command   the interactive launcher
#   bin/meet-now.sh           the one-command cold start
#
# ⚠️ THIS FILE EXISTS BECAUSE THE TWO COPIES DRIFTED, AND THE OLD ONE COST MEETINGS.
#
# Both scripts grew their own "is the tunnel up?" check. Call.command's was hardened four times by
# four separate incidents; meet-now.sh's stayed at generation one, so every lesson below was learned
# twice or paid for twice. A launcher is exactly the kind of code nobody reads until it fails at the
# worst moment, so there is now one copy and both scripts source it.
#
# Everything here must work under `set -euo pipefail` (meet-now.sh) AND `set -uo pipefail`
# (Call.command). That is why command substitutions are guarded with `|| true` and why no function
# ends on a bare `&&` list: under -e, an assignment from a failing substitution kills the caller.

# ⚠️ ASK A RESOLVER THAT HAS NOT ALREADY BEEN LIED TO.
#
# The first fallback here used a bare `dig`, which goes to the SAME system/router resolver curl just
# failed on — so it inherited that resolver's cache, including its mistakes. And there is a specific
# mistake it always inherits: `trycloudflare.com` publishes an SOA minimum of 1800, so an NXDOMAIN for
# a quick tunnel's hostname is negative-cached for THIRTY MINUTES. The launcher asks for that NXDOMAIN
# itself: it probes the hostname the instant cloudflared prints it, which is seconds before Cloudflare
# publishes the record. The first probe therefore poisons every later probe in the same run, and the
# run cannot recover no matter how long it waits — the fallback was poisoned too, from the same cache.
#
# That is what "stuck on 3/4, cannot launch" was on 2026-08-24. Measured while the launcher sat there:
#   system     (no answer)          <- what the launcher saw
#   @1.1.1.1   104.16.231.132       <- the tunnel, live
#   @8.8.8.8   104.16.230.132       <- the tunnel, live
#
# So resolve through public resolvers FIRST and treat the local one as the last resort. This is not a
# preference for public DNS in general — it is that only these have not been handed a stale negative
# answer BY US, moments ago.
tunnel_dns() {
  local host="$1" ip server
  for server in @1.1.1.1 @8.8.8.8 ''; do
    ip="$(dig +short +time=3 +tries=1 $server "$host" 2>/dev/null | grep -m1 -E '^[0-9.]+$' || true)"
    if [ -n "$ip" ]; then printf '%s' "$ip"; return 0; fi
  done
  return 1
}

# ⚠️ THIS MACHINE IS NOT THE CONSUMER OF THE TUNNEL URL. Recall's servers are.
#
# A first version asked "can curl reach it from here?", which conflates two different failures. On
# 2026-08-20 a launch hung for minutes on a tunnel that was working perfectly: cloudflared had
# registered, the receiver answered locally, and `dig` resolved the hostname — but the system resolver
# would not, because four utun VPN interfaces sit in the DNS path. curl said "Could not resolve host"
# and returned 000; `curl --resolve` against the same IP returned 200.
#
# So a local DNS failure was blocking a meeting the bot could have joined. The probe falls back to
# resolving the name itself and connecting by IP: if the tunnel answers that way, it IS reachable from
# the internet, whatever this Mac's resolver believes.
#
# ⚠️ "SOMETHING ANSWERED" IS NOT THE QUESTION — "DID MY RECEIVER ANSWER" IS.
#
# An earlier version accepted any HTTP response as proof of life. On 2026-08-21 the url extraction in
# the caller matched https://api.trycloudflare.com — Cloudflare's own API host, not a tunnel — and that
# host replies 405, which is not a connection failure. So the check passed, a bot was dispatched at
# Cloudflare's API, and a 52-minute meeting streamed its audio into nothing while every log stayed
# clean. The receiver now answers "minami-receiver ok" and this looks for exactly that, so a
# wrong-but-live host can no longer impersonate it.
tunnel_reachable() {
  [ -n "${1:-}" ] || return 1
  local host body ip
  host="${1#https://}"
  body="$(curl -s -m 5 "$1" 2>/dev/null | head -c 64 || true)"
  case "$body" in (*minami-receiver*) return 0 ;; esac
  # System resolver failed. Ask DNS directly and connect by address before believing it is down.
  ip="$(tunnel_dns "$host" || true)"
  [ -n "$ip" ] || return 1
  body="$(curl -s -m 5 --resolve "${host}:443:${ip}" "$1" 2>/dev/null | head -c 64 || true)"
  case "$body" in (*minami-receiver*) return 0 ;; esac
  return 1
}

# ⚠️ EXCLUDE api.trycloudflare.com — cloudflared logs the API it talks to BEFORE it prints the quick
# tunnel's own hostname, so a plain `head -1` picks Cloudflare's API. A quick-tunnel hostname is
# several hyphenated words; the API host is one. This is the other half of the 52-minute-meeting bug:
# the impersonating host got IN here, and was waved through by the weak liveness check above.
tunnel_host_from_log() {
  grep -aoE "https://[a-z0-9-]+\.trycloudflare\.com" "$1" 2>/dev/null \
    | grep -v '//api\.' | grep -E '//[a-z0-9]+(-[a-z0-9]+){2,}\.' | head -1 || true
}
