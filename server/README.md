# Minami metrics API

Self-hosted usage collector for the dashboard. Runs on the Hetzner box, gathers Claude Code token
usage from **both machines** (local Mac + the Minami cloud host), and serves live aggregates to the
dashboard over **Tailscale Funnel** (free `*.ts.net` HTTPS — no domain, no open inbound port).

```
Mac  (Stop hook) ──POST /ingest──┐
                                 ├─→ dash (ts.net, Funnel) ─→ box: metrics-server.js
Minami host (Stop hook) ─localhost┘                            ├ store: ~/.minami-metrics/events.jsonl
                                                               └ GET /stream (SSE → dashboard)
```

## Files
- `metrics-server.js` — zero-dep Node HTTP API (`/ingest`, `/stats`, `/stream` SSE, `/health`).
- `usage-hook.py` — Claude Code **Stop** hook; reports each turn's usage. Same file on both machines.
- `minami-metrics.service` — systemd unit for the box.

## Box setup (once)
```bash
# 1. code
git clone https://github.com/pdtoan2811-bit/minami-dashboard.git ~/minami-dashboard   # or git pull

# 2. secrets (git-ignored) — generate strong tokens
cat > ~/.minami-metrics.env <<EOF
INGEST_TOKEN=$(openssl rand -hex 24)
READ_KEY=$(openssl rand -hex 12)
EOF
chmod 600 ~/.minami-metrics.env

# 3. service
cp ~/minami-dashboard/server/minami-metrics.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now minami-metrics
curl -s localhost:8787/health   # {"ok":true}

# 4. this machine's Stop hook (source = minami-cloud, url = localhost)
mkdir -p ~/.claude/hooks && cp ~/minami-dashboard/server/usage-hook.py ~/.claude/hooks/
printf 'MINAMI_METRICS_URL=http://localhost:8787\nMINAMI_METRICS_TOKEN=<INGEST_TOKEN>\nMINAMI_SOURCE=minami-cloud\n' >> ~/.minami-metrics.env
# add a Stop hook to ~/.claude/settings.json → python3 "$HOME/.claude/hooks/usage-hook.py"

# 5. expose via Tailscale Funnel
tailscale up            # authenticate this box (one browser click)
tailscale funnel 8787   # → prints https://<box>.<tailnet>.ts.net
```

## Mac setup (once)
```bash
mkdir -p ~/.claude/hooks && cp ~/minami-dashboard/server/usage-hook.py ~/.claude/hooks/
cat > ~/.minami-metrics.env <<EOF
MINAMI_METRICS_URL=https://<box>.<tailnet>.ts.net
MINAMI_METRICS_TOKEN=<INGEST_TOKEN>
MINAMI_SOURCE=local-mac
EOF
# add a Stop hook to ~/.claude/settings.json → python3 "$HOME/.claude/hooks/usage-hook.py"
```

## Dashboard (Vercel env)
```
NEXT_PUBLIC_METRICS_URL=https://<box>.<tailnet>.ts.net
NEXT_PUBLIC_METRICS_KEY=<READ_KEY>
```

## Notes
- Writes need `INGEST_TOKEN` (real auth). Reads use `?k=READ_KEY` (obscurity — gate the Vercel deploy
  with a password for true privacy; `NEXT_PUBLIC_*` is visible to the browser).
- `events.jsonl` grows ~1 line/turn. Rotate/trim if it ever gets large (personal scale: fine for a long time).
- The box already runs Minami; the metrics service is a few MB of RAM.
