// Shell tests, in-repo, against the real Electron build.
//
//     cd desktop
//     npm i --no-save playwright     (driver only; electron stays the sole dep,
//                                     --no-save keeps package.json at 13 pkgs)
//     node test.js                   (Linux CI: xvfb-run -a node test.js)
//
// Covers the invariants everything else leans on: capability sanitising, the
// Sanctum's declared surface, the scoped store, the shell's own views coming
// up, and briefs reaching Auri's cards. Runs beside a live shell: its own
// --user-data-dir, --data-dir and --sync-port, --no-pull and --no-egress.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let _electron;
try {
  ({ _electron } = require("playwright"));
} catch {
  console.error("playwright is not installed here. Run: npm i --no-save playwright");
  process.exit(2);
}

let passed = 0;
let failed = 0;
function ok(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`);
  }
}

async function pageByUrl(app, needle, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const page of app.windows()) {
      if (page.url().includes(needle)) return page;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
async function until(fn, ms = 8000, every = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true; } catch {}
    await new Promise((r) => setTimeout(r, every));
  }
  return false;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ifreglen-test-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ifreglen-data-"));
  const syncPort = 18400 + Math.floor(Math.random() * 400);
  const app = await _electron.launch({
    args: [path.join(__dirname, "main.js"), `--user-data-dir=${profile}`, `--data-dir=${dataDir}`, `--sync-port=${syncPort}`, "--no-pull", "--no-egress"],
    cwd: __dirname,
    env: { ...process.env, FORGE_PORT: "9" },
  });
  const M = (fn, a) => app.evaluate(fn, a);

  try {
    await until(() => M(() => !!globalThis.__testables), 30000);
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.getSystemIdleTime = () => 0;
      powerMonitor.getSystemIdleState = () => "active";
      return true;
    });

    // ---- capability sanitising, in the real main process ----------------
    const stripped = await M(() =>
      globalThis.__testables.effectiveCaps({
        kind: "external",
        capabilities: ["fs", "apps", "bus", "store", "clip"],
      })
    );
    ok("external app loses fs", !stripped.includes("fs"), stripped);
    ok("external app loses apps/bus",
       !stripped.some((c) => ["apps", "bus"].includes(c)), stripped);
    ok("external app keeps store", stripped.includes("store"), stripped);
    // 'clip' is the one capability that must SURVIVE on an external app —
    // external sites are exactly where clipping happens, and it exposes
    // nothing to the page.
    ok("external app KEEPS clip (deliberate)", stripped.includes("clip"), stripped);

    const noRoot = await M(() =>
      globalThis.__testables.effectiveCaps({ kind: "static", capabilities: ["fs", "store"] })
    );
    ok("fs without a root is dropped", !noRoot.includes("fs"), noRoot);

    // ...and clip must never grow a preload surface.
    const preloadSrc = fs.readFileSync(path.join(__dirname, "preload.js"), "utf8");
    ok("clip grants the page nothing", !/api\.clip\s*=/.test(preloadSrc));

    // ---- the Sanctum boots with its declared surface ---------------------
    const lounge = await pageByUrl(app, "lounge");
    ok("lounge view loads", !!lounge);
    if (!lounge) throw new Error("no lounge; remaining tests need it");
    await lounge.waitForLoadState("domcontentloaded");

    const surf = await lounge.evaluate(() => ({
      app: window.roost?.app,
      caps: window.roost?.capabilities || [],
      apps: !!window.roost?.apps?.list,
      bus: !!window.roost?.bus?.publish,
      store: !!window.roost?.store,
      fs: !!window.roost?.fs,
      ledger: !!window.roost?.ledger,
    }));
    ok("preload identifies the app", surf.app === "launcher", surf);
    ok("launcher holds store + apps + bus", surf.store && surf.apps && surf.bus, surf);
    ok("launcher has no fs surface", !surf.fs, surf);
    ok("there is no ledger surface any more", !surf.ledger, surf);
    ok("the Sanctum is branded Ifreglen", /Ifreglen/.test(await lounge.textContent(".overline")));

    // ---- scoped store roundtrip -----------------------------------------
    await lounge.evaluate(() => window.roost.store.set("test:key", { n: 42 }));
    const got = await lounge.evaluate(() => window.roost.store.get("test:key"));
    ok("scoped store roundtrip", got && got.value && got.value.n === 42, got);
    await lounge.evaluate(() => window.roost.store.delete("test:key"));
    ok("the store landed under the test's data dir", fs.existsSync(path.join(dataDir, "store", "launcher", "store.json")));

    // ---- the registry the rail sees -------------------------------------
    const list = await lounge.evaluate(() => window.roost.apps.list());
    const ids = (list.apps || []).map((a) => a.id);
    ok("the registry holds exactly Ifreglen's apps",
      ["launcher", "roam", "lookout", "credentials", "onboarding", "trove", "forge"].every((id) => ids.includes(id))
      && !ids.some((id) => /glamour|feedcap|maizey|wheattodd|findaliens|goblin|kornbot|mut-room/.test(id)), ids);
    ok("nothing in the registry is capturing", !(list.apps || []).some((a) => "capturing" in a && a.capturing), list.apps);

    // ---- the shell's own views -------------------------------------------
    const chrome = await pageByUrl(app, "chrome.html");
    ok("chrome view loads", !!chrome);
    if (chrome) {
      ok("the rail is branded Ifreglen", (await chrome.textContent(".brand .word")).trim() === "Ifreglen");
      ok("the rail has no capture switch", await chrome.evaluate(() => !document.getElementById("cap")));
    }
    const herald = await pageByUrl(app, "renderer/herald/index.html");
    ok("the herald's view loads", !!herald);
    ok("there is no Müt view", !app.windows().some((p) => p.url().includes("mut.html")));

    // ---- briefs: an app's word reaches the phone's list and Auri ----------
    const filed = await M(() => globalThis.__testables.briefFile({ source: "lookout", title: "Board moved", body: "a rule changed", url: "https://example.org/x" }));
    ok("a brief is filed", filed && filed.ok && filed.id, filed);
    const card = await M(() => globalThis.__testables.herald.state().cards.find((c) => c.who === "lookout"));
    ok("and is one of Auri's cards, band 2, open/dismiss only",
      card && card.band === 2 && card.acts.includes("open") && card.acts.includes("dismiss") && !card.acts.includes("allow"), card);
    const quiet = await M(() => globalThis.__testables.briefFile({ source: "credentials", title: "renewed", level: "quiet" }));
    const quietCard = await M(() => globalThis.__testables.herald.state().cards.find((c) => c.who === "credentials"));
    ok("a quiet brief is filed and raises no card", quiet && quiet.ok && !quietCard, { quiet, quietCard });
    const listed = await M(() => globalThis.__testables.briefs.list());
    ok("both are in the phone's list, newest first", listed.length === 2 && listed[0].source === "credentials" && listed[1].read === false, listed);
    ok("and in briefs.jsonl", fs.existsSync(path.join(dataDir, "briefs.jsonl")));

    // Through the bus, as a hosted app would: `source` is the app, never the payload's word.
    await lounge.evaluate(() => window.roost.bus.publish("briefs.file", { source: "someone-else", title: "from the Sanctum" }));
    await until(() => M(() => globalThis.__testables.briefs.list().some((b) => b.title === "from the Sanctum")), 3000);
    const viaBus = await M(() => globalThis.__testables.briefs.list().find((b) => b.title === "from the Sanctum"));
    ok("a brief on the bus is filed under the publishing app", viaBus && viaBus.source === "launcher", viaBus);

    const noted = await M(() => globalThis.__testables.noteFile({ text: "call the pharmacy" }));
    const noteCard = await M(() => globalThis.__testables.herald.state().cards.find((c) => c.who === "Professional Goat"));
    ok("a note from the phone is a card from Professional Goat", noted && noted.ok && noteCard && noteCard.body === "call the pharmacy", { noted, noteCard });

    // ---- the bridge answers as Ifreglen -----------------------------------
    const services = JSON.parse(fs.readFileSync(path.join(dataDir, "services.json"), "utf8"));
    const port = services.mutSync && services.mutSync.port;
    ok("the bridge wrote down where it listens", !!port, services);
    if (port) {
      const ping = await (await fetch(`http://127.0.0.1:${port}/ping`)).json();
      ok("/ping answers as ifreglen", ping.who === "ifreglen" && ping.ok === true, ping);
      const token = services.mutSync.token;
      if (token) {
        const r = await fetch(`http://127.0.0.1:${port}/briefs`, { headers: { authorization: `Bearer ${token}` } });
        const j = await r.json();
        ok("GET /briefs hands the phone the list", r.ok && Array.isArray(j.briefs) && j.briefs.length === 3, j);
        // The morning brief: filed on demand from this machine, schedule readable and settable.
        const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
        const m = await (await fetch(`http://127.0.0.1:${port}/morning`, { method: "POST", headers: H })).json();
        ok("POST /morning files today's brief", m.ok === true && !!m.id, m);
        const after = await (await fetch(`http://127.0.0.1:${port}/briefs`, { headers: H })).json();
        ok("and the phone sees it, titled Morning brief", after.briefs.some((b) => /^Morning brief/.test(b.title) && b.source === "ifreglen"), after.briefs.map((b) => b.title));
        const sch = await (await fetch(`http://127.0.0.1:${port}/morning/schedule`, { method: "POST", headers: H, body: JSON.stringify({ time: "06:45", days: [1, 3, 5] }) })).json();
        ok("the schedule can be set", sch.time === "06:45" && sch.days.join() === "1,3,5", sch);
        ok("morning.json keeps it", JSON.parse(fs.readFileSync(path.join(dataDir, "morning.json"), "utf8")).time === "06:45");
      } else {
        console.log("  skip GET /briefs over HTTP (no token published)");
      }
    }
  } catch (err) {
    failed += 1;
    console.log(`  FAIL (harness) ${String(err && err.message || err)}`);
  } finally {
    await app.close().catch(() => {});
    for (const d of [profile, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
