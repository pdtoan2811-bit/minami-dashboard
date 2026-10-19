// The limit failover's decision table and config store (§6b), with no token-slayer, no Keychain and
// no real limit: `decide()` is pure, and the config file is pointed at a temp dir.
//   node scripts/failover-test.mjs
import { createJiti } from "jiti";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "failover-test-"));
// Before the import: CONFIG_FILE is read once, at module load.
process.env.MINAMI_ACCOUNT_CONFIG = path.join(tmp, "account.json");
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { decide, LIMIT_TEXT } = await jiti.import(path.join(root, "lib/account-failover.ts"));
const acct = await jiti.import(path.join(root, "lib/preferred-account.ts"));

let failed = 0;
const check = (name, ok, got) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — got ${JSON.stringify(got)}`}`);
  if (!ok) failed++;
};

const MAIN = "main@example.com";
const FALL = "fallback@example.com";
const slot = (email, extra = {}) => ({ email, state: "ready", usage: { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }, ...extra });
const pool = [slot(MAIN, { state: "active" }), slot(FALL)];
const hit = { hitOn: MAIN, type: "seven_day", resetsAt: 1_800_000_000 };

let d = decide({ hit, live: MAIN, target: FALL, pool });
check("weekly limit on main → switch to fallback", d.action === "switch" && d.to === FALL, d);

d = decide({ hit, live: MAIN, target: "", pool });
check("no target chosen → off", d.action === "none" && /off/.test(d.reason), d);

d = decide({ hit, live: FALL, target: FALL, pool });
check("another pane already switched → respawn, not a second switch", d.action === "respawn", d);

d = decide({ hit: { ...hit, hitOn: FALL }, live: FALL, target: FALL, pool });
check("the fallback itself ran out → none (one hop only)", d.action === "none" && /fallback account itself/.test(d.reason), d);

d = decide({ hit, live: MAIN, target: "new@example.com", pool });
check("target not in the pool → none, names tok add", d.action === "none" && /tok add new@example.com --login/.test(d.reason), d);

d = decide({ hit, live: MAIN, target: FALL, pool: [pool[0], slot(FALL, { state: "reauth" })] });
check("target needs re-login → none", d.action === "none" && /signing in again/.test(d.reason), d);

d = decide({ hit, live: MAIN, target: FALL, pool: [pool[0], slot(FALL, { usage: { seven_day: { utilization: 100 }, five_hour: { utilization: 0 } } })] });
check("target is out of the same window → none", d.action === "none" && /weekly limit too/.test(d.reason), d);

d = decide({ hit: { ...hit, type: "five_hour" }, live: MAIN, target: FALL, pool: [pool[0], slot(FALL, { usage: { seven_day: { utilization: 100 }, five_hour: { utilization: 5 } } })] });
check("5h hit, target's weekly is full → none (either window blocks)", d.action === "none" && /weekly limit too/.test(d.reason), d);

d = decide({ hit: { hitOn: null, text: "You've hit your weekly limit" }, live: MAIN, target: FALL, pool });
check("unknown born-account falls back to live → switch", d.action === "switch", d);

check("limit text: weekly", LIMIT_TEXT.test("You've hit your weekly limit · resets Oct 19 at 1pm (Asia/Saigon)"));
check("limit text: session", LIMIT_TEXT.test("You've hit your session limit · resets 1:30pm (Asia/Saigon)"));
check("limit text: legacy", LIMIT_TEXT.test("Claude AI usage limit reached|1792378800"));
check("limit text: overload is not a limit", !LIMIT_TEXT.test("API Error: 529 Overloaded"));

// The config store: saving one choice must not erase the other.
acct.writePreferred(MAIN);
acct.writeOnLimit(FALL);
acct.writePreferred(MAIN);
check("preferred survives writing onLimit and vice versa", acct.readPreferred() === MAIN && acct.readOnLimit() === FALL, fs.readFileSync(process.env.MINAMI_ACCOUNT_CONFIG, "utf8"));
acct.writeOnLimit("");
check("onLimit \"\" turns it off and drops the key", acct.readOnLimit() === "" && !("onLimit" in JSON.parse(fs.readFileSync(process.env.MINAMI_ACCOUNT_CONFIG, "utf8"))));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
