// The notification bridge end to end: a real Android (an emulator) running
// Professional Goat, a throwaway shell, and real SMS through Google Messages.
//
//     cd shell
//     npm i --no-save playwright
//     (boot an emulator, or plug in a phone with USB debugging)
//     node commstest.js
//
// lib/comms-test.js holds the laptop's rules; this holds the parts only a
// phone can: that Android binds Professional Goat's listener, that a text
// arrives as a herald card, that a one-time code never leaves the phone, that
// a reply typed on the laptop is sent by the phone's own Messages app, and
// that an errand fetch is made natively.
//
// It installs ../app/build/outputs/apk/debug/app-debug.apk (GOAT_APK to
// override) over whatever Professional Goat is on the device and pairs it with
// the throwaway shell — so point it at an emulator, not at the phone you use.
// With no device it says so and exits 0, so it never fails a run on a machine
// without one.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const ADB = process.env.ADB || path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk", "platform-tools", "adb.exe");
// Professional Goat: the Android project at the root of this repo, package
// com.cowwie, its listener at .desk.DeskNotificationListener, prefs "cowwie".
const APK = process.env.GOAT_APK || path.join(__dirname, "..", "app", "build", "outputs", "apk", "debug", "app-debug.apk");
const PKG = "com.cowwie";
const LISTENER = `${PKG}/com.professionalgoat.desk.DeskNotificationListener`;

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, every = 250) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch {}
    await wait(every);
  }
  return null;
}
const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8", windowsHide: true }).trim();

