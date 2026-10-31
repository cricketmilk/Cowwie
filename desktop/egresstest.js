// The browser through Haruspex, in a real shell, on whatever network this is.
//
//   cd shell && node egresstest.js        (playwright, like roamtest.js; Windows,
//                                          and C:\haruspex installed)
//
// What it holds the shell to (2026-10-13):
//   - the browser is routed through Haruspex's Egress Guard (127.0.0.1:8789),
//     and Haruspex is started at once, not after the startWithShell delay;
//   - the shell knows whether a page may go direct with Haruspex down
//     (wildsControl egress-status .fallback, from lib/netpolicy.js);
//   - a page asked for in the first instant -- before Haruspex listens -- is
//     not left failed: when Haruspex announces itself the shell loads it again
//     (retryProxyFailures). That is the case a restored tab hits on every boot
//     off a VPN, where no direct fallback is allowed;
//   - when the shell quits, the Haruspex it started goes with it.
// The Wilds' own behaviour is roamtest.js's, which runs --no-egress.
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");

let _electron;
try { ({ _electron } = require("playwright")); }
catch { console.log("  skip playwright is not installed (npm i --no-save playwright)"); process.exit(0); }

let pass = 0, fail = 0;
function ok(label, cond, got) {
  if (cond) { pass++; console.log("  ok  ", label); }
  else { fail++; console.log("  FAIL", label, got === undefined ? "" : `-> ${JSON.stringify(got)}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const listening = (port) => new Promise((r) => {
  const s = net.connect(port, "127.0.0.1", () => { s.destroy(); r(true); });
  s.on("error", () => r(false));
});

(async () => {
  if (process.platform !== "win32" || !fs.existsSync("C:/haruspex/haruspex/egress.py")) {
    console.log("  skip Haruspex runs on Windows only, from C:\\haruspex");
    process.exit(0);
  }
  if (await listening(8795) || await listening(8789)) {
    console.log("  skip a Haruspex is already running here; this test needs to start its own");
    process.exit(0);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "egress-profile-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "egress-data-"));
  const syncPort = 19600 + Math.floor(Math.random() * 300);
  const t0 = Date.now();
  const app = await _electron.launch({
    args: [path.join(__dirname, "main.js"), `--user-data-dir=${profile}`, `--data-dir=${dataDir}`, `--sync-port=${syncPort}`, "--no-pull"],
    cwd: __dirname,
    env: { ...process.env, ...(process.env.EGRESS_TRACE ? { EGRESS_TRACE: "1" } : {}) },
  });
  if (process.env.EGRESS_TRACE) {
    app.process().stdout.on("data", (d) => { for (const l of String(d).split("\n")) if (/egress/.test(l)) console.log("        " + l.trim()); });
  }
  const M = (fn, a) => app.evaluate(fn, a);
  try {
    for (let i = 0; i < 80; i++) { if (await M(() => !!globalThis.__testables)) break; await wait(100); }

    // As early as the harness can: Haruspex is very likely not listening yet.
    const early = await listening(8789);
    await M(() => globalThis.__testables.openWeb("https://example.com/"));
    console.log(`        (tab asked for ${Date.now() - t0} ms after launch; proxy already listening: ${early})`);

    let up = null;
    for (let i = 0; i < 300 && up == null; i++) { if (await listening(8789)) up = Date.now() - t0; else await wait(100); }
    ok("Haruspex is started with the shell and its proxy listens on 8789", up != null, up);
    ok("and quickly (not after the startWithShell delay)", up != null && up < 12000, `${up} ms`);

    const st = await M(() => globalThis.__testables.wildsControl("egress-status", {}));
    ok("the shell reports the route and the fallback rule", st && st.enabled === true && st.port === 8789 && st.fallback && typeof st.fallback.allowed === "boolean",
      st && { enabled: st.enabled, port: st.port, fallback: st.fallback });
    console.log(`        (direct fallback here: ${st && st.fallback && st.fallback.allowed ? "allowed" : "off"} -- ${st && st.fallback && st.fallback.why})`);

    let state = null;
    for (let i = 0; i < 120; i++) {
      state = await M(() => {
        const s = globalThis.__testables.roamState();
        const t = (s.tabs || []).find((x) => /example\.com/.test(x.url || "") || (x.failed && /example\.com/.test(x.failed.url || "")));
        return t ? { url: t.url, title: t.title, failed: t.failed, loading: t.loading } : { tabs: (s.tabs || []).map((x) => x.url) };
      });
      if (state && state.title && /Example Domain/.test(state.title) && !state.failed) break;
      await wait(250);
    }
    ok("a page asked for before Haruspex listened ends up loaded, through it", state && /Example Domain/.test(state.title || "") && !state.failed, state);
  } catch (e) {
    ok("ran to the end", false, String(e && e.message || e));
  } finally {
    await app.close().catch(() => {});
  }
  // The shell stops what it started (stopLocal on quit).
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { gone = !(await listening(8789)) && !(await listening(8795)); if (!gone) await wait(250); }
  ok("Haruspex goes when the shell quits", gone);
  try { fs.rmSync(profile, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
