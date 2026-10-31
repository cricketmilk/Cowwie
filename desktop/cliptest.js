// Exercises the real clip pipeline inside Electron: fetch over HTTP, hash,
// content-address, thumbnail, index. Serves its own bytes, so there is no
// network dependency and no reliance on a site staying up.
//
//   npm run test:clip
//
// Unlike test.js this needs no Playwright — it drives lib/clip.js directly in
// an Electron main process, which is the only place electron's `net` and
// `nativeImage` exist.
const { app } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SHELL = __dirname;
const clipper = require(path.join(SHELL, "lib", "clip.js"));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); }
};

app.whenReady().then(async () => {
  // Its own PNG, built from a raw bitmap so the test depends on nothing on
  // disk and the bytes are guaranteed to be a real, decodable image.
  const W = 400, H = 300;
  const bmp = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    bmp[i * 4 + 0] = (i % W) & 0xff;              // B
    bmp[i * 4 + 1] = Math.floor(i / W) & 0xff;    // G
    bmp[i * 4 + 2] = 0x80;                        // R
    bmp[i * 4 + 3] = 0xff;                        // A
  }
  const png = require("electron").nativeImage
    .createFromBitmap(bmp, { width: W, height: H })
    .toPNG();
  const gif = Buffer.from(
    "R0lGODlhCgAKAIAAAP///wAAACH5BAEAAAAALAAAAAAKAAoAAAIIhI+py+0PYysAOw==", "base64");

  const server = http.createServer((req, res) => {
    if (req.url === "/pic.png") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(png); }
    else if (req.url === "/anim.gif") { res.writeHead(200, { "Content-Type": "image/gif" }); res.end(gif); }
    else if (req.url === "/page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head><title>A Test Page</title>
        <meta property="og:image" content="/pic.png"></head><body>hi</body></html>`);
    } else { res.writeHead(404); res.end("no"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trove-"));
  const trove = new clipper.Trove(root);
  trove.ensure();
  console.log("\ntrove at " + root + "\n");

  // ---- fetch ------------------------------------------------------------
  const got = await clipper.fetchBytes(base + "/pic.png", {});
  ok("the probe image is real", png.length > 500, png.length);
  ok("fetchBytes returns bytes", got.buffer.length === png.length, got.buffer.length);
  ok("fetchBytes reports mime", got.mime === "image/png", got.mime);
  ok("fetchBytes reports status", got.status === 200, got.status);

  // ---- hashing + content addressing -------------------------------------
  const a = trove.writeObject(got.buffer, ".png");
  const b = trove.writeObject(got.buffer, ".png");
  ok("sha256 is stable", a.sha === b.sha);
  ok("same bytes stored once", a.rel === b.rel, [a.rel, b.rel]);
  ok("object landed on disk", fs.existsSync(path.join(root, a.rel)));
  ok("path is content-addressed", a.rel.includes(a.sha.slice(0, 2) + "/" + a.sha), a.rel);
  ok("hash matches a fresh read",
     clipper.sha256(fs.readFileSync(path.join(root, a.rel))) === a.sha);

  // ---- thumbnails -------------------------------------------------------
  const thumb = trove.writeThumb(got.buffer, a.sha);
  ok("thumbnail written", !!thumb && fs.existsSync(path.join(root, thumb)), thumb);
  const tsize = thumb ? fs.statSync(path.join(root, thumb)).size : 0;
  ok("thumbnail is under the 8MB ScopedFs read cap", tsize > 0 && tsize < 8 * 1024 * 1024, tsize);
  const tw = require("electron").nativeImage
    .createFromPath(path.join(root, thumb || "x")).getSize().width;
  ok("thumbnail is downscaled to 320px", tw === clipper.THUMB_W, tw);

  // ---- gif keeps its animation ------------------------------------------
  const g = await clipper.fetchBytes(base + "/anim.gif", {});
  const gobj = trove.writeObject(g.buffer, clipper.extFor(g.mime, base + "/anim.gif"));
  const stored = fs.readFileSync(path.join(root, gobj.rel));
  ok("gif object stored byte-identical", stored.equals(gif));
  ok("gif keeps .gif extension", gobj.rel.endsWith(".gif"), gobj.rel);

  // ---- page metadata ----------------------------------------------------
  const meta = await clipper.pageMeta(base + "/page");
  ok("pageMeta reads the title", meta.title === "A Test Page", meta.title);
  ok("pageMeta resolves og:image", meta.image === base + "/pic.png", meta.image);

  // ---- the index is append-only -----------------------------------------
  trove.append({ v: 1, id: "clip_one", t: Date.now(), kind: "image", sha256: a.sha, object: a.rel });
  trove.append({ v: 1, id: "clip_two", t: Date.now(), kind: "image", sha256: a.sha, object: a.rel });
  trove.append({ v: 1, id: "clip_f", t: Date.now(), kind: "forgotten", ref: "clip_one" });
  const lines = trove.read();
  ok("two clips of one image = two lines, one blob", lines.length === 3, lines.length);
  ok("index survives a truncated tail", (() => {
    fs.appendFileSync(trove.index, '{"broken":');
    return trove.read().length === 3;
  })());

  // ---- extension inference ----------------------------------------------
  ok("extFor maps mime", clipper.extFor("image/jpeg", "x") === ".jpg");
  ok("extFor falls back to the url", clipper.extFor("", "http://x/y/z.webp?q=1") === ".webp");
  ok("extFor has a last resort", clipper.extFor("", "http://x/y") === ".bin");

  // ---- size cap ---------------------------------------------------------
  ok("MAX_BYTES matches Glamoire's ceiling", clipper.MAX_BYTES === 25 * 1024 * 1024);

  // ---- research leads: fold an append-only container file ----------------
  const led = new clipper.Leads(root);
  ok("leadId is not a clipId", clipper.leadId().startsWith("lead_"), clipper.leadId());
  led.append({ v: 1, kind: "lead", id: "lead_a", name: "Rumsfeld money trail", t: Date.now() });
  led.append({ v: 1, kind: "lead", id: "lead_b", name: "Anthrax timeline", t: Date.now() });
  led.append({ v: 1, kind: "filed", lead: "lead_a", ref: "clip_one", t: Date.now() });
  led.append({ v: 1, kind: "filed", lead: "lead_a", ref: "clip_two", t: Date.now() });
  led.append({ v: 1, kind: "filed", lead: "lead_b", ref: "clip_one", t: Date.now() });
  led.append({ v: 1, kind: "lead-active", ref: "lead_a", t: Date.now() });
  let F = led.fold();
  ok("fold lists leads", F.leads.length === 2, F.leads);
  ok("fold carries memberships", F.leads[0].clips.size === 2, [...F.leads[0].clips]);
  ok("a clip may be in more than one lead", F.leads[1].clips.has("clip_one"));
  ok("fold reads the active switch", F.active === "lead_a", F.active);
  led.append({ v: 1, kind: "unfiled", lead: "lead_a", ref: "clip_two", t: Date.now() });
  led.append({ v: 1, kind: "lead-active", ref: null, t: Date.now() });
  F = led.fold();
  ok("unfiled removes a membership", !F.leads[0].clips.has("clip_two"));
  ok("lead-active null switches routing off", F.active === null, F.active);
  ok("filed for an unknown lead is inert", (() => {
    led.append({ v: 1, kind: "filed", lead: "lead_ghost", ref: "clip_one", t: Date.now() });
    return led.fold().leads.length === 2;
  })());
  ok("retiring a lead drops it and clears the active switch", (() => {
    led.append({ v: 1, kind: "lead-active", ref: "lead_b", t: Date.now() });
    led.append({ v: 1, kind: "lead-retired", ref: "lead_b", t: Date.now() });
    const G = led.fold();
    return G.leads.length === 1 && G.active === null;
  })());
  ok("leads.jsonl survives a truncated tail", (() => {
    fs.appendFileSync(led.file, '{"kind":"file');
    return led.read().length > 0 && led.fold().leads.length === 1;
  })());
  ok("Leads in an empty directory reads as nothing", (() => {
    const fresh = new clipper.Leads(path.join(root, "nope"));
    return fresh.read().length === 0 && fresh.fold().active === null;
  })());

  // ---- fanout fails soft when nothing is listening -----------------------
  const brain = await clipper.toBrain({ subject: "x", base: "http://127.0.0.1:1" });
  ok("brain unreachable fails soft", brain.ok === false && !!brain.error, brain);
  const glam = await clipper.toGlamoire({
    characterId: 1, filename: "x.png", buffer: png, mime: "image/png", base: "http://127.0.0.1:1",
  });
  ok("glamoire unreachable fails soft", glam.ok === false && !!glam.error, glam);

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  app.exit(fail ? 1 : 0);
});
