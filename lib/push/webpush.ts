// Web Push, hand-rolled on node:crypto (§24): VAPID (RFC 8292) + aes128gcm payload encryption
// (RFC 8291 over RFC 8188). Server-only.
//
// Why not the `web-push` package: `npm install` on this box de-symlinks node_modules in a worktree
// and prunes devDependencies in main (see MEMORY: npm-install-prunes-devdeps), so adding a dependency
// is a deploy hazard of its own. The whole protocol is ~100 lines of HMAC/ECDH/AES-GCM that Node ships,
// and `encrypt()` is checked byte-for-byte against RFC 8291 Appendix A (scripts/push-test.mjs).
import crypto from "node:crypto";

export const b64u = {
  enc: (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url"),
  dec: (s: string) => Buffer.from(s, "base64url"),
};

export type VapidKeys = { publicKey: string; privateKey: string }; // base64url: 65-byte point / 32-byte scalar
export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };

export function generateVapidKeys(): VapidKeys {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64u.enc(ecdh.getPublicKey()), privateKey: b64u.enc(ecdh.getPrivateKey()) };
}

const hmac = (key: Buffer, data: Buffer) => crypto.createHmac("sha256", key).update(data).digest();

/** RFC 8291 §3.4 + RFC 8188 §2, single record. `salt` / `asPrivate` are injectable ONLY so the RFC's
 *  own test vector can pin them; in production both are fresh per message, which is the whole of
 *  the scheme's forward secrecy. */
export function encrypt(payload: Buffer, sub: PushSub["keys"], opts?: { salt?: Buffer; asPrivate?: Buffer }): Buffer {
  const uaPublic = b64u.dec(sub.p256dh);
  const authSecret = b64u.dec(sub.auth);
  const as = crypto.createECDH("prime256v1");
  if (opts?.asPrivate) as.setPrivateKey(opts.asPrivate); else as.generateKeys();
  const asPublic = as.getPublicKey();
  const salt = opts?.salt ?? crypto.randomBytes(16);

  const ecdhSecret = as.computeSecret(uaPublic);
  // HKDF with one-block expands, written out rather than via crypto.hkdfSync so each step lines up
  // with the RFC's own pseudocode — the only way to debug a mismatch against a push service that
  // answers every mistake with the same opaque 400.
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "binary")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "binary")).subarray(0, 12);

  // 0x02 = "last record" delimiter (RFC 8188 §2). No padding: the payload is a short JSON notice, and
  // the tailnet hostname it would hide is already in the endpoint's push-service logs anyway.
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** RFC 8292 VAPID: an ES256 JWT whose `aud` is the push service's origin. */
export function vapidAuth(endpoint: string, keys: VapidKeys, subject: string, ttlSec = 12 * 3600): string {
  const pub = b64u.dec(keys.publicKey);
  const jwk = { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64u.enc(pub.subarray(1, 33)), y: b64u.enc(pub.subarray(33, 65)) };
  const key = crypto.createPrivateKey({ key: jwk, format: "jwk" });
  const head = b64u.enc(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.enc(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + ttlSec, sub: subject })));
  // ieee-p1363 = raw r||s, which is what JWS wants; Node's default is DER and every push service
  // rejects that with a 401/403 that doesn't say why.
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${keys.publicKey}`;
}

export type SendResult = { status: number; gone: boolean; body?: string };

/** POST one encrypted message. `gone` = the push service says this subscription is dead (404/410):
 *  the caller must forget it, or every later push keeps paying a round trip to a tombstone. */
export async function sendPush(sub: PushSub, payload: object, keys: VapidKeys, opts: { subject: string; ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string }): Promise<SendResult> {
  const body = encrypt(Buffer.from(JSON.stringify(payload)), sub.keys);
  const headers: Record<string, string> = {
    Authorization: vapidAuth(sub.endpoint, keys, opts.subject),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(opts.ttl ?? 900),
    Urgency: opts.urgency ?? "normal",
  };
  // Topic makes the push service itself collapse undelivered messages (a phone in a drawer gets the
  // latest state of a chat, not a backlog). Max 32 base64url chars, so it is hashed down.
  if (opts.topic) headers.Topic = crypto.createHash("sha256").update(opts.topic).digest("base64url").slice(0, 32);
  try {
    const r = await fetch(sub.endpoint, { method: "POST", headers, body: new Uint8Array(body), signal: AbortSignal.timeout(10_000) });
    const text = r.status >= 300 ? (await r.text().catch(() => "")).slice(0, 300) : undefined;
    return { status: r.status, gone: r.status === 404 || r.status === 410, ...(text ? { body: text } : {}) };
  } catch (e) {
    return { status: 0, gone: false, body: String((e as Error)?.message || e) };
  }
}
