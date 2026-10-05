// Web push state on disk (§24): the VAPID key pair, every subscribed device, and each device's prefs.
// ~/.minami/push.json, override with MINAMI_PUSH_FILE. Server-only.
//
// The key pair is generated once and must then never change: every subscription a phone holds was made
// against this public key, and a new key silently orphans all of them (the push service 403s the
// mismatched VAPID signature, and nothing on the phone notices). Written 0600 because the file holds a
// private key that can send notifications to every subscribed device.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateVapidKeys, type PushSub, type VapidKeys } from "./webpush";

export type Device = PushSub & { createdAt: number; ua?: string; /** silent "finished" notices — default on */ finished?: boolean; lastOk?: number; lastStatus?: number };
type File = { vapid: VapidKeys; subs: Device[] };

const FILE = () => process.env.MINAMI_PUSH_FILE || path.join(os.homedir(), ".minami", "push.json");
// globalThis: Next can evaluate this module once per route bundle, and two copies of the cache would
// each write their own idea of the subscription list over the other's.
const G = globalThis as unknown as { __minamiPushFile?: File };

function load(): File {
  if (G.__minamiPushFile) return G.__minamiPushFile;
  let f: Partial<File> = {};
  try { f = JSON.parse(fs.readFileSync(FILE(), "utf8")); } catch { /* first run */ }
  const fresh = !f.vapid?.publicKey || !f.vapid?.privateKey;
  G.__minamiPushFile = { vapid: fresh ? generateVapidKeys() : f.vapid!, subs: Array.isArray(f.subs) ? f.subs : [] };
  if (fresh) save();
  return G.__minamiPushFile;
}

function save() {
  const f = G.__minamiPushFile!;
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  const tmp = FILE() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(f, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
}

export const vapidKeys = (): VapidKeys => load().vapid;
export const devices = (): Device[] => load().subs;
export const device = (endpoint: string): Device | undefined => load().subs.find((d) => d.endpoint === endpoint);

export function upsertDevice(sub: PushSub, extra: { ua?: string; finished?: boolean; replaces?: string }): Device {
  const f = load();
  // `replaces` is the old endpoint from pushsubscriptionchange — carry its prefs over, so a rotated
  // subscription doesn't quietly turn "finished" notices back on.
  const prev = f.subs.find((d) => d.endpoint === sub.endpoint) || (extra.replaces ? f.subs.find((d) => d.endpoint === extra.replaces) : undefined);
  f.subs = f.subs.filter((d) => d.endpoint !== sub.endpoint && d.endpoint !== extra.replaces);
  const d: Device = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, createdAt: prev?.createdAt ?? Date.now(),
    ua: extra.ua ?? prev?.ua, finished: extra.finished ?? prev?.finished ?? true };
  f.subs.push(d);
  // Bounded: one person, a handful of browsers. A runaway client re-subscribing in a loop must not
  // turn every need into fifty outbound requests.
  if (f.subs.length > 20) f.subs = f.subs.slice(-20);
  save();
  return d;
}

export function removeDevice(endpoint: string): boolean {
  const f = load();
  const n = f.subs.length;
  f.subs = f.subs.filter((d) => d.endpoint !== endpoint);
  if (f.subs.length !== n) save();
  return f.subs.length !== n;
}

/** Delivery bookkeeping — written only when the status changes, so a steady stream of 201s doesn't
 *  rewrite the file on every push. */
export function noteDelivery(endpoint: string, status: number) {
  const d = device(endpoint);
  if (!d) return;
  const changed = d.lastStatus !== status;
  d.lastStatus = status;
  if (status >= 200 && status < 300) d.lastOk = Date.now();
  if (changed) save();
}
