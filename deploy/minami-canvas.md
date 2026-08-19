# Meeting canvas — running it in production

The Minami meeting bot in three processes. All of it lives on the Hetzner box (CAX11, Singapore,
2 vCPU / 4 GB) beside the Slack bot, because that box is already up 24/7 and sits ~70ms from Recall's
`ap-northeast-1` region.

```
Google Meet
   ├── Recall bot ──audio_separate_raw──► wss:// ──► recall-receiver ──► /api/canvas/ingest
   └── Recall bot ◄──output_media.screenshare── https:// ◄── /canvas?broadcast=1
```

One bot does both directions. `bin/minami-meet.mjs` creates it.

---

## Before the first production meeting

### 1. Secrets — both tokens MUST be set

Both endpoints are open by default, which is fine for a probe on a laptop and not fine on a public
tunnel. Anyone who discovers the hostname can otherwise push audio into your meeting pipeline, or
read the board.

```bash
RECALL_RECEIVER_TOKEN=$(openssl rand -hex 24)   # appended to the wss URL as ?token=…
CANVAS_INGEST_TOKEN=$(openssl rand -hex 24)     # Bearer token on /api/canvas/ingest
```

The receiver logs `(OPEN — set RECALL_RECEIVER_TOKEN)` on startup when it isn't configured. Treat
that line as a blocker.

### 2. A named Cloudflare tunnel, not a quick tunnel

`cloudflared tunnel --url` gives a random hostname that changes on every restart — unusable for a
scheduled bot, because the URL is baked into the bot at creation time. A **named** tunnel gives a
stable hostname and keeps the Hetzner firewall closed to everything but SSH, which is what preserves
Minami's "no inbound ports" property.

Two routes are needed: the receiver (`:8787`) and the canvas (`:3000`).

### 3. Retention stays `null`

`bin/minami-meet.mjs` sets `recording_config.retention = null` — zero data retention, nothing stored
on Recall's servers. **Recall's default is `forever`**, verified on a real bot; the first test
recording had to be deleted by hand. Do not remove that line.

### 4. Budget

At ~$0.56/meeting-hour (Recall $0.50 + models), a $50/month ceiling is roughly 89 hours. There is no
enforcement yet — see Known gaps.

---

## The three services

`deploy/minami-canvas.service` runs the receiver. The canvas is the existing Next app. The bot itself
is not a service: it is created per meeting by the launcher.

```bash
# on the box
systemctl enable --now minami-canvas      # the audio receiver
node bin/minami-meet.mjs <meet-url>       # one meeting
```

---

## Known gaps — read before calling this done

| Gap | Consequence |
|---|---|
| **No calendar dispatch** | every meeting is launched by hand; the auto-join + Slack-veto flow is designed but unbuilt |
| **No attendee email** | the archive is written to disk; nothing is sent. Addresses must come from the calendar — Recall's audio payload carries `{id, name, is_host, platform}` and no address |
| **`bin/minami-presenter.mjs` is experimental** | the 1080p self-hosted presenter never worked — Chrome's capture-source flags silently select the wrong surface. Kept for the sign-in technique it proves, not for use |

### Closed since the first draft

- **Budget** — `CANVAS_BUDGET_USD` (default $50) is checked before dispatch, warns at 80%, hard-stops
  at 100%, resets monthly. Spend is booked when a meeting ends, so one long call can overshoot once.
- **Artifacts** — every meeting writes `notes.md`, `canvas.json` and `transcript.md` to
  `CANVAS_ARCHIVE_DIR`. The launcher prints the path, and says so loudly if nothing was written.
- **Both tokens** — generated into `.env.local`. The launcher now derives the receiver's `?token=`
  from the same variable the receiver reads, so the two cannot disagree.

---

## What was measured, so nobody re-derives it

- **720p is Recall's cap, not Google's.** Every variant including `web_gpu` renders 1280x720 @ 15fps.
  A human sharing a screen in Meet gets 1080p; the bot cannot.
- **`screenshare` beats `camera` decisively** at the same resolution. Camera video is encoded for
  faces and smooths the high-frequency detail that text is made of; a screenshare is encoded as
  content. This is the difference between a legible board and mush, and it is one config value.
- **`web_4_core` is required**, both to render this canvas and for separate-participant audio.
- **Recall streams a participant's channel near-continuously**, silence included — 339s of audio
  across a 414s meeting. Chunks are therefore silence-trimmed before transcription; sending the raw
  window made the STT return empty transcripts for 12 of 23 utterances.
- **Speaker names arrive intact, diacritics and all** (`phạm đức toàn`). This is the whole reason the
  stack uses Recall rather than a diarizing ASR.
