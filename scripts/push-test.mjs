// Offline checks for web push (§24): the RFC 8291 test vector, a decrypt round-trip, the VAPID
// signature, and the notifier's rules against a fake sender. No network, no server; the store is
// pointed at a temp dir. Run: node scripts/push-test.mjs
import { createJiti } from "jiti";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minami-push-"));
process.env.MINAMI_PUSH_FILE = path.join(tmp, "push.json");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
let fails = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra && !ok ? " — " + extra : ""}`); if (!ok) fails++; };

const wp = await jiti.import(path.join(root, "lib/push/webpush.ts"));

// RFC 8291 Appendix A.
{
  const out = wp.encrypt(Buffer.from("When I grow up, I want to be a watermelon"), {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  }, { salt: wp.b64u.dec("DGv6ra1nlYgDCS1FRnbzlw"), asPrivate: wp.b64u.dec("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw") });
  const want = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
  check("RFC 8291 Appendix A ciphertext", wp.b64u.enc(out) === want, wp.b64u.enc(out));
}

// Decrypt our own output as a user agent would — covers the random salt/key path the vector pins.
{
  const ua = crypto.createECDH("prime256v1"); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const msg = JSON.stringify({ hello: "watermelon", n: 42 });
  const body = wp.encrypt(Buffer.from(msg), { p256dh: wp.b64u.enc(ua.getPublicKey()), auth: wp.b64u.enc(auth) });
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const hm = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
  const prkKey = hm(auth, ua.computeSecret(asPub));
  const ikm = hm(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = hm(salt, ikm);
  const cek = hm(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "binary")).subarray(0, 16);
  const nonce = hm(prk, Buffer.from("Content-Encoding: nonce\0\x01", "binary")).subarray(0, 12);
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  check("round-trip decrypt", pt.subarray(0, -1).toString() === msg && pt[pt.length - 1] === 2 && body.readUInt32BE(16) === 4096);
}

// VAPID JWT verifies against the public key, with the endpoint's origin as aud.
{
  const keys = wp.generateVapidKeys();
  const h = wp.vapidAuth("https://fcm.googleapis.com/fcm/send/abc", keys, "mailto:x@example.invalid");
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
  const pub = wp.b64u.dec(m[4]);
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: wp.b64u.enc(pub.subarray(1, 33)), y: wp.b64u.enc(pub.subarray(33)) }, format: "jwk" });
  const ok = crypto.verify("sha256", Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: "ieee-p1363" }, wp.b64u.dec(m[3]));
  const claims = JSON.parse(wp.b64u.dec(m[2]).toString());
  check("VAPID signature verifies", ok && claims.aud === "https://fcm.googleapis.com" && m[4] === keys.publicKey);
}

const rules = path.join(path.dirname(fileURLToPath(import.meta.url)), "push-rules-test.mjs");
if (fs.existsSync(rules)) await (await import(rules)).run(jiti, root, check);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : "all passed");
process.exit(fails ? 1 : 0);
