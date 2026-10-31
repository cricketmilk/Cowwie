// The Wilds, against the real Electron build.
//
//     cd shell
//     npm i --no-save playwright     (driver only — electron stays the sole dep)
//     node roamtest.js
//
// Separate from test.js on purpose: that suite ends in a live Forge
// conversation and needs C:\Forge up, so a browser regression would sit
// behind an unrelated dependency. This one needs nothing but the shell, and
// runs on a throwaway --user-data-dir so it can run while your real shell is
// open — the parallel-profile escape hatch main.js documents at boot.
//
// The unit half of the browser (the omnibox rule, history, pins, the session)
// is in lib/roam-test.js and needs no Electron at all. Put a new assertion in
// whichever of the two can hold it; prefer that one.

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

let passed = 0, failed = 0, skipped = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`); }
};
const skip = (name, why) => { skipped++; console.log(`  skip ${name}  (${why})`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 20000, every = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch {}
    await wait(every);
  }
  return false;
}

// The shell's runtime state — the Trove, the larder, captures, ui-state and
// the browser's memory — all hang off DATA, which --data-dir moves. Both
// throwaway dirs matter here for different reasons:
//
//   --user-data-dir   Chromium's profile: its own persona jars and its own
//                     single-instance lock, so this runs beside a real shell.
//   --data-dir        the shell's own state. Without it the test restores the
//                     PREVIOUS run's tabs, and — worse — its clip assertion
//                     appends to data/trove/index.jsonl, which is an
//                     append-only evidence archive that no test has any
//                     business writing into.

async function online() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    const r = await fetch("https://example.com", { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "roam-test-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "roam-data-"));
  const net = await online();

  const app = await _electron.launch({
    args: [
      path.join(__dirname, "main.js"),
      `--user-data-dir=${profile}`,
      `--data-dir=${dataDir}`,
      // Never follow the hoard from a test. Off the home LAN the launch pull
      // waited out its git timeout BEFORE the window existed, and the harness's
      // first activate() met a null win ("reading 'contentView'") -- the
      // failure noted as "fails at baseline" since 2026-10-11.
      "--no-pull",
      // Browse direct, not through Haruspex: on a public network with no VPN
      // the shell allows no direct fallback, and a page asked for before the
      // shell's freshly started Haruspex is listening fails. This suite tests
      // The Wilds, not the network it happens to run on.
      "--no-egress",
    ],
    cwd: __dirname,
  });
  const M = (fn, a) => app.evaluate(fn, a);

  try {
    await until(() => M(() => !!globalThis.__testables), 30000);

    // Reach the real IPC handlers — the same entry points the browser's bar
    // and the rail call. evaluate() has no lexical require here; the electron
    // module arrives as the first argument.
    await M(({ ipcMain }) => {
      const h = (n) => ipcMain._invokeHandlers.get(n);
      globalThis.__roam = (a, p) => h("roost:roam")({}, a, p);
      globalThis.__activate = (id) => h("roost:activate")({}, id);
      globalThis.__apps = () => h("roost:apps")({});
      globalThis.__nav = (id, dir) => h("roost:nav")({}, { id, dir });
      globalThis.__hibernate = (id) => h("roost:close-view")({}, id);
      return true;
    });
    const roam = (action, payload = {}) =>
      M((_e, { action, payload }) => globalThis.__roam(action, payload), { action, payload });

    // ---- it exists, and the rail can see it ------------------------------
    const apps = await M(() => globalThis.__apps());
    const wilds = apps.apps.find((a) => a.kind === "browser");
    ok("The Wilds is registered", !!wilds, apps.apps.map((a) => a.id));
    ok("it sits second, so Ctrl+2 reaches it", apps.apps[1]?.id === "roam", apps.apps[1]?.id);

    await M(() => globalThis.__activate("roam"));
    await until(async () => (await roam("state")).tabs.length > 0);
    let st = await roam("state");
    ok("activating it opens a tab", st.tabs.length === 1, st.tabs.length);
    ok("which starts blank", st.tabs[0].blank === true, st.tabs[0]);
    ok("in the browser's own jar", st.persona === "roam", st.persona);

    // ---- the registry's pins reach the browser, with their jars ----------
    // These were four app entries in a "Boards" group. They existed only
    // because a registry entry could name a persona and a bookmark could not;
    // a pin can now. The jar is the whole point — a board you are signed into
    // is worthless opened signed-out.
    // Straight from the registry file: the claim under test is that what
    // apps.config.json declares is what the browser ends up holding.
    let declared = [];
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(__dirname, "apps.config.json"), "utf8"));
      declared = (reg.apps.find((a) => a.kind === "browser") || {}).pins || [];
    } catch {}
    if (!declared.length) {
      skip("the registry's pins are seeded into the browser", "none declared");
    } else {
      const pins = st.pins || [];
      ok("the registry's pins are seeded into the browser",
        declared.every((d) => pins.some((p) => p.url === d.url)), pins.map((p) => p.url));
      ok("and each keeps the jar it was declared with",
        declared.every((d) => pins.find((p) => p.url === d.url)?.persona === d.persona),
        pins.map((p) => `${p.title}:${p.persona}`));
      // The old entries are gone from the rail — that is the simplification.
      ok("and the Boards group is no longer a set of apps",
        !apps.apps.some((a) => a.group === "Boards"), apps.apps.filter((a) => a.group).map((a) => a.group));
    }

    // ---- the jars on offer ------------------------------------------------
    ok("ordinary jars are offered",
      st.personas.includes("curio") && st.personas.includes("workshop") && st.personas.includes("work"), st.personas);
    const refused = await roam("persona", { name: "no-such-jar" });
    ok("a jar nobody declared is refused", !!refused.error, refused);

    // ---- a tab gets a web page's privileges, by the real code path -------
    const caps = await M(() => globalThis.__testables.effectiveCaps(
      globalThis.__testables.roamTabCfg({ id: "t1", persona: "roam", url: "https://example.com" })));
    ok("a tab is treated as external, so fs/apps/bus are stripped",
      !["fs", "apps", "bus"].some((c) => caps.includes(c)), caps);
    ok("but it keeps clip, or browsing here would be no better than out there",
      caps.includes("clip"), caps);

    // ---- the overlay rule ------------------------------------------------
    // The bug this shell keeps re-growing: a sheet drawn taller than the view
    // it lives in is INVISIBLE, not broken-looking, so nobody notices for
    // months. The bar is 76px; its omnibox dropdown has to grow the view
    // first. Assert the geometry, not the intention.
    const overlay = () => M(() => globalThis.__testables.roamOverlay());
    // Read the window fresh each time and compare relatively: hard-coding the
    // rail width, or reusing a content rect captured before the window had
    // settled, makes this fail for reasons that have nothing to do with the
    // overlay rule it is supposed to be guarding.
    const win = () => M(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getContentBounds());

    // Note: a fresh browser opens with its omnibox already down — a blank tab
    // is a cursor waiting in an address bar — so "at rest" here means after an
    // explicit collapse, not immediately after activating.
    //
    // Only the VIEW's geometry is asserted. The bar's own innerHeight is in
    // the seam for debugging, but Chromium defers a renderer's viewport resize
    // while the widget is producing no frames, and under a headless-ish test
    // launch the window is often occluded — so asserting on it produces a test
    // that fails for reasons that have nothing to do with the code.
    await roam("expand", { open: false });
    let ov = await overlay();
    ok("collapsed, the bar is a thin strip", !ov.tall && ov.bar.height === 76, ov);

    await roam("expand", { open: true });
    ov = await overlay();
    const w = await win();
    ok("opening a sheet grows the bar over the whole page area",
      ov.tall && ov.bar.height === w.height && ov.bar.x + ov.bar.width === w.width,
      { ov, win: w });

    await roam("expand", { open: false });
    ov = await overlay();
    ok("and closing it puts the bar back", !ov.tall && ov.bar.height === 76, ov);

    // ---- nothing can spawn a window outside the shell --------------------
    // The rail, Mut and the browser's own bar are built directly rather than
    // through createView, so they never had its window-open handler — and with
    // none set, Electron's default for window.open is a NATIVE WINDOW. None of
    // those pages opens one today, which is exactly why it would go unnoticed
    // until one did.
    const sealed = await M(({ webContents }) => {
      const own = webContents.getAllWebContents().filter((w) => {
        const u = w.getURL() || "";
        return u.includes("/renderer/chrome.html") || u.includes("/renderer/mut.html") || u.includes("/renderer/roam/index.html");
      });
      // An unset handler is the dangerous state; Electron gives no getter, so
      // ask the pages to try it and see whether a window appears.
      return { found: own.length, urls: own.map((w) => (w.getURL() || "").split("/renderer/")[1]) };
    });
    ok("the shell's own views are all accounted for", sealed.found >= 2, sealed);

    const windowsBefore = await M(({ BaseWindow }) => BaseWindow.getAllWindows().length);
    await M(async ({ webContents }) => {
      const rail = webContents.getAllWebContents().find((w) => (w.getURL() || "").includes("/renderer/chrome.html"));
      if (rail) await rail.executeJavaScript("window.open('https://example.org/popped','_blank'); true").catch(() => {});
    });
    await wait(1500);
    const windowsAfter = await M(({ BaseWindow }) => BaseWindow.getAllWindows().length);
    ok("window.open from the rail spawns no native window",
      windowsAfter === windowsBefore, { before: windowsBefore, after: windowsAfter });
    st = await roam("state");
    const popped = st.tabs.find((t) => /example\.org\/popped/.test(t.url));
    ok("it lands in The Wilds instead", !!popped, st.tabs.map((t) => t.url));
    // Put the tab state back, so the assertions below still describe the
    // browser they were written against.
    if (popped) await roam("close", { tabId: popped.id });

    // ---- it gets out of the way of the other apps ------------------------
    // The browser is a bar plus N tab views floating in the same window as
    // every app, and it is NOT in `views` — so activate()'s zeroing loop does
    // not touch it. roamLayout() stands in for that, and a future app-switch
    // path that skips layout() would leave the browser painted over whatever
    // you switched to. This is the assertion that would catch it.
    await M(() => globalThis.__activate("launcher"));
    await wait(600);
    ov = await overlay();
    ok("switching to another app hides the browser", ov.visible === false && ov.tabs > 0, ov);
    await M(() => globalThis.__activate("roam"));
    await wait(600);
    ov = await overlay();
    ok("and coming back shows it again, with its tabs intact", ov.visible === true && ov.tabs > 0, ov);

    // ---- an agent's tab keeps its mark when its jar changes --------------
    // Rebuilding the view is HOW a jar change works; "an agent opened this" is
    // a fact about the tab. Dropping it on the rebuild would quietly remove the
    // one visible sign that something other than the person is driving.
    // Started, not awaited, across the driver: playwright cannot hold a
    // main-process promise that takes seconds to settle — it collects it and
    // reports "Resulting promise was garbage collected". Kick it off and poll
    // the state, which is what the rest of this suite does anyway.
    await M(() => { globalThis.__testables.wildsControl("open", { url: "https://example.com" }); return true; });
    await until(async () => (await roam("state")).tabs.some((t) => t.agent), 30000);
    st = await roam("state");
    const made = { ok: true, tab: (st.tabs.find((t) => t.agent) || {}).id };
    if (!made.tab) {
      skip("an agent's tab stays marked when its jar changes", "could not open an agent tab");
    } else {
      const at = st.tabs.find((t) => t.id === made.tab);
      ok("an agent's tab is marked as one", !!at && at.agent === true && at.persona === "agent", at);
      const moved = await M((_e, { t }) => globalThis.__testables.roamSetPersona(t, "curio"), { t: made.tab });
      await wait(800);
      st = await roam("state");
      // A jar change rebuilds the tab, so it comes back under a new id in the
      // same slot — find it by jar rather than by id.
      const now = st.tabs.find((t) => t.persona === "curio" && t.agent);
      ok("and it is still marked after the jar changes", !!now, { moved, jars: st.tabs.map((t) => `${t.persona}:${t.agent}`) });
      if (now) await roam("close", { tabId: now.id });
    }

    // ---- the omnibox, end to end -----------------------------------------
    if (!net) {
      skip("loading a live page", "offline");
      skip("prose becomes a search", "offline");
      skip("the address bar navigates in place", "offline");
      skip("history records the visit", "offline");
      skip("links out of an app land here", "offline");
      skip("a page can be clipped from the bar", "offline");
      skip("hibernating restores the session", "offline");
    } else {
      const r = await roam("open", { input: "example.com" });
      ok("a bare host is an address, not a search", r.ok && !r.searched, r);
      await until(async () => { st = await roam("state"); return !st.loading && /example\.com/.test(st.url); }, 30000);
      ok("loading a live page", /^https:\/\/example\.com/.test(st.url) && !!st.title, { url: st.url, title: st.title });
      ok("the blank tab was reused rather than stranded", st.tabs.length === 1, st.tabs.length);
      ok("history records the visit", (st.recent || []).some((h) => /example\.com/.test(h.url)), st.recent);

      await roam("open", { input: "a phrase nobody would type as a url", newTab: true });
      await until(async () => { st = await roam("state"); return st.tabs.length === 2 && !st.loading; }, 30000);
      ok("prose becomes a search, in its own tab", /[?&]q=/.test(st.url), st.url);

      // The address bar navigates the tab you are looking at. Anything else
      // makes every typed address spawn a tab.
      const first = st.tabs[0].id;
      await roam("select", { tabId: first });
      await roam("open", { input: "example.org", here: true });
      await until(async () => { st = await roam("state"); return !st.loading && /example\.org/.test(st.url); }, 30000);
      ok("the address bar navigates in place", st.tabs.length === 2 && /example\.org/.test(st.url),
        { tabs: st.tabs.length, url: st.url });
      ok("and leaves history behind it", st.canBack === true, st.canBack);

      // The rail's own back button has to drive the front tab.
      await M(() => globalThis.__nav("roam", "back"));
      await until(async () => { st = await roam("state"); return /example\.com/.test(st.url); }, 15000);
      ok("the rail's back button drives the front tab", st.canForward === true, { url: st.url, fwd: st.canForward });

      // Switching jar rebuilds the tab at the same address, in the same slot.
      const pr = await roam("persona", { name: "curio" });
      await until(async () => { st = await roam("state"); return st.persona === "curio" && !st.loading; }, 20000);
      ok("switching jar succeeds", pr.ok === true, pr);
      ok("same address, new jar, same slot",
        /example\.com/.test(st.url) && st.tabs[0].persona === "curio" && st.tabs.length === 2,
        { url: st.url, jars: st.tabs.map((t) => t.persona) });

      const pinsBefore = (await roam("state")).pins.length;
      await roam("pin", {});
      st = await roam("state");
      ok("the current page can be pinned",
        st.pinned === true && st.pins.length === pinsBefore + 1, { before: pinsBefore, after: st.pins.length });
      // The gesture that matters: clicking a pin that names a jar must land in
      // that jar. This is the whole reason the Boards entries could become
      // pins at all.
      const pinned = st.pins.find((p) => p.persona === "curio");
      if (pinned) {
        await roam("open", { input: pinned.url, persona: pinned.persona });
        await until(async () => { st = await roam("state"); return st.persona === "curio"; }, 25000);
        ok("clicking a pin opens it in the jar the pin names", st.persona === "curio", st.persona);
      } else {
        skip("clicking a pin opens it in the jar the pin names", "no jar-bearing pin declared");
      }
      st = await roam("state");
      ok("and the pin records the jar the page was actually browsed in",
        st.pins[st.pins.length - 1].persona === st.persona,
        { pin: st.pins[st.pins.length - 1].persona, tab: st.persona });

      // A tab you close is a tab you can get back. Counted RELATIVE to what is
      // open: absolute counts turn every later assertion into a tripwire for
      // whatever gets added above it.
      const beforeClose = st.tabs.length;
      const second = st.tabs[1].id;
      await roam("close", { tabId: second });
      st = await roam("state");
      ok("closing a tab removes it",
        st.tabs.length === beforeClose - 1 && !st.tabs.some((t) => t.id === second),
        { before: beforeClose, after: st.tabs.length });
      await roam("reopen");
      await until(async () => { st = await roam("state"); return st.tabs.length === beforeClose; }, 15000);
      ok("and Ctrl+Shift+T brings it back", st.tabs.length === beforeClose, st.tabs.length);

      // THE point of the whole feature: a link leaving a hosted app must land
      // in here rather than in the system browser.
      const before = (await roam("state")).tabs.length;
      await M(() => globalThis.__testables.openWeb("https://example.org/from-an-app"));
      await until(async () => {
        st = await roam("state");
        return st.tabs.length === before + 1 && st.tabs.some((t) => /example\.org\/from-an-app/.test(t.url));
      }, 30000);
      ok("links out of an app land here, not in the system browser",
        st.tabs.some((t) => /example\.org\/from-an-app/.test(t.url)), st.tabs.map((t) => t.url));

      const clipJar = (await roam("state")).persona;
      const clipped = await roam("clip", { what: "page" });
      await wait(600);
      let filed = null;
      try {
        const idx = fs.readFileSync(path.join(dataDir, "trove", "index.jsonl"), "utf8")
          .trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
        filed = idx[idx.length - 1];
      } catch {}
      ok("a page can be clipped from the bar", clipped.ok === true, clipped);
      // The jar is whichever one that tab was browsing in — the point is that
      // the archive records it at all, so a clip can always be traced back to
      // the identity that was logged in when you took it.
      ok("and it lands in the Trove with its address and its jar",
        filed && /example\.org/.test(filed.src?.url || "") && filed.persona === clipJar,
        { filed: filed && { url: filed.src?.url, persona: filed.persona }, tabJar: clipJar });
      // The archive records the gesture that chose each clip; a button in the
      // browser's bar is not a right-click.
      ok("filed under the gesture that actually made it", filed && filed.agent === "wilds-bar", filed?.agent);

      // Hibernate the whole browser and come back to the same pages. This one
      // caught a real bug: the debounced session write fired after teardown
      // and replaced the saved tabs with nothing.
      const urls = st.tabs.filter((t) => !t.blank).map((t) => t.url);
      await M(() => globalThis.__hibernate("roam"));
      await wait(1000);
      await M(() => globalThis.__activate("roam"));
      await until(async () => { st = await roam("state"); return st.tabs.length >= urls.length; }, 25000);
      // Compare canonically: a server may add a trailing slash on the way back
      // (pinterest.com -> pinterest.com/), and a session that redirects to the
      // same place has restored the same page. Exact string equality here
      // tests the remote server's URL style, not the browser.
      const canon = (u) => String(u).replace(/\/+$/, "");
      ok("hibernating and reopening restores the session",
        urls.every((u) => st.tabs.some((t) => canon(t.url) === canon(u))),
        { wanted: urls, got: st.tabs.map((t) => t.url) });
    }
  } catch (err) {
    failed += 1;
    console.log(`  FAIL (harness) ${String((err && err.message) || err)}`);
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n  ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
  process.exit(failed ? 1 : 0);
})();
