// The pairing code, end to end: the address it is printed on, the
// alternates it carries, and whether the phone's own decoder reads it.
//
//   node lib/qr-test.js
//
// The QR is drawn by lib/qr.js (the qrcode module) and read here by the
// phone's vendored jsQR (C:\mut-phone\www\lib\jsqr), the same code the
// app's scanner runs -- a code that this test decodes is one the phone
// decodes. The parse is the phone's parsePairLink, lifted from its page by
// name so the two cannot drift apart without this failing.
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const QRCode = require("qrcode");
const { preferLan } = require("./mutsync.js");
// The phone app's checkout: a sibling of the roost, named rather than reached
// for upward (CLAUDE.md: never climb out of shell/ to find a project).
const PHONE = process.env.MUT_PHONE || (process.platform === "win32" ? "C:\\mut-phone" : path.resolve(require("os").homedir(), "projects", "mut-phone"));
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (e !== undefined ? "  -> " + JSON.stringify(e) : "")); } };

// --- which address the code is printed on ---
ok("the LAN address beats a VPN's 100.x and a public one", JSON.stringify(preferLan(["100.120.57.50", "8.8.8.8", "192.168.0.17"])) === JSON.stringify(["192.168.0.17", "8.8.8.8", "100.120.57.50"]));
ok("10.x and 172.16-31.x are LAN too; 172.32 is not", JSON.stringify(preferLan(["172.32.0.1", "172.20.0.1", "10.0.0.5"])) === JSON.stringify(["172.20.0.1", "10.0.0.5", "172.32.0.1"]));
ok("an empty list stays empty", preferLan([]).length === 0);

(async () => {
  // --- the code itself, decoded by the phone's decoder ---
  const url = "http://192.168.0.17:8793/pair?token=" + "ab12cd34".repeat(8) + "#alt=" + encodeURIComponent("100.120.57.50:8793,10.0.0.5:8793");
  const svg = (await require("./qr.js").qrDataUri(url, { size: 144, margin: 2 })).dataUri;
  ok("qr.js draws an SVG data URI", /^data:image\/svg\+xml/.test(svg) && svg.length > 500);
  const png = await QRCode.toBuffer(url, { type: "png", width: 320, margin: 2, errorCorrectionLevel: "L" });
  const { PNG } = require(require.resolve("pngjs", { paths: [path.dirname(require.resolve("qrcode"))] }));
  const img = PNG.sync.read(png);
  const jsqrDir = path.join(PHONE, "www", "lib", "jsqr", "jsQR.js");
  let decoded = null;
  if (fs.existsSync(jsqrDir)) {
    const sandbox = { window: {}, module: { exports: {} }, exports: {} };
    vm.runInNewContext(fs.readFileSync(jsqrDir, "utf8"), sandbox);
    const jsQR = sandbox.window.jsQR || sandbox.module.exports.default || sandbox.module.exports;
    const r = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
    decoded = r && r.data;
    ok("the phone's decoder reads the code back, every character", decoded === url, decoded);
  } else {
    ok("(no phone checkout beside the shell: decode skipped)", true);
    decoded = url;
  }

  // --- the phone's parse of what it scanned ---
  const page = path.join(PHONE, "www", "index.html");
  if (fs.existsSync(page)) {
    const html = fs.readFileSync(page, "utf8");
    const fn = (name) => { const m = new RegExp(`\\n(function ${name}\\([\\s\\S]*?\\n})\\n`).exec(html); return m ? m[1] : null; };
    // A lifted one-liner can run on into the next declaration, so any
    // withPort the lift caught is dropped and one is provided here.
    const src = [fn("onionOf"), fn("altsOf"), fn("parsePairLink")].filter(Boolean).join("\n").replace(/^const withPort = .*$/mg, "");
    const sb = { URL, API: "", loadPair: () => null, withPort: (h, port) => (/:\d+$/.test(h) ? h : h + ":" + port) };
    vm.runInNewContext(src + "\nresult = parsePairLink(input);", Object.assign(sb, { input: decoded }));
    const p = sb.result;
    ok("the phone parses the address and the token", p && p.api === "http://192.168.0.17:8793" && p.token === "ab12cd34".repeat(8), p);
    ok("and the alternates, as origins it can try", p && JSON.stringify(p.alts) === JSON.stringify(["http://100.120.57.50:8793", "http://10.0.0.5:8793"]), p && p.alts);
    const deep = `mut://pair?host=192.168.0.17:8793&token=${"ab12cd34".repeat(8)}#alt=${encodeURIComponent("10.0.0.5:8793")}`;
    vm.runInNewContext(src + "\nresult = parsePairLink(input);", Object.assign(sb, { input: deep }));
    ok("the deep link carries the alternates too", sb.result && sb.result.api === "http://192.168.0.17:8793" && JSON.stringify(sb.result.alts) === JSON.stringify(["http://10.0.0.5:8793"]), sb.result);
  } else ok("(no phone checkout beside the shell: parse skipped)", true);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
