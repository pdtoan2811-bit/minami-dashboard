#!/usr/bin/env python3
"""Claude Code Stop hook — report this turn's token usage to the Minami metrics API.

Runs at the end of every Claude Code turn on a machine. Reads the transcript's latest usage,
then POSTs a compact event to the metrics API so the dashboard can show live per-machine usage.

Config is read from ~/.minami-metrics.env (KEY=VALUE lines) OR the process env (env wins):
  MINAMI_METRICS_URL     e.g. https://box.<tailnet>.ts.net   (or http://localhost:8787 on the box itself)
  MINAMI_METRICS_TOKEN   ingest bearer token (must match the server's INGEST_TOKEN)
  MINAMI_SOURCE          this machine's label: local-mac | minami-cloud

Never blocks a turn; fails silent on any error.
"""
import json
import os
import subprocess
import sys


def load_config():
    cfg = {}
    p = os.path.expanduser("~/.minami-metrics.env")
    try:
        with open(p) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    for k in ("MINAMI_METRICS_URL", "MINAMI_METRICS_TOKEN", "MINAMI_SOURCE"):
        if os.environ.get(k):
            cfg[k] = os.environ[k]
    return cfg


def main():
    cfg = load_config()
    url = cfg.get("MINAMI_METRICS_URL")
    token = cfg.get("MINAMI_METRICS_TOKEN")
    source = cfg.get("MINAMI_SOURCE", "unknown")
    if not url or not token:
        return

    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return
    transcript = payload.get("transcript_path")
    if not transcript:
        return

    model, itok, otok, ctok = "", 0, 0, 0
    last_user = ""
    try:
        last = None
        with open(transcript, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                msg = row.get("message") or {}
                if msg.get("usage"):
                    last = msg
                # Capture the most recent real user prompt (skip tool-result-only turns) as the label.
                if row.get("type") == "user" or msg.get("role") == "user":
                    content = msg.get("content")
                    txt = ""
                    if isinstance(content, str):
                        txt = content
                    elif isinstance(content, list):
                        txt = " ".join(
                            b.get("text", "") for b in content
                            if isinstance(b, dict) and b.get("type") == "text"
                        )
                    if txt.strip():
                        last_user = txt.strip()
        if last:
            model = last.get("model", "")
            u = last["usage"]
            itok = u.get("input_tokens", 0)
            otok = u.get("output_tokens", 0)
            ctok = u.get("cache_read_input_tokens", 0)
    except OSError:
        return

    # A short, single-line "what was this turn" label for the dashboard feed.
    label = last_user.split("\n", 1)[0].strip()[:60] if last_user else ""

    if itok == 0 and otok == 0 and ctok == 0:
        return

    body = json.dumps({
        "source": source,
        "session": payload.get("session_id", ""),
        "model": model,
        "label": label,
        "inputTokens": itok,
        "outputTokens": otok,
        "cacheReadTokens": ctok,
    })
    # POST via curl — uses the system cert store, so HTTPS (Tailscale Funnel) works on macOS too,
    # where Python's urllib can't find the CA bundle. curl is present on both machines.
    try:
        subprocess.run(
            [
                "curl", "-s", "--max-time", "5", "-X", "POST",
                url.rstrip("/") + "/ingest",
                "-H", "Content-Type: application/json",
                "-H", f"Authorization: Bearer {token}",
                "-d", body,
            ],
            capture_output=True, timeout=8,
        )
    except Exception:
        pass  # never block the turn


if __name__ == "__main__":
    main()
