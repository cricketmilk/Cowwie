// The coding handoff, against a real shell and a real Brain.
//
//     cd shell
//     npm i --no-save playwright
//     node cartridgetest.js
//
// Two gestures, one per direction:
//
//   out    "Cartridge for <app>" packs the Brain's Context Cartridge and types
//          it into whatever chat box has the cursor. Enter stays the person's.
//   back   "Preview through the Forge…" on a selected reply: parsed, reported
//          per file, and WRITTEN ONLY on a separate press.
//
// The chat itself is never automated, so there is nothing here that a site
// redesign can break. What is tested is the machinery either side of it.
//
// Needs Goblin Brain on :3001. Without it every assertion that touches the
// Forge is skipped rather than failed — the Brain being off is not a bug in
// the shell, and the shell has to say so legibly, which IS tested.

const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");

let _electron;
try { ({ _electron } = require("playwright")); }
catch { console.error("playwright is not installed here. Run: npm i --no-save playwright"); process.exit(2); }

let passed = 0, failed = 0, skipped = 0;
const ok = (n, c, x) => { c ? passed++ : failed++; console.log(`  ${c ? "ok  " : "FAIL"} ${n}${c || x === undefined ? "" : "  -> " + JSON.stringify(x).slice(0, 260)}`); };
const skip = (n, why) => { skipped++; console.log(`  skip ${n}  (${why})`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

async function brainUp() {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 4000);
    const r = await fetch("http://localhost:3001/", { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

// A chat window in miniature: a contenteditable box that keeps what you type,
// so the outbound leg can be checked without touching anyone's account.
const CHAT = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Chat</title></head>
<body><main><h1>Chat</h1><div id="box" contenteditable="true"></div></main></body></html>`;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "cart-p-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cart-d-"));
  const port = await freePort();
  const brain = await brainUp();

  const chatPath = path.join(dataDir, "chat.html");
  fs.writeFileSync(chatPath, CHAT, "utf8");
  const chatUrl = "file:///" + chatPath.replace(/\\/g, "/");

  const app = await _electron.launch({
    // --no-pull: a test shell must not follow the hoard (see roamtest.js).
    args: [path.join(__dirname, "main.js"), `--user-data-dir=${profile}`, `--data-dir=${dataDir}`, `--sync-port=${port}`, "--no-pull"],
    cwd: __dirname,
  });
  const M = (fn, a) => app.evaluate(fn, a);

  try {
    await (async () => { for (let i = 0; i < 80; i++) { if (await M(() => !!globalThis.__testables)) return; await wait(250); } })();
    await M(({ ipcMain }) => {
      const h = (n) => ipcMain._invokeHandlers.get(n);
      globalThis.__cart = (a, p) => h("roost:cartridge")({}, a, p);
      globalThis.__roam = (a, p) => h("roost:roam")({}, a, p);
      globalThis.__activate = (id) => h("roost:activate")({}, id);
      return true;
    });
    const cart = (a, p = {}) => M((_e, x) => globalThis.__cart(x.a, x.p), { a, p });
    const roam = (a, p = {}) => M((_e, x) => globalThis.__roam(x.a, x.p), { a, p });

    // ---- the sniffer decides whether the verb is even offered -------------
    // A context menu that offers "Preview through the Forge" on "thanks, that
    // worked!" is a menu you stop reading.
    // In-process: it is a pure function, and evaluate() has no require.
    const sniff = (() => {
      const { couldBeChangeSet } = require("./lib/cartridge.js");
      return {
        search: couldBeChangeSet("<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE"),
        fenced: couldBeChangeSet("Sure:\n```js\nconst a = 2;\n```"),
        prose: couldBeChangeSet("Sure! Let me know how that goes for you."),
        tiny: couldBeChangeSet("ok"),
      };
    })();
    ok("a change-set is recognised", sniff.search && sniff.fenced, sniff);
    ok("ordinary chat prose is not", !sniff.prose && !sniff.tiny, sniff);

    if (!brain) {
      // The Brain being off is not a bug in the shell — but saying nothing
      // about it would be.
      const r = await cart("apps");
      ok("with the Brain off, the shell says so in a sentence",
        r && r.ok === false && /not answering|Goblin Brain/i.test(r.error || ""), r);
      skip("packing a cartridge", "Goblin Brain is not running on :3001");
      skip("typing it into the chat box", "Goblin Brain is not running on :3001");
      skip("previewing a reply", "Goblin Brain is not running on :3001");
    } else {
      // ---- outbound --------------------------------------------------------
      const list = await cart("apps");
      ok("the Forge's registered codebases are readable", list.ok === true && Array.isArray(list.apps), list.error || (list.apps || []).length);
      const target = (list.apps || []).find((a) => !a.blocked);
      if (!target) {
        skip("packing a cartridge", "no unblocked app registered with the Forge");
        skip("typing it into the chat box", "no unblocked app registered with the Forge");
      } else {
        await M(() => globalThis.__activate("roam"));
        await wait(1500);
        await M((_e, { url }) => globalThis.__roam("open", { input: url, here: true }), { url: chatUrl });
        await wait(2500);

        // Put the cursor where a person would: in the chat box.
        await roam("state");
        const st = await roam("state");
        await M(async ({ webContents }) => {
          const w = webContents.getAllWebContents().find((x) => (x.getURL() || "").includes("chat.html"));
          if (w) await w.executeJavaScript("document.getElementById('box').focus(); true");
        });
        void st;

        const sent = await cart("to-chat", { appIds: [target.id], goal: "a test cartridge" });
        ok("a cartridge is packed and typed into the chat box",
          sent.ok === true && sent.chars > 200, sent.error || sent);

        // It has to actually be IN the box — the whole gesture is worthless if
        // the text went somewhere else.
        const inBox = await M(async ({ webContents }) => {
          const w = webContents.getAllWebContents().find((x) => (x.getURL() || "").includes("chat.html"));
          return w ? await w.executeJavaScript("document.getElementById('box').textContent.length") : 0;
        });
        ok("and it really landed in the box, not somewhere else", inBox > 200, inBox);

        // Enter is NOT pressed. The moment the shell sends for you, this stops
        // being "you drive and the shell catches".
        const stillThere = await M(async ({ webContents }) => {
          const w = webContents.getAllWebContents().find((x) => (x.getURL() || "").includes("chat.html"));
          return w ? await w.executeJavaScript("document.getElementById('box').textContent.length") : 0;
        });
        ok("and nothing was sent — Enter stays the person's", stillThere === inBox, { before: inBox, after: stillThere });
      }

      // ---- the return leg --------------------------------------------------
      // A reply that cannot possibly match anything still has to come back as a
      // readable answer rather than an exception.
      // Through the same door the context menu uses, not a private seam.
      const bogus = "<<<<<<< SEARCH\nthis text is in no file anywhere\n=======\nnor is this\n>>>>>>> REPLACE";
      await cart("preview", { text: bogus });
      await wait(1500);
      const last = await cart("last");
      ok("a reply is carried back and previewed", last.ok === true && last.has === true, last);
      ok("and nothing was written by previewing it",
        last.result && !last.result.applied, last.result ? Object.keys(last.result) : null);
    }

    // ---- the overlay rule ------------------------------------------------
    // Every sheet in the rail has to be in BOTH bookkeepers, or the view
    // collapses under it and the sheet is invisible rather than broken.
    // The rail's script is in renderer/chrome/*.js now; read it with the page.
    const rdir = path.join(__dirname, "renderer");
    const html = [fs.readFileSync(path.join(rdir, "chrome.html"), "utf8"),
      ...fs.readdirSync(path.join(rdir, "chrome")).filter((n) => n.endsWith(".js")).map((n) => fs.readFileSync(path.join(rdir, "chrome", n), "utf8"))].join("\n");
    const ids = [...html.matchAll(/<div class="surface" id="([a-zA-Z]+)"/g)].map((m) => m[1]);
    const hide = html.slice(html.indexOf("function hideSurfaces"), html.indexOf("function hideSurfaces") + 600);
    const sync = html.slice(html.indexOf("function syncOverlay"), html.indexOf("function syncOverlay") + 600);
    const gaps = ids.filter((id) => !hide.includes(`"${id}"`) || !sync.includes(`"${id}"`));
    ok("every rail surface is in hideSurfaces and syncOverlay", gaps.length === 0, gaps);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL (harness) ${String((err && err.stack) || err)}`);
  } finally {
    await app.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n  ${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
  process.exit(failed ? 1 : 0);
})();
