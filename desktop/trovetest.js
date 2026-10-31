// Compiling the venture plan: exercises the REAL Trove page in a real Electron
// renderer, with a stub window.roost whose fs/bus land in a throwaway temp dir
// — never the shell's real archive, which nothing automated has any business
// appending to. The stub exposes exactly the door preload.js would: fs and
// bus, no clip verb (apps.config.json's $comment is load-bearing — the page
// must file its lines through its own doors, and this test proves it can).
//
//   npm run test:trove
//
// No Playwright — the same driving style as cliptest.js: executeJavaScript on
// a hidden BrowserWindow, polling for the effects of each click.
const { app, BrowserWindow, ipcMain } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "trove-compile-"));

// The stub bridge. Key for key what preload.js would expose to the trove app
// (fs + bus, no clip), with the fs rooted at TMP by the handlers below.
const PRELOAD = path.join(TMP, "stub-preload.js");
fs.writeFileSync(PRELOAD, `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("roost", {
  app: "trove",
  capabilities: ["fs", "store", "bus", "apps"],
  fs: {
    root: () => Promise.resolve({ root: "." }),
    list: () => Promise.resolve({ entries: [] }),
    read: (p, encoding) => ipcRenderer.invoke("roost:test-read", { p, encoding }),
    write: (p, data) => ipcRenderer.invoke("roost:test-write", { p, data }),
    append: (p, data) => ipcRenderer.invoke("roost:test-append", { p, data }),
    stat: () => Promise.resolve({}),
    remove: () => Promise.resolve({}),
  },
  bus: {
    publish: (topic, payload) => ipcRenderer.invoke("roost:test-publish", { topic, payload }),
    subscribe: () => () => {},
  },
});
`, "utf8");

