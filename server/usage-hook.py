#!/usr/bin/env python3
"""Claude Code Stop hook — report this turn's token usage to the Minami metrics API.

Runs at the end of every Claude Code turn on a machine. Reads the transcript's latest usage,
then POSTs a compact event to the metrics API so the dashboard can show live per-machine usage.

Also carries a cheap "session digest" alongside the usage numbers: cwd + a truncated one-line
label for the last user prompt AND the last assistant reply this turn. No LLM call — pure
truncation, same spirit as the existing `label` field. This is the "compact protocol": every
Stop event already fires once per turn, so riding it means a fresh checkpoint of "what are we
doing in this project" reaches the metrics API (and therefore the dashboard, and other
machines) continuously, with zero added hook overhead. The server derives a latest-per-project
view from this stream (GET /projects) — see metrics-server.js.

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
    last_assistant = ""

    def text_of(content):
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return " ".join(
                b.get("text", "") for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            )
        return ""

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
                role = row.get("type") or msg.get("role")
                txt = text_of(msg.get("content")).strip()
                if not txt:
                    continue
                # Capture the most recent real user prompt / assistant reply (skip
                # tool-only turns with no text) as the compacted digest.
                if role == "user":
                    last_user = txt
                elif role == "assistant":
                    last_assistant = txt
        if last:
            model = last.get("model", "")
            u = last["usage"]
            itok = u.get("input_tokens", 0)
            otok = u.get("output_tokens", 0)
            ctok = u.get("cache_read_input_tokens", 0)
    except OSError:
        return

    # Short, single-line "what were we doing" digest for the dashboard feed — no LLM call,
    # just truncation (the compact protocol: cheap and runs every turn for free).
    label = last_user.split("\n", 1)[0].strip()[:60] if last_user else ""
    reply = last_assistant.split("\n", 1)[0].strip()[:100] if last_assistant else ""

    if itok == 0 and otok == 0 and ctok == 0:
        return

    body = json.dumps({
        "source": source,
        "session": payload.get("session_id", ""),
        "cwd": os.getcwd(),
        "model": model,
        "label": label,
        "reply": reply,
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