(async () => {
  let device = "";
  try { device = adb("devices").split("\n").slice(1).find((l) => /\tdevice$/.test(l.trim()) || /\sdevice$/.test(l)) || ""; } catch {}
  if (!device) { console.log("  skip  no Android device or emulator attached (adb devices)"); process.exit(0); }
  if (!fs.existsSync(APK)) { console.log(`  skip  no APK at ${APK} (gradlew assembleDebug at the repo root)`); process.exit(0); }
  const serial = device.split(/\s/)[0];
  const emulator = serial.startsWith("emulator-");
  // The emulator reaches this machine at 10.0.2.2; a phone on the LAN does
  // not, and this test does not guess a LAN address for it.
  if (!emulator) { console.log("  skip  a real phone is attached; this test only runs against an emulator"); process.exit(0); }

  let _electron;
  try { ({ _electron } = require("playwright")); } catch { console.error("npm i --no-save playwright"); process.exit(2); }

  const token = crypto.randomBytes(16).toString("hex");
  const port = 19500 + Math.floor(Math.random() * 300);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "comms-test-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "comms-data-"));
  const app = await _electron.launch({
    args: [path.join(__dirname, "main.js"), `--user-data-dir=${profile}`, `--data-dir=${dataDir}`, `--sync-port=${port}`, "--no-pull"],
    cwd: __dirname,
    env: { ...process.env, FORGE_PORT: "9", MUT_SYNC_TOKEN: token },
  });
  const M = (fn, a) => app.evaluate(fn, a);
  const cards = () => M(() => globalThis.__testables.herald.state().cards);

  try {
    await until(() => M(() => !!globalThis.__testables), 30000);
    // Nobody is idle in a test: without this a CI box that has been idle
    // for five minutes would send everything to the drawer.
    await M(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; powerMonitor.getSystemIdleState = () => "active"; return true; });
    const listening = await until(() => {
      try { return JSON.parse(fs.readFileSync(path.join(dataDir, "services.json"), "utf8")).mutSync.port; } catch { return null; }
    }, 20000);
    ok("the throwaway shell's sync server is up", listening === port, listening);

    // ---- the phone ----------------------------------------------------------
    adb("install", "-r", APK);
    adb("shell", "pm", "grant", PKG, "android.permission.POST_NOTIFICATIONS");
    adb("shell", "cmd", "notification", "allow_listener", LISTENER);
    // The grant lands in settings a beat after the command returns.
    const allowed = await until(() => {
      const v = adb("shell", "settings", "get", "secure", "enabled_notification_listeners");
      return v.includes(LISTENER) || v.includes(`${PKG}/.desk.DeskNotificationListener`) ? v : null;
    }, 15000, 500);
    ok("Android lists Professional Goat's listener", !!allowed);
    // A force-stop, on purpose: Android does not rebind a force-stopped
    // app's listener when it is next opened, so this proves the app asks for
    // it (requestRebind) rather than the bridge staying down unnoticed.
    adb("shell", "am", "force-stop", PKG);
    // One string, single-quoted: adb hands its arguments to the device's own
    // shell, which split the link at its "&" and dropped the host.
    adb("shell", `am start -W -a android.intent.action.VIEW -d 'goat://pair?token=${token}&host=10.0.2.2:${port}' ${PKG}`);
    // The pairing landed when the phone first asks the bridge for anything.
    const seen = await until(() => M(() => (globalThis.__testables.comms.status().phoneSeen || 0) > 0 || globalThis.__testables.heraldControl("state").phone.page > 0), 30000, 1000);
    ok("opening Professional Goat on the pairing link brings it to the bridge", !!seen);

    // ---- a text arrives -----------------------------------------------------
    const number = "555" + String(Math.floor(1000 + Math.random() * 8999));
    adb("emu", "sms", "send", number, "are you coming sunday? bring the good bread");
    // Two minutes, not thirty seconds: on a freshly wiped emulator Messages
    // runs its first-start pipeline before it posts anything, and took 62 s
    // to show the first text while the listener sat ready.
    const card = await until(async () => (await cards()).find((c) => c.kind === "message" && /good bread/.test(c.body)), 120000, 500);
    ok("a text on the phone arrives as a herald card", !!card, card ? undefined : {
      cards: await cards(),
      comms: await M(() => globalThis.__testables.comms.status()),
      waiting: await M(() => globalThis.__testables.herald.state().waiting),
    });
    if (card) {
      ok("from the number that sent it", /\d{3}/.test(card.who), card.who);
      ok("with a Reply on it, because Messages offers one", card.acts.includes("reply"), card.acts);
    }

    // ---- a code never leaves -------------------------------------------------
    adb("emu", "sms", "send", "5550199", "Your verification code is 482913. Do not share it.");
    await wait(6000);
    const leaked = (await cards()).some((c) => /482913/.test(c.body || ""));
    ok("a one-time code never reaches the laptop", !leaked);
    const st = await M(() => globalThis.__testables.comms.status());
    ok("and the laptop never held it either", st.dropped === 0, st);

    // ---- a reply goes back through Messages ----------------------------------
    if (card) {
      const said = "yes! bringing the sourdough " + number.slice(-2);
      const res = await M((_e, a) => globalThis.__testables.herald.act(a.id, "reply", { text: a.said }), { id: card.id, said });
      ok("the reply is accepted", res && res.ok !== false, res);
      const done = await until(async () => {
        const c = (await cards()).find((x) => x.id === card.id);
        return c && c.resolved ? c.resolved : null;
      }, 12000);
      ok("and the phone says it went (not just queued)", done && done.tag === "SENT", done);
      // "SENT" on the card means the phone handed the words to Messages'
      // Reply action without an error. Whether Messages then sent them shows
      // in the SMS store a moment later, as type 2 (sent) to the same number.
      let store = "";
      const sentRow = await until(() => {
        try { store = adb("shell", "content", "query", "--uri", "content://sms", "--projection", "address:body:type"); } catch { return null; }
        return store.split("\n").find((l) => l.includes(said) && /type=2\b/.test(l) && l.includes(number)) || null;
      }, 15000, 1000);
      if (store) ok("and Messages itself sent it, to the same number", !!sentRow, store.split("\n").slice(0, 3));
      else console.log("  skip  could not read the SMS store to confirm");
      await wait(3000);
      const echoes = (await cards()).filter((c) => /sourdough/.test(c.body || "") && !c.resolved);
      ok("your own reply is not announced back to you", echoes.length === 0, echoes);
    }

    // ---- an errand is fetched natively --------------------------------------
    const filed = await fetch(`http://127.0.0.1:${port}/errands`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/" }),
    }).then((r) => r.json()).catch((e) => ({ error: e.message }));
    ok("an errand is filed", !!filed.id, filed);
    if (filed.id) {
      const res = await until(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/errands/${filed.id}`, { headers: { authorization: `Bearer ${token}` } }).then((x) => x.json());
        return r.done ? r.result : null;
      }, 40000, 1000);
      ok("the phone fetched it from a site that sends no CORS header", res && res.ok && /Example Domain/.test(res.text || ""), res && { ok: res.ok, status: res.status, error: res.error, len: (res.text || "").length });
    }
  } catch (e) {
    failed++;
    console.log("  FAIL (threw)", (e && e.stack) || e);
  } finally {
    await app.close().catch(() => {});
    for (const d of [profile, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
