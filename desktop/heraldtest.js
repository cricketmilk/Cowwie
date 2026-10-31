// The herald (Auri's cards) against the real shell.
//
//     cd shell
//     npm i --no-save playwright     (driver only — electron stays the sole dep)
//     node heraldtest.js
//
// lib/herald-test.js holds the queue's rules on a fake clock. This holds the
// parts only a real window can: that the view is no bigger than what it draws
// (a transparent view still eats clicks), that it hides when empty, that the
// keyboard really reaches her and really comes back, and that a card's
// buttons reach their handlers.
//
// Runs beside a live shell: its own --user-data-dir, --data-dir and
// --sync-port, and FORGE_PORT pointed at nothing. That last one is not
// optional — the herald polls Kenoma for approvals and this test presses
// Allow, and pointed at the real Kenoma it could approve a real command.

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

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, every = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await fn()) return true; } catch {}
    await wait(every);
  }
  return false;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "herald-test-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "herald-data-"));
  const syncPort = 18800 + Math.floor(Math.random() * 400);
  // The bridge's bearer, handed to the shell through its environment so the
  // test never needs (or writes) a secrets.json.
  const TOKEN = process.env.MUT_SYNC_TOKEN || "herald-test-token-" + Date.now().toString(36);
  const app = await _electron.launch({
    args: [path.join(__dirname, "main.js"), `--user-data-dir=${profile}`, `--data-dir=${dataDir}`, `--sync-port=${syncPort}`, "--no-pull", "--no-egress"],
    cwd: __dirname,
    env: { ...process.env, FORGE_PORT: "9", MUT_SYNC_TOKEN: TOKEN },
  });
  const M = (fn, a) => app.evaluate(fn, a);
  const geo = () => M(() => globalThis.__testables.heraldGeometry());

  try {
    await until(() => M(() => !!globalThis.__testables), 30000);
    let page = null;
    await until(() => { page = app.windows().find((p) => p.url().endsWith("renderer/herald/index.html")); return !!page; }, 20000);
    ok("the herald's page loads in its own view", !!page);
    await page.waitForFunction(() => window.AURI_FACES && Object.keys(window.AURI_FACES).length >= 26, null, { timeout: 10000 });
    ok("with every one of her faces", await page.evaluate(() => Object.keys(window.AURI_FACES).length) >= 26);

    // Nothing reaches a real Kenoma from here: every handler that could
    // answer an approval is replaced with one that only writes it down.
    await M(() => {
      const h = globalThis.__testables.herald;
      globalThis.__said = [];
      const note = (what) => async (c, p) => { globalThis.__said.push({ what, approval: c.meta && c.meta.approval, p }); return { ok: true }; };
      h.handlers = { ...h.handlers, allow: note("allow"), deny: note("deny"), answer: note("answer"), choose: note("choose"),
        always: note("always"), open: async (c) => ({ ok: true, keep: !!(c.meta && c.meta.approval) }) };
      return true;
    });
    // Quiet is the clock and the window's focus (main.js's 1 s tick sets it
    // from quiet hours, or from the shell not being the window in front). In
    // quiet she holds reports for a digest and her pip says QUIET, so this
    // suite passed at noon and failed past midnight for the same code. Pinned
    // off; the quiet rules have their own tests in lib/herald-test.js.
    await M(() => { const m = globalThis.__testables.mut; m.setQuiet = () => {}; m.quiet = false; return true; });

    // She is the only creature on the screen, so with nothing to say she
    // RESTS in the corner: her face, in a patch of the app no bigger than it.
    // "Nothing to see" was the bug: there was no Auri anywhere until
    // something arrived.
    const resting = (g) => g.visible === true && g.w > 0 && g.bounds && g.bounds.width <= 130 && g.bounds.height <= 120;
    await until(async () => resting(await geo()), 6000);
    let g = await geo();
    ok("with nothing to say, she rests in the corner", resting(g), g);
    const winB = await M(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getContentBounds());
    ok("in the top-right, flush with the window's edge", g.bounds.x + g.bounds.width === winB.width, { g, winB });
    ok("as her face alone, on a button", await page.evaluate(() => {
      const p = document.getElementById("pip");
      return !p.hidden && p.classList.contains("rest") && !!p.querySelector(".face .body");
    }));
    await page.click("#pip");
    await page.waitForSelector("#drawer:not([hidden])", { timeout: 3000 }).catch(() => {});
    ok("clicking her opens her drawer", await page.evaluate(() => !document.getElementById("drawer").hidden));
    await until(async () => (await geo()).bounds.width > 300, 3000);
    ok("and the view widens to hold it", (await geo()).bounds.width > 300, await geo());
    await page.click("#pip");
    await until(async () => resting(await geo()), 4000);
    ok("clicking her again puts it away, and she rests", resting(await geo()), await geo());

    // ---- a card that needs you ---------------------------------------------
    await M(() => globalThis.__testables.herald.notify({
      kind: "approval", band: 3, key: "test:ap1", who: "Kenoma", chan: "Forge · test",
      body: "Wants to run a destructive command.", cmd: "rm -rf build/", acts: ["allow", "deny", "open"],
      meta: { approval: "ap-test-1", session: "test" },
    }, { internal: true }));
    await page.waitForSelector(".card.front.band3", { timeout: 5000 });
    ok("it arrives as the front card", true);
    ok("wearing the needs-you tag", (await page.textContent(".card.front .tag")).trim() === "NEEDS YOU");
    ok("and the command it wants to run", /rm -rf build/.test(await page.textContent(".card.front .cmd")));
    await until(async () => (await geo()).visible, 3000);
    g = await geo();
    const win = await M(({ BaseWindow }) => BaseWindow.getAllWindows()[0].getContentBounds());
    ok("the view shows", g.visible === true, g);
    ok("pinned to the window's right edge", g.bounds.x + g.bounds.width === win.width, { g, win });
    ok("the full column wide again, for the card", g.w === 0 && g.bounds.width > 300, g);
    ok("and no taller than what it draws", g.bounds.height > 120 && g.bounds.height < 420, g.bounds);
    ok("so most of the app under it stays clickable", g.bounds.height * g.bounds.width < win.width * win.height * 0.25, { g, win });
    const img = await page.evaluate(() => {
      const b = document.querySelector(".card.front .face .body");
      return b ? { done: b.complete, w: b.naturalWidth, name: b.closest(".face").dataset.name } : null;
    });
    ok("her face is drawn, and it is the urgent one", img && img.done && img.w > 0 && img.name === "urgent", img);

    // ---- the keyboard reaches her, and comes back ---------------------------
    await M(() => globalThis.__testables.heraldSummon());
    await until(async () => (await geo()).focused, 3000);
    ok("Ctrl+` gives her the keyboard", (await geo()).focused);
    await page.keyboard.press("a");
    await until(() => M(() => globalThis.__said.length > 0), 3000);
    const said = await M(() => globalThis.__said[0]);
    ok("A answers the approval it belongs to", said && said.what === "allow" && said.approval === "ap-test-1", said);
    await page.waitForFunction(() => /ALLOWED/.test(document.querySelector(".card .tag")?.textContent || ""), null, { timeout: 3000 }).catch(() => {});
    ok("and the card says so before it goes", /ALLOWED/.test(await page.evaluate(() => document.querySelector(".card .tag")?.textContent || "")));
    await until(async () => resting(await geo()), 6000);
    g = await geo();
    ok("then she is empty, and back to resting in her corner", resting(g), g);
    await until(async () => !(await geo()).focused, 3000);
    ok("and the keyboard went back to the app", !(await geo()).focused);

    // ---- typing an answer ---------------------------------------------------
    await M(() => globalThis.__testables.herald.notify({
      kind: "question", band: 3, who: "Kenoma", body: "Ship now, or wait for the audit?", choices: ["Ship it", "Wait"],
      acts: ["answer", "open", "dismiss"], meta: { approval: "q-test-1", session: "test" },
    }, { internal: true }));
    await page.waitForSelector(".card.front.k-question", { timeout: 5000 });
    ok("a question shows its choices", (await page.$$eval(".card.front .choices button", (b) => b.length)) === 2);
    await M(() => { globalThis.__said = []; globalThis.__testables.heraldSummon(); });
    await until(async () => (await geo()).focused, 3000);
    await page.keyboard.press("r");
    await page.keyboard.type("wait for the audit, it's close");
    await page.keyboard.press("Enter");
    await until(() => M(() => globalThis.__said.length > 0), 3000);
    const ans = await M(() => globalThis.__said[0]);
    ok("R, a sentence and Enter answer it in words", ans && ans.what === "answer" && ans.p.text === "wait for the audit, it's close", ans);
    ok("and no letter of it fired a shortcut", (await M(() => globalThis.__said.length)) === 1);
    await until(async () => resting(await geo()), 6000);

    // ---- a task, and its landing --------------------------------------------
    await M(() => globalThis.__testables.herald.task({ id: "t1", kind: "art", who: "Glamoire", title: "a portrait", step: "underpainting" }));
    await page.waitForSelector(".strip.k-art", { timeout: 5000 });
    ok("work in progress is a strip with her at the easel",
      (await page.evaluate(() => document.querySelector(".strip .face")?.dataset.name)) === "art-working");
    ok("whose loose marks are drawn on their own, to move",
      (await page.$$eval(".strip .face .fx", (f) => f.length)) > 0);
    ok("and whose bar glints while it has no number", await page.evaluate(() => document.querySelector(".strip .bar").classList.contains("idle")));
    await M(() => globalThis.__testables.herald.task({ id: "t1", progress: 0.5, step: "glazing" }));
    await page.waitForFunction(() => document.querySelector(".strip .step")?.textContent === "glazing", null, { timeout: 3000 });
    ok("progress and the step follow along", await page.evaluate(() => document.querySelector(".strip .bar i").style.width === "50%"));
    await M(() => globalThis.__testables.herald.task({ id: "t1", state: "done", summary: "Painted, 4 passes." }));
    await page.waitForSelector(".card.k-task-done", { timeout: 5000 });
    ok("landing hands over to a completion card", true);
    ok("that holds up the finished painting",
      (await page.evaluate(() => document.querySelector(".card.k-task-done .face")?.dataset.name)) === "art-done");
    ok("and arrives gently, not with a slam", await page.evaluate(() => document.querySelector(".card.k-task-done").classList.contains("land")));
    await until(() => page.evaluate(() => !document.querySelector(".strip")), 4000);
    ok("the strip folds away", await page.evaluate(() => !document.querySelector(".strip")));
    await M(() => { const h = globalThis.__testables.herald; for (const c of h.cards) h._remove(c); h._changed(); });

    // ---- pile-up ---------------------------------------------------------------
    await M(() => { for (let i = 0; i < 5; i++) globalThis.__testables.herald.notify({ kind: "message", band: 2, who: "goblin house", chan: "Discord", body: "ping " + i, key: "discord:art" }); });
    await page.waitForSelector(".card.pile", { timeout: 5000 });
    ok("five pings are one pile-up card", (await page.$$eval(".card:not(.out)", (c) => c.length)) === 1
      && (await page.textContent(".card.pile .count")).includes("5"));
    ok("and she is overwhelmed", (await page.evaluate(() => document.querySelector(".card.pile .face")?.dataset.name)) === "overwhelmed");
    await M(() => { const h = globalThis.__testables.herald; for (const c of h.cards) h._remove(c); h._changed(); });

    // ---- Müt's lines are her cards ------------------------------------------------
    // His mind (lib/companion.js) still runs underneath; what he would have
    // said aloud (priority 2+) arrives as one of her cards, his chatter does not.
    await M(() => { const t = globalThis.__testables; t.mut.push({ key: "memory", topic: "memory", priority: 2, state: "sick", ttlMs: 60000 }); t.mut.push({ key: "fed", topic: "clip.added", priority: 1, state: "happy" }); return true; });
    await page.waitForSelector(".card.k-look .face[data-name='overwhelmed']", { timeout: 5000 }).catch(() => {});
    const fromMut = await M(() => globalThis.__testables.herald.state().cards.filter((c) => c.who === "Ifreglen"));
    ok("what he would have said aloud arrives as her card, with the face for it", fromMut.length === 1 && fromMut[0].face === "overwhelmed" && fromMut[0].body.length > 0, fromMut);
    ok("and his chatter does not", !fromMut.some((c) => /clip/.test(c.chan)));
    await M(() => { const h = globalThis.__testables.herald; for (const c of h.cards) h._remove(c); h._changed(); });

    // ---- a brief, and a note from the phone -------------------------------------
    const filed = await M(() => globalThis.__testables.briefFile({ source: "lookout", title: "Board moved", body: "a rule changed", url: "https://example.org/x" }));
    await page.waitForSelector(".card.front.band2", { timeout: 5000 }).catch(() => {});
    const bc = await M(() => globalThis.__testables.herald.state().cards.find((c) => c.who === "lookout"));
    ok("a brief is a band-2 card from its app, open/dismiss only", filed && filed.ok && bc && bc.band === 2 && bc.acts.join() === "open,dismiss" && bc.kind !== "approval", { filed, bc });
    ok("drawn as a message with the brief's words", /Board moved/.test(await page.textContent(".card.front")));
    const quiet = await M(() => globalThis.__testables.briefFile({ source: "credentials", title: "renewed", level: "quiet" }));
    ok("a quiet brief is filed and raises no card", quiet && quiet.ok && !(await M(() => globalThis.__testables.herald.state().cards.some((c) => c.who === "credentials"))), quiet);
    const bad = await M(() => globalThis.__testables.briefFile({ source: "lookout" }));
    ok("a brief with no title is refused", bad && bad.error, bad);
    const noted = await M(() => globalThis.__testables.noteFile({ text: "call the pharmacy about the Tuesday starter" }));
    const nc = await M(() => globalThis.__testables.herald.state().cards.find((c) => c.who === "Professional Goat"));
    ok("a note from the phone is a card from Professional Goat", noted && noted.ok && nc && nc.band === 2 && /pharmacy/.test(nc.body), { noted, nc });
    await M(() => { const h = globalThis.__testables.herald; for (const c of h.cards) h._remove(c); h._changed(); });
    await until(async () => resting(await geo()), 6000);

    // ---- the drawer -----------------------------------------------------------------
    await M(() => globalThis.__testables.heraldSummon());
    await page.waitForSelector("#drawer:not([hidden]) #askIn", { timeout: 5000 });
    ok("Ctrl+` with nothing in front opens the drawer at the ask box", await page.evaluate(() => document.activeElement && document.activeElement.id === "askIn"));
    ok("the drawer says where the phone stands", /phone/.test(await page.textContent("#phoneLine")), await page.textContent("#phoneLine"));
    ok("and names Professional Goat, not the old companion", /Professional Goat/.test(await page.textContent("#phoneLine")) && !/Auri on the phone|Müt/.test(await page.textContent("#phoneLine")), await page.textContent("#phoneLine"));
    // The page's own bridge to the verbs (preload-herald.js `verb`), through
    // the one with no outside effect.
    const bridged = await page.evaluate(() => window.roostHerald.verb && window.roostHerald.verb("noop", {}));
    ok("the drawer reaches main through her preload", bridged && bridged.ok === true, bridged);
    const empty = await M(() => globalThis.__testables.heraldVerb("ask", { prompt: "   " }));
    ok("an empty ask is refused, not sent to Kenoma", empty && empty.ok === false, empty);
    const gone = await M(() => globalThis.__testables.heraldVerb("say", {}));
    ok("the retired verbs (say, feed, sync) are gone", gone && gone.ok === false, gone);
    await page.keyboard.press("Escape");
    await M(() => { const h = globalThis.__testables.herald; for (const c of h.cards) h._remove(c); h.waiting = []; h._changed(); });

    // ---- the door for this machine's processes ---------------------------------
    const services = JSON.parse(fs.readFileSync(path.join(dataDir, "services.json"), "utf8"));
    const token = TOKEN;
    const port = services.mutSync && services.mutSync.port;
    if (!port || !token) {
      console.log("  skip the /herald door (no port or token)", { port, token: !!token });
    } else {
      const r = await fetch(`http://127.0.0.1:${port}/herald/notify`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "approval", band: 3, who: "a script", body: "approve me", acts: ["allow", "dismiss"], meta: { approval: "x" } }),
      });
      ok("POST /herald/notify files a card", r.ok, r.status);
      const st = await M(() => globalThis.__testables.herald.state());
      const c = st.cards.find((x) => x.who === "a script");
      ok("a local process can make her loud", c && c.band === 3, c);
      ok("but cannot raise an approval it could never answer", c && c.kind === "look" && !c.acts.includes("allow"), c);
      const unauth = await fetch(`http://127.0.0.1:${port}/herald/notify`, { method: "POST", body: "{}" });
      ok("and the door is shut without the key", unauth.status === 401 || unauth.status === 403, unauth.status);
      // The phone's side of briefs and notes, over the wire.
      const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const b = await (await fetch(`http://127.0.0.1:${port}/briefs`, { method: "POST", headers: H, body: JSON.stringify({ source: "onboarding", title: "Starter waiting on I-9" }) })).json();
      ok("POST /briefs files a brief from this machine", b.ok && b.id, b);
      const got = await (await fetch(`http://127.0.0.1:${port}/briefs`, { headers: H })).json();
      ok("GET /briefs lists it for the phone, unread", got.briefs && got.briefs[0] && got.briefs[0].id === b.id && got.briefs[0].read === false, got.briefs && got.briefs[0]);
      const acked = await (await fetch(`http://127.0.0.1:${port}/briefs/ack`, { method: "POST", headers: H, body: JSON.stringify({ ids: [b.id] }) })).json();
      const after = await (await fetch(`http://127.0.0.1:${port}/briefs`, { headers: H })).json();
      ok("POST /briefs/ack marks it read", acked.acked === 1 && after.briefs.find((x) => x.id === b.id).read === true, { acked, after: after.briefs[0] });
      const n = await (await fetch(`http://127.0.0.1:${port}/notes`, { method: "POST", headers: H, body: JSON.stringify({ text: "remember the badge photo" }) })).json();
      const notes = await (await fetch(`http://127.0.0.1:${port}/notes`, { headers: H })).json();
      ok("POST /notes lands a note, GET /notes reads it back", n.ok && notes.notes && notes.notes[0] && notes.notes[0].text === "remember the badge photo", { n, notes: notes.notes && notes.notes[0] });
      ok("and the note is on screen as a card", await M(() => globalThis.__testables.herald.state().cards.some((c) => c.who === "Professional Goat" && /badge/.test(c.body))));
      ok("notes.jsonl and briefs.jsonl are in the data dir", fs.existsSync(path.join(dataDir, "notes.jsonl")) && fs.existsSync(path.join(dataDir, "briefs.jsonl")));
    }
  } catch (e) {
    failed++;
    console.log("  FAIL (threw)", e && e.stack || e);
  } finally {
    await app.close().catch(() => {});
    for (const d of [profile, dataDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
