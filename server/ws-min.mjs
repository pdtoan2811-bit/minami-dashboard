// A WebSocket server in ~100 lines, no dependencies.
//
// Recall connects TO us and pushes audio, so we need a server, not a client — and Node still has no
// built-in one (the global `WebSocket` added in v22 is a client). The usual answer is `ws`, and this
// exists instead for one reason: the receiver has to run on the Hetzner box next to Minami, and
// anything with a dependency there is one more thing to install, pin and break during a deploy at an
// hour when a meeting is starting.
//
// Only what Recall actually needs is implemented: the handshake, masked client frames, continuation
// frames, ping/pong and close. No extensions, no compression, no subprotocols. If any of those ever
// become necessary, that is the moment to take the dependency — not before.
//
// bin/recall-probe.mjs deliberately keeps its OWN copy of this rather than importing it. A probe you
// run to decide whether a vendor works must not be able to fail because of a shared module; its whole
// value is that it depends on nothing.

import { createServer } from "node:http";
import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Largest single message we will assemble, ~16 MB.
 *
 *  Without a cap, `buf` grows until a frame completes — so a peer that declares a 2^40-byte payload
 *  (or simply never finishes one) makes this process allocate until the box dies. That is a real
 *  exposure once the receiver is on a public tunnel, and it costs one comparison to close. Recall's
 *  audio frames are a few KB; 16 MB is far above anything legitimate. */
const MAX_MESSAGE = 16 * 1024 * 1024;

/**
 * @param {object} o
 * @param {number} o.port
 * @param {(text: string) => void} o.onMessage  one complete text frame
 * @param {() => void} [o.onOpen]
 * @param {() => void} [o.onClose]
 * @param {(req: import("node:http").IncomingMessage) => boolean} [o.authorize] reject before upgrade
 */
export function createWsServer({ port, onMessage, onOpen, onClose, authorize, health }) {
  const server = createServer((_req, res) => {
    /** ⚠️ THE HEALTH RESPONSE IDENTIFIES ITSELF, and that is the whole point.
     *
     *  It used to answer a generic "ok". The launcher then asked only "did anything answer?", so on
     *  2026-08-21 a bot was dispatched at https://api.trycloudflare.com — Cloudflare's own API host,
     *  which the tunnel-url regex had matched by mistake. It replies 405, which is not a connection
     *  failure, so the check passed and a 52-minute call sent its audio nowhere.
     *
     *  "Something answered" is not the question. "Did MY receiver answer" is. */
    /** ⚠️ IDENTITY IS NOT ENOUGH — IT MUST SAY WHETHER IT CAN DO THE JOB.
     *
     *  A receiver with no CANVAS_INGEST_URL runs in DRY RUN: it accepts the bot, logs every chunk and
     *  forwards nothing. It answers this endpoint exactly like a working one, so a launcher that
     *  checks for the marker alone will happily reuse it and the board stays empty for the whole call.
     *  Observed 2026-08-21 on a live meeting: audio arriving, chunks logged, zero cards.
     *
     *  So the answer carries the mode, and the launcher refuses anything that is not "ok". */
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`minami-receiver ${health?.() ?? "ok"}`);
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key || (authorize && !authorize(req))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${createHash("sha1").update(key + GUID).digest("base64")}\r\n\r\n`,
    );
    onOpen?.();

    let buf = Buffer.alloc(0);
    let fragOp = 0;
    let frags = [];

    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);

      for (;;) {
        if (buf.length < 2) return;

        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;

        if (len === 126) {
          if (buf.length < off + 2) return;
          len = buf.readUInt16BE(off);
          off += 2;
        } else if (len === 127) {
          if (buf.length < off + 8) return;
          len = Number(buf.readBigUInt64BE(off));
          off += 8;
        }

        let mask;
        if (masked) {
          if (buf.length < off + 4) return;
          mask = buf.subarray(off, off + 4);
          off += 4;
        }

        if (len > MAX_MESSAGE) {
          // Refusing loudly beats buffering forever. Nothing legitimate sends a frame this size.
          socket.destroy();
          return;
        }
        if (buf.length < off + len) return; // frame still arriving

        const payload = Buffer.from(buf.subarray(off, off + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        buf = buf.subarray(off + len);

        if (opcode === 0x8) { socket.end(); return; }
        if (opcode === 0x9) {
          // Pong must echo the ping's payload. Recall's keepalive stops if we get this wrong, and the
          // connection dies silently mid-meeting.
          //
          // The 125-byte guard is not decoration: this writes the length as a single byte, so a longer
          // payload would silently emit a malformed frame and desync the stream. RFC 6455 caps control
          // frames at 125 bytes, so truncating is both legal and the only safe reading.
          const echo = payload.length > 125 ? payload.subarray(0, 125) : payload;
          socket.write(Buffer.concat([Buffer.from([0x8a, echo.length]), echo]));
          continue;
        }
        if (opcode === 0xa) continue;

        if (opcode === 0x0) frags.push(payload);
        else { fragOp = opcode; frags = [payload]; }
        // Continuation frames are individually small and collectively unbounded — the same exposure
        // as a single huge frame, one indirection away.
        if (frags.reduce((n, f) => n + f.length, 0) > MAX_MESSAGE) { socket.destroy(); return; }
        if (!fin) continue;

        const message = Buffer.concat(frags);
        frags = [];
        // Audio frames are large and arrive as continuations; assembling before parsing is the whole
        // reason this loop keeps state. Skipping it presents as "the JSON is truncated sometimes".
        if (fragOp === 0x1) onMessage(message.toString("utf8"));
      }
    });

    socket.on("error", () => socket.destroy());
    socket.on("close", () => onClose?.());
  });

  server.listen(port);
  return server;
}