// The fs the stub serves — same shapes ScopedFs returns, rooted at TMP.
const inside = (p) => {
  const abs = path.resolve(TMP, String(p || "").replace(/^[/\\]+/, ""));
  if (abs !== TMP && !abs.startsWith(TMP + path.sep)) throw new Error("outside the stub root");
  return abs;
};
const published = [];
ipcMain.handle("roost:test-read", async (_e, { p }) => {
  try { return { data: await fsp.readFile(inside(p), "utf8") }; }
  catch { return { error: "not found" }; }
});
ipcMain.handle("roost:test-write", async (_e, { p, data }) => {
  const abs = inside(p);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, String(data), "utf8");
  return { ok: true, bytes: Buffer.byteLength(String(data)) };
});
ipcMain.handle("roost:test-append", async (_e, { p, data }) => {
  const abs = inside(p);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.appendFile(abs, String(data), "utf8");
  return { ok: true };
});
ipcMain.handle("roost:test-publish", (_e, { topic, payload }) => {
  published.push({ topic, payload });
  return { ok: true };
});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1400, height: 900,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  await win.loadFile(path.join(__dirname, "renderer", "trove", "index.html"));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  // ---- the plan is a view first: venture renders, compile offers only inside ----
  ok("venture tab renders its cards", await js(`
    document.getElementById("tab-venture").click(),
    document.querySelectorAll("#grid .vcard").length >= 8`));
  ok("compile button is offered on the venture tab", await js(`
    document.getElementById("vtools").style.display !== "none"
    && !!document.getElementById("vcompile")`));
  ok("compile stays hidden on the clips tab", await js(`
    document.getElementById("tab-clips").click(),
    document.getElementById("vtools").style.display === "none"`));

  // ---- a routing lead, started through the page, should catch the plan ----
  await js(`document.getElementById("tab-leads").click()`);
  await js(`document.getElementById("leadname").value = "the compiled plan"`);
  await js(`document.getElementById("leadgo").click()`);
  ok("lead started and routing", await until(async () =>
    (await js(`document.querySelectorAll(".leadcard.on").length`)) === 1));

  // ---- compile, through the page's own doors ----
  await js(`document.getElementById("tab-venture").click()`);
  await js(`document.getElementById("vcompile").click()`);
  const IDX = path.join(TMP, "index.jsonl");
  ok("one index line appended", await until(async () => {
    try { return fs.readFileSync(IDX, "utf8").split("\n").filter(Boolean).length === 1; }
    catch { return false; }
  }));
  const line = JSON.parse(fs.readFileSync(IDX, "utf8").trim());
  ok("the line is the shape saveClip writes", [
    "v", "id", "t", "at", "kind", "sha256", "bytes", "mime", "ext",
    "object", "thumb", "src", "app", "persona", "text", "note", "tags",
    "agent", "fanout",
  ].every((k) => k in line), Object.keys(line).sort());
  ok("kind file, agent trove, app trove", line.kind === "file" && line.agent === "trove" && line.app === "trove", line);
  ok("md mime and extension", line.mime === "text/markdown" && line.ext === ".md", line);
  // The compile is async — settle before asserting on it.
  ok("the tab switches back to clips after compiling", await until(async () =>
    (await js(`document.getElementById("tab-clips").classList.contains("on")`))));

  // ---- the object is content-addressed and honest ----
  const obj = path.join(TMP, line.object);
  ok("object stored under objects/<aa>/", /^objects[/\\][0-9a-f]{2}[/\\][0-9a-f]{64}\.md$/.test(line.object), line.object);
  const md = fs.readFileSync(obj, "utf8");
  ok("index sha256 matches the stored bytes",
    crypto.createHash("sha256").update(md).digest("hex") === line.sha256);
  ok("byte count matches", line.bytes === Buffer.byteLength(md), { bytes: line.bytes, was: Buffer.byteLength(md) });
  ok("markdown carries the thesis", md.includes("# The venture plan") && md.includes("## Community-owned internet"), md.slice(0, 80));
  ok("markdown carries the honest risks and the sequence", md.includes("## Honest risks") && md.includes("## Sequence"));
  ok("checkboxes ride as tasks", md.includes("- [ ] Port probe") || md.includes("- [x] Port probe"), null);
  ok("bold survives as markdown", /\*\*Ifreglen shell\*\*|## What the estate already has/.test(md));

  // ---- the routing lead caught it, through the same file the page writes ----
  const LEADS = path.join(TMP, "leads.jsonl");
  const leadLines = fs.readFileSync(LEADS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  ok("lead lines: create, activate, file", ["lead", "lead-active", "filed"].every((k) => leadLines.some((l) => l.kind === k)), leadLines.map((l) => l.kind));
  const filed = leadLines.filter((l) => l.kind === "filed");
  ok("the compiled plan was filed into the lead", filed.length === 1 && filed[0].ref === line.id, filed);

  // ---- the bus said so ----
  ok("clip.added published", await until(async () =>
    published.some((p) => p.topic === "clip.added" && p.payload.id === line.id && p.payload.kind === "file")), published);

  // ---- reveal: the file's own door out of the archive ----
  // The stub does not echo bus events back into the page the way the real
  // shell does, so the grid is still empty after setTab — drive the page's
  // own reload button, the same gesture a person has, and the stubbed archive
  // fills the grid.
  await js(`document.getElementById("refresh").click()`);
  ok("the compiled plan renders as a card", await until(async () =>
    (await js(`document.querySelectorAll("#grid .card").length`)) === 1));
  await js(`document.querySelector(".card").click()`);
  ok("detail opens for the compiled clip", await until(async () =>
    !!(await js(`document.getElementById("detail").classList.contains("open")
      && document.querySelector("[data-reveal]")`))));
  await js(`document.querySelector("[data-reveal]").click()`);
  ok("reveal shows the file itself", await until(async () =>
    !!(await js(`document.getElementById("dreveal")`))));
  ok("the file itself is the compiled markdown", (await js(
    `document.querySelector("#dreveal .prov").textContent`)).includes("# The venture plan"));
  await js(`document.querySelector("[data-reveal]").click()`);
  ok("reveal is not duplicated on a second click", (await js(`document.querySelectorAll("#dreveal").length`)) === 1);

  // ---- download: the file out of the archive and onto the disk ----
  // will-download catches the blob the page hands the OS. The Trove app carries
  // no clip cap, so the shell's own handler passes it by and the OS save dialog
  // owns the path; here setSavePath stands in for the dialog, and the landed
  // file must be the compiled plan, byte for byte.
  const dlName = path.join(TMP, "downloaded.md");
  const dlFile = new Promise((res) => {
    win.webContents.session.once("will-download", (_e, item) => {
      const fn = item.getFilename();
      item.setSavePath(dlName);
      item.once("done", () => res(fn));
    });
  });
  await js(`document.querySelector("[data-download]").click()`);
  const fname = String(await dlFile);
  ok("the OS save name is the plan's title as a .md", /\.md$/i.test(fname) && /venture/i.test(fname), fname);
  const dl = fs.readFileSync(dlName, "utf8");
  ok("the downloaded file is the compiled plan, byte for byte", dl === md);

  win.destroy();
  // Windows: the renderer can hold a handle on the stub preload for a beat
  // after destroy. Retry rather than leaving the temp dir behind.
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      break;
    } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);
  app.exit(fail ? 1 : 0);
});