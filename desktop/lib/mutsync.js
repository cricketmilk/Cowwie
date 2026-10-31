// The phone bridge: Ifreglen's one open port, and the door Professional Goat
// comes through.
//
// Everything the phone does with the laptop lands here: the install and pair
// pages, the notifications it forwards (lib/comms.js), the errands it runs,
// the briefs it polls for and the notes it sends back (lib/briefs.js), and
// Kenoma's approvals relayed from :8890. Processes on THIS machine use the
// same server for The Wilds (/wilds/*), the herald (/herald/*), the bus
// (/bus/stream) and filing briefs (/briefs) -- loopback only, same bearer.
//
// WHY A LAN LISTENER AND NOT A CLOUD SERVICE. The alternative was a Worker,
// which would reach the phone from anywhere and costs a deploy, a bucket and a
// standing bill. This costs nothing, needs no account, and -- the part that
// decided it -- nothing about the person's work leaves the house. The shapes
// below are transport-agnostic if that ever changes.
//
// SECURITY, because this opens a port on a machine, which nothing else in this
// shell does:
//   * Every authed route requires MUT_SYNC_TOKEN as a bearer (the secret's
//     name is kept so the phone client keeps working). With no token the
//     authed routes answer 503.
//   * It binds to the LAN, not the internet. A router forwarding this port is
//     the user's decision and a bad one.
//   * The routes that drive this machine answer only to this machine
//     (fromThisMachine below), token or not.
//   * Bodies are capped; text that arrives is bounded and only ever displayed.
const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 8793 is the bridge's port; 8812 is Lookout's, 8890 Kenoma's, 8795 Haruspex's.
//
// Overridable so a second shell can run beside the first. --data-dir moves the
// shell's state and --user-data-dir moves Chromium's profile, but without this
// the parallel instance still collides on the port, silently loses its server
// to EADDRINUSE, and then answers on the FIRST shell's — which is a confusing
// way to spend an afternoon.
const PORT = (() => {
  const a = process.argv.find((x) => x.startsWith("--sync-port="));
  const v = a ? Number(a.split("=")[1]) : Number(process.env.MUT_SYNC_PORT);
  return Number.isInteger(v) && v > 0 && v < 65536 ? v : 8793;
})();
// Whether that number was ASKED for. A port somebody typed is not walked away
// from -- they typed it for a reason -- but the default is allowed to move.
const EXPLICIT = process.argv.some((x) => x.startsWith("--sync-port=")) || !!process.env.MUT_SYNC_PORT;
// The port actually listened on. The default walks (8793, then 8803-8807)
// when something else holds it -- another shell, most often -- and port() is
// what everything that prints an address reads. The walk skips 8794-8799
// because other things on this LAN historically lived there.
let port = PORT;
const MAX_BODY = 32 * 1024 * 1024;

// Constant-time compare, so the token cannot be recovered a byte at a time by
// timing the responses. Cheap, and the alternative is a real hole.
function tokenOk(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// The routes that drive THIS machine -- The Wilds (a browser with logged-in
// sessions), the bus (which every tile trusts) and filing briefs -- answer
// only to a process on this machine. The listener is 0.0.0.0 because the
// phone needs /mut/comms, /errands, /briefs and /mut/forge; nothing off this
// box drives the browser or publishes on the bus, and the token alone was not
// enough of a wall: /install used to print it to anyone on the wifi who
// opened the page.
//
// One way past a loopback check, answered: a website a browser on THIS
// machine has open reaches 127.0.0.1 too, so the request must also have been
// addressed to localhost by name (a page that rebinds its own hostname to
// 127.0.0.1 still sends its own name as Host).
const LOOPBACK = /^(?:127\.|::1$|::ffff:127\.)/;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
function fromThisMachine(req) {
  return LOOPBACK.test(String((req.socket && req.socket.remoteAddress) || "")) && LOCAL_HOST.test(String(req.headers.host || ""));
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(new Error("too big")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * @param {object} o
 * @param {string} o.root      the shell's data directory
 * @param {() => string|null} o.token   resolved lazily, so rotating it needs no restart
 */
// `wilds` is the shell's browser control surface (main.js wildsControl). It is
// passed in rather than required, because this module is deliberately ignorant
// of Electron — it is a plain HTTP server, and everything that touches a view
// stays in the main process.
// `compute` answers GET /compute: the roster of local model lanes an agent on
// this machine may send prompts to. Ifreglen has none, so main.js passes a
// function that answers an empty roster. Loopback only, behind the bearer.
// `comms` is the phone's notifications in and replies out (lib/comms.js):
// POST /mut/comms, GET /mut/comms/outbox, POST /mut/comms/ack. The phone's
// side, so any address with the bearer — like errands, it is the phone, on
// the Wi-Fi.
// `herald` is Auri's door (main.js heraldControl): POST /herald/notify files a
// card, /herald/task reports work in progress, /herald/state reads the queue.
// Same posture again. A process here may make her LOUD (band 3) but can never
// raise an approval: nothing it files can carry an answer back to anyone.
// `briefs` is { file, list, ack, note, notes } (main.js over lib/briefs.js):
// POST /briefs (this machine) files one for the phone; GET /briefs and POST
// /briefs/ack are the phone's; POST /notes is the phone's, GET /notes this
// machine's. main.js does the filing so that a brief is also one of Auri's
// cards -- only main can raise a card with any teeth, and a brief has none.
// ---- errands ---------------------------------------------------------------
// Small jobs for the phone: a fetch of one URL from the phone's own
// connection. This laptop's address is bot-checked by the search engines and
// refused by the filings sites; a phone on a carrier network looks like a
// person. Kenoma files an errand here (loopback only), the phone's poll takes
// it with its bearer, fetches through its native HTTP bridge, and posts the
// body back; Kenoma polls for the result. Nothing is stored past memory,
// nothing runs without a phone asking, and a fetch is all an errand can be:
// the phone never runs a command or opens a page for anyone.
const ERRAND_TTL_MS = 2 * 60 * 1000;
const ERRAND_BODY_MAX = 400 * 1024;
const errands = new Map();      // id -> { id, kind, url, headers, max, at, taken, done, result }
let phoneSeen = 0;              // last time a phone asked for work
function errandPrune() { const now = Date.now(); for (const [id, e] of errands) if (now - e.at > ERRAND_TTL_MS) errands.delete(id); }
function errandFile(spec) {
  errandPrune();
  const url = String(spec.url || "");
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return { error: "an errand is one http(s) URL" };
  const id = crypto.randomBytes(6).toString("hex");
  const e = { id, kind: "fetch", url, headers: spec.headers && typeof spec.headers === "object" ? spec.headers : {}, max: Math.min(ERRAND_BODY_MAX, Number(spec.max) || ERRAND_BODY_MAX), at: Date.now(), taken: 0, done: 0, result: null };
  errands.set(id, e);
  return { ok: true, id, phoneSeenMs: phoneSeen ? Date.now() - phoneSeen : null };
}
function errandNext() {
  phoneSeen = Date.now();
  errandPrune();
  for (const e of errands.values()) if (!e.taken) { e.taken = Date.now(); return { ok: true, errand: { id: e.id, kind: e.kind, url: e.url, headers: e.headers, max: e.max } }; }
  return { ok: true, errand: null };
}
function errandDone(id, body) {
  const e = errands.get(id);
  if (!e) return { error: "no such errand (expired?)" };
  e.done = Date.now();
  e.result = { ok: body.ok !== false, status: Number(body.status) || 0, contentType: String(body.contentType || ""), text: String(body.text || "").slice(0, e.max), error: body.error ? String(body.error).slice(0, 300) : null, ms: Number(body.ms) || 0 };
  return { ok: true };
}
function errandGet(id) {
  const e = errands.get(id);
  if (!e) return { error: "no such errand (expired?)" };
  return { ok: true, id, taken: !!e.taken, done: !!e.done, result: e.result, phoneSeenMs: phoneSeen ? Date.now() - phoneSeen : null };
}
function errandStatus() { errandPrune(); return { ok: true, phoneSeenMs: phoneSeen ? Date.now() - phoneSeen : null, queued: [...errands.values()].filter((e) => !e.taken).length, open: [...errands.values()].filter((e) => e.taken && !e.done).length }; }

function start({ root, token, wilds = null, stream = null, onListening = null, compute = null, herald = null, comms = null, briefs = null, morning = null }) {
  // The phone may be a browser, which the first cut of this file forgot.
  //
  // A webview loading a page from localhost makes every request cross-origin,
  // and one carrying an Authorization header is not a simple request — the
  // webview sends a preflight OPTIONS first and will not send the real request
  // unless that preflight is answered. It never was: OPTIONS fell through to
  // the auth check, browsers do not put credentials on a preflight, so it
  // 401'd and the fetch was blocked before it left the phone.
  //
  // The old header here was `Access-Control-Allow-Origin: null`, with a comment
  // about not letting a stray page poke at it. Worth being clear about what
  // that was actually buying: nothing. CORS governs whether a PAGE may read a
  // response using credentials the browser attaches on its own — cookies, TLS
  // client certs. There are none here; the only credential is a bearer token
  // the caller has to already know, and a non-browser client ignores CORS
  // entirely. The token is the security boundary, and CORS was never it. What
  // `null` did buy was breaking the one client this exists to serve.
  //
  // So: allow exactly the origins a phone webview is served from, echoed back
  // only if they match, never reflected blindly and never "*". A native
  // client (Professional Goat is one) sends no Origin and CORS does not apply.
  // A PORT is allowed on the localhost origins so a web build of the phone
  // page can be worked on in a desktop browser against a real shell.
  const ALLOWED = /^(https?|capacitor):\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
  const cors = (req) => {
    const o = req.headers.origin;
    const out = { Vary: "Origin" };
    // A request with no Origin is not a browser — curl, the desktop itself, a
    // script. Nothing to allow, and nothing to refuse either: CORS simply does
    // not apply to it.
    if (o && (ALLOWED.test(o) || o === "null")) out["Access-Control-Allow-Origin"] = o;
    return out;
  };

  const send = (res, code, obj, req) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      ...(req ? cors(req) : {}),
      "X-Content-Type-Options": "nosniff",
    });
    res.end(body);
  };

  // The phone app: Professional Goat, the Android project at the root of this
  // repo (desktop/ is its sibling folder; package com.cowwie). Its debug APK
  // is what GET /goat.apk serves. GOAT_APK_PATH overrides for a release build
  // kept elsewhere. There is no web build to serve: the app is native.
  const WWW = process.env.GOAT_PHONE_WWW || null;
  function apkPath() {
    const roots = [
      process.env.GOAT_APK_PATH,
      path.join(__dirname, "..", "..", "app", "build", "outputs", "apk", "debug", "app-debug.apk"),
    ].filter(Boolean);
    return roots.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || roots[0];
  }
  // The "Open in Professional Goat" button. A goat://pair link the app claims
  // (AndroidManifest: scheme "goat", host "pair"). intent:// is the reliable
  // way to launch an app from Chrome on Android; the fallback brings a phone
  // without the app to the install page rather than a dead end.
  const APP_PACKAGE = "com.cowwie";
  const APP_NAME = "Professional Goat";
  function deepLinkFor(host, tok) {
    return `intent://pair?token=${encodeURIComponent(tok)}&host=${encodeURIComponent(host)}`
      + `#Intent;scheme=goat;package=${APP_PACKAGE};`
      + `S.browser_fallback_url=${encodeURIComponent(`http://${host}/install`)};end`;
  }
  const PAGE_CSS = `
body{background:#0A0B12;color:#D9D5C7;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box;text-align:center}
h1{font-weight:400;font-size:24px;margin:0 0 4px}
p{color:#8B90A0;max-width:320px;line-height:1.55;font-size:14px}
.step{margin:18px 0 0;width:100%;max-width:320px}
.n{color:#5D637A;font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
a.btn{display:block;background:#7FD6A8;color:#0A0B12;border-radius:10px;padding:14px;font-weight:700;font-size:15px;text-decoration:none;margin-top:6px}
a.btn2{background:#171A28;color:#D9D5C7;border:1px solid #262D42}
code{display:block;background:#12141F;border:1px solid #262D42;border-radius:8px;padding:10px;font-size:11px;word-break:break-all;margin-top:6px;color:#8B90A0;text-align:left}
#msg{color:#7FD6A8;font-size:12px;min-height:16px;margin-top:6px}
`;
  const COPY_JS = `
document.getElementById("copy").addEventListener("click", async (e) => {
  e.preventDefault();
  const t = document.getElementById("pair").textContent;
  try { await navigator.clipboard.writeText(t); document.getElementById("msg").textContent = "Copied — paste it in the app."; }
  catch {
    const r = document.createRange(); r.selectNodeContents(document.getElementById("pair"));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    document.getElementById("msg").textContent = "Selected — long-press and copy.";
  }
});
`;
  // Only when a web build is pointed at by GOAT_PHONE_WWW: the native app has
  // none, so by default nothing static is served and / is the pair page.
  let wwwAbs = null;
  try { wwwAbs = WWW && fs.existsSync(WWW) ? path.resolve(WWW) : null; } catch { wwwAbs = null; }

  // MIME types for the handful of filetypes the phone app serves.
  const MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".json": "application/json",
    ".png": "image/png", ".gif": "image/gif", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml",
  };
  function serveStatic(req, res) {
    if (!wwwAbs) return false;
    const u = new URL(req.url, "http://x");
    // Only serve the phone app itself — /mut/sync/* stays auth-gated below.
    if (u.pathname.startsWith("/mut/sync/")) return false;
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    // Build a relative path from the URL, strip query/hash, then resolve it
    // against wwwAbs. path.resolve handles .. traversal on both separators
    // and the final startsWith check catches anything that escaped.
    let rel = decodeURIComponent(u.pathname);
    if (rel === "/") rel = "/index.html";
    // Drop any leading slash so resolve treats it as relative.
    rel = rel.replace(/^\/+/, "");
    const abs = path.resolve(wwwAbs, rel);
    // On Windows, resolve normalises to backslashes; compare resolved forms.
    if (!abs.startsWith(path.resolve(wwwAbs) + path.sep) && abs !== path.resolve(wwwAbs)) return false;
    // Additional: reject anything that resolved to a path outside wwwAbs even
    // if startsWith somehow passed (e.g. wwwAbs = C:\a, abs = C:\abc\x).
    if (!abs.startsWith(path.resolve(wwwAbs) + path.sep) && abs !== path.resolve(wwwAbs)) return false;
    try {
      const buf = fs.readFileSync(abs);
      const ext = path.extname(abs).toLowerCase();
      const ct = MIME[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": ct, "Content-Length": buf.length, ...(req.method !== "HEAD" ? cors(req) : {}) });
      if (req.method !== "HEAD") res.end(buf); else res.end();
    } catch { return false; }
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");  // parse BEFORE any route checks
    console.log(`[bridge] ${req.method} ${url.pathname} from ${req.socket?.remoteAddress}`);

    // OPTIONS — see the block comment above. Must be answered before any auth.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors(req),
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
        "X-Content-Type-Options": "nosniff",
      });
      return res.end();
    }

    // A GET to /ping returns {ok:true} with CORS — the simplest possible
    // diagnostic: if the phone cannot reach this, nothing else will work.
    // `who` is what the phone checks to know it has found an Ifreglen shell.
    if (req.method === "GET" && (url.pathname === "/ping")) {
      return send(res, 200, { ok: true, who: "ifreglen", port, app: APP_NAME }, req);
    }

    // A GET to /test returns a tiny self-contained page — inline HTML, no file
    // serving — so a phone that can load it has proven the HTTP transport.
    if (req.method === "GET" && url.pathname === "/test") {
      const token = String(url.searchParams.get("token") || "");
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ifreglen Test</title><style>body{background:#0A0B12;color:#D9D5C7;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px;box-sizing:border-box}h1{font-weight:400;font-size:24px}p{color:#8B90A0;max-width:300px}code{background:#12141F;padding:3px 8px;border-radius:4px;font-size:13px;word-break:break-all}</style></head><body><h1>The Ifreglen bridge is working</h1><p>If you can read this, the HTTP server is responding correctly.</p>${token ? `<p>Token received: <code>${token.slice(0, 12)}…</code></p>` : "<p>No token in URL.</p>"}</body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      return res.end(html);
    }

    // Guided install: one QR does the whole job. The page downloads the APK
    // AND shows the pairing link as copyable text on the phone itself — the
    // gap that made "scan the APK QR, open the app, get asked for a token"
    // confusing. The pair URL is built from the request's own Host header,
    // so it carries the same address (LAN IP or onion) the phone just used.
    //
    // BUT this page needs no token, and it used to print the server's own:
    // anybody on the wifi who opened /install left with the key to The Wilds,
    // the bus and Kenoma. So the key is in the page only when the page was
    // asked for from this machine. A phone gets the download and the steps,
    // and pairs from the Trove's "Professional Goat — pair" code -- shown on
    // the laptop's own screen, which is the proof of being in the room that
    // /install never was.
    if (req.method === "GET" && url.pathname === "/install") {
      const tok = fromThisMachine(req) ? (token() || "") : "";
      const host = req.headers.host || `localhost:${port}`;
      const pairUrl = `http://${host}/pair?token=${encodeURIComponent(tok)}`;
      const deepLink = tok ? deepLinkFor(host, tok) : "";
      let built = "unknown";
      try { built = fs.statSync(apkPath()).mtime.toLocaleString(); } catch {}
      const pairStep = tok
        ? `<div class="step"><span class="n">3 · pair</span><a class="btn" href="${deepLink}">Open in ${APP_NAME}</a><p>The app opens and keeps the key. Or open ${APP_NAME}, tap <b>Scan QR</b>, and point it at the second code on the laptop (the Trove → Apps → ${APP_NAME} — pair). If neither works, paste this into the app's pairing field:</p><a class="btn btn2" id="copy" href="#">Copy pairing link</a><code id="pair">${pairUrl}</code><div id="msg"></div></div>
<script>${COPY_JS}</script>`
        : `<div class="step"><span class="n">3 · pair</span><p>Open ${APP_NAME}, tap <b>Scan QR</b>, and point it at the pairing code on the laptop's screen: the Trove → Apps → <b>${APP_NAME} — pair</b>. That code carries the key; this page, which anyone on the wifi can open, does not.</p></div>`;
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Install ${APP_NAME}</title><style>${PAGE_CSS}</style></head><body>
<h1>${APP_NAME}</h1>
<p>Ifreglen's phone companion: briefs from your work apps, notes back to the laptop.</p>
<div class="step"><span class="n">1 · download</span><a class="btn" href="/goat.apk">Download ${APP_NAME}.apk</a><p style="font-size:11px;color:#5D637A">this build: ${built} — if you installed an earlier one, install again over it (your pairing survives).</p></div>
<div class="step"><span class="n">2 · install &amp; open it</span><p>Android will ask to allow installs from this source — that's normal for a sideloaded app.</p></div>
${pairStep}
</body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      return res.end(html);
    }

    // The second QR. The Trove's "Professional Goat — pair" entry is this
    // address with the token in it. Read from inside the app (the Scan QR
    // button on its pairing screen) the app keeps the key without ever loading
    // this page; read by the phone's camera app it lands here, where "Open in
    // Professional Goat" hands the same link to the app, and the link is
    // printed for the day neither works. GET / with ?token= comes here too.
    if (req.method === "GET" && (url.pathname === "/pair" || (url.pathname === "/" && url.searchParams.has("token") && !wwwAbs))) {
      const host = req.headers.host || `localhost:${port}`;
      // The token in the page is the one in the address, never the server's
      // own: this page is unauthenticated, and must not hand out the secret
      // to anyone who can reach the port.
      const tok = String(url.searchParams.get("token") || "");
      const pairUrl = `http://${host}/pair?token=${encodeURIComponent(tok)}`;
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair ${APP_NAME}</title><style>${PAGE_CSS}</style></head><body>
<h1>${APP_NAME}</h1>
<p>${tok ? "The laptop's key, for the phone in your hand." : `This link carries no key. Scan the code the laptop's Trove shows for ${APP_NAME} — pair.`}</p>
${tok ? `<div class="step"><a class="btn" href="${deepLinkFor(host, tok)}">Open in ${APP_NAME}</a><p>The app opens and keeps the key. Not installed yet? <a href="/install" style="color:#7FD6A8">Install ${APP_NAME}</a> first.</p><a class="btn btn2" id="copy" href="#">Copy pairing link</a><code id="pair">${pairUrl}</code><div id="msg"></div></div><script>${COPY_JS}</script>` : ""}
</body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
      return res.end(html);
    }

    // The installable APK: the Android project's debug build. The APK carries
    // no token, so this is no more open than the install page above. /mut.apk
    // stays as an alias for a phone client that still asks by the old name.
    if (req.method === "GET" && (url.pathname === "/goat.apk" || url.pathname === "/mut.apk")) {
      try {
        const buf = fs.readFileSync(apkPath());
        res.writeHead(200, {
          "Content-Type": "application/vnd.android.package-archive",
          "Content-Disposition": 'attachment; filename="professional-goat.apk"',
          "Content-Length": buf.length,
        });
        return res.end(buf);
      } catch {
        return send(res, 404, { error: "no APK built yet — run gradlew assembleDebug at the repo root" }, req);
      }
    }

    if (serveStatic(req, res)) return;

    const expected = token();
    if (!expected) return send(res, 503, { error: "sync is off" }, req);

    const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!tokenOk(auth, expected)) return send(res, 401, { error: "no" }, req);

    // url is already parsed at the top — sync routes below use it directly.
    try {
      // ----------------------------------------------------- the bus, heard
      // GET /bus/stream: every bus message as Server-Sent Events, for the
      // processes outside the window (lib/busstream.js says who and why).
      // Bearer-authed by the block above; this machine only, like The Wilds.
      if (req.method === "GET" && url.pathname === "/bus/stream") {
        if (!fromThisMachine(req)) return send(res, 403, { error: "the bus answers to this machine only" }, req);
        if (!stream) return send(res, 503, { error: "the bus is not available" }, req);
        return stream.handle(req, res, url);
      }

      // ------------------------------------------------------- The Wilds
      // One route per verb, thin: parse, hand to the main process, answer.
      // Bearer-authed by the block above, loopback-only like everything else
      // here. This is what wilds-mcp.mjs talks to, which is in turn what
      // Kenoma and any other MCP client talk to.
      if (req.method === "POST" && url.pathname.startsWith("/wilds/")) {
        if (!fromThisMachine(req)) return send(res, 403, { error: "The Wilds answers to this machine only" }, req);
        if (!wilds) return send(res, 503, { error: "the browser is not available" }, req);
        const action = url.pathname.slice("/wilds/".length);
        const raw = await readBody(req, 1 << 20);
        let payload = {};
        try { payload = raw.length ? JSON.parse(raw.toString("utf8")) : {}; }
        catch { return send(res, 400, { error: "body must be JSON" }, req); }
        let out;
        try { out = await wilds(action, payload); }
        catch (e) { return send(res, 500, { error: String((e && e.message) || e) }, req); }
        return send(res, out && out.error ? 400 : 200, out || {}, req);
      }

      if (req.method === "POST" && url.pathname.startsWith("/herald/")) {
        if (!fromThisMachine(req)) return send(res, 403, { error: "Auri answers to this machine only" }, req);
        if (!herald) return send(res, 503, { error: "the herald is not available" }, req);
        const raw = await readBody(req, 1 << 16);
        let payload = {};
        try { payload = raw.length ? JSON.parse(raw.toString("utf8")) : {}; }
        catch { return send(res, 400, { error: "body must be JSON" }, req); }
        const out = herald(url.pathname.slice("/herald/".length), payload);
        return send(res, out && out.error ? 400 : 200, out || {}, req);
      }

      // ------------------------------------------------------- comms
      // The phone's notifications in, replies out. lib/comms.js has the rules;
      // this is only the doorway, and it never writes a word of it to disk.
      if (url.pathname === "/mut/comms" || url.pathname.startsWith("/mut/comms/")) {
        if (!comms) return send(res, 503, { error: "comms is not available" }, req);
        const json = async () => {
          const raw = await readBody(req, 1 << 18);
          return raw.length ? JSON.parse(raw.toString("utf8")) : {};
        };
        try {
          if (req.method === "POST" && url.pathname === "/mut/comms") return send(res, 200, comms.ingest(await json()), req);
          if (req.method === "GET" && url.pathname === "/mut/comms/outbox") return send(res, 200, comms.take(), req);
          if (req.method === "POST" && url.pathname === "/mut/comms/ack") {
            const r = comms.ack(await json());
            return send(res, r.ok ? 200 : 404, r, req);
          }
        } catch { return send(res, 400, { error: "body must be JSON" }, req); }
        return send(res, 404, { error: "no such comms route" }, req);
      }

      // ------------------------------------------------------- briefs
      // What the work apps want the phone to know (lib/briefs.js). Filing is
      // this machine's (Lookout, Credentials, Onboarding hold the bearer);
      // reading and acking are the phone's, from any address with the bearer.
      // ------------------------------------------------------- the morning
      // POST /morning files today's brief now; GET /morning/schedule reads
      // the time, POST /morning/schedule {time, days} sets it. This machine
      // only: the phone reads briefs, it does not schedule them.
      if (url.pathname === "/morning" || url.pathname === "/morning/schedule") {
        if (!morning) return send(res, 503, { error: "the morning brief is not available" }, req);
        if (!fromThisMachine(req)) return send(res, 403, { error: "this machine only" }, req);
        try {
          if (req.method === "POST" && url.pathname === "/morning") return send(res, 200, await morning.run(), req);
          if (req.method === "GET" && url.pathname === "/morning/schedule") return send(res, 200, morning.schedule(), req);
          if (req.method === "POST" && url.pathname === "/morning/schedule") {
            const raw = await readBody(req, 1 << 12);
            return send(res, 200, morning.schedule(raw.length ? JSON.parse(raw.toString("utf8")) : {}), req);
          }
        } catch (e) { return send(res, 400, { error: String(e && e.message || e) }, req); }
        return send(res, 404, { error: "no such morning route" }, req);
      }
      if (url.pathname === "/briefs" || url.pathname.startsWith("/briefs/")) {
        if (!briefs) return send(res, 503, { error: "briefs are not available" }, req);
        const json = async (limit = 1 << 16) => {
          const raw = await readBody(req, limit);
          return raw.length ? JSON.parse(raw.toString("utf8")) : {};
        };
        try {
          if (req.method === "POST" && url.pathname === "/briefs") {
            if (!fromThisMachine(req)) return send(res, 403, { error: "briefs are filed from this machine only" }, req);
            const r = briefs.file(await json());
            return send(res, r.error ? 400 : 200, r, req);
          }
          if (req.method === "GET" && url.pathname === "/briefs") {
            phoneSeen = Date.now();
            return send(res, 200, { ok: true, briefs: briefs.list(Number(url.searchParams.get("since")) || 0) }, req);
          }
          if (req.method === "POST" && url.pathname === "/briefs/ack") {
            const body = await json();
            return send(res, 200, briefs.ack(body.ids), req);
          }
        } catch { return send(res, 400, { error: "body must be JSON" }, req); }
        return send(res, 404, { error: "no such briefs route" }, req);
      }

      // ------------------------------------------------------- notes
      // A line from the phone for the laptop (POST, any address with the
      // bearer); the last hundred, for a process here (GET, this machine).
      if (url.pathname === "/notes") {
        if (!briefs) return send(res, 503, { error: "notes are not available" }, req);
        if (req.method === "POST") {
          let body;
          try { const raw = await readBody(req, 1 << 16); body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; }
          catch { return send(res, 400, { error: "body must be JSON" }, req); }
          phoneSeen = Date.now();
          const r = briefs.note(body);
          return send(res, r.error ? 400 : 200, r, req);
        }
        if (req.method === "GET") {
          if (!fromThisMachine(req)) return send(res, 403, { error: "notes are read from this machine only" }, req);
          return send(res, 200, { ok: true, notes: briefs.notes() }, req);
        }
        return send(res, 404, { error: "no such notes route" }, req);
      }

      // ------------------------------------------------------- errands
      // The phone's side (any address, bearer): take the next errand, post
      // a result. Kenoma's side (this machine only): file one, read one.
      if (req.method === "GET" && url.pathname === "/errands/next") return send(res, 200, errandNext(), req);
      if (req.method === "POST" && /^\/errands\/[a-f0-9]{12}$/.test(url.pathname)) {
        const raw = await readBody(req, ERRAND_BODY_MAX + 4096);
        let body = {};
        try { body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { return send(res, 400, { error: "body must be JSON" }, req); }
        const r = errandDone(url.pathname.slice("/errands/".length), body);
        return send(res, r.error ? 404 : 200, r, req);
      }
      if (req.method === "GET" && url.pathname === "/errands/status") return send(res, 200, errandStatus(), req);
      if (req.method === "POST" && url.pathname === "/errands") {
        if (!fromThisMachine(req)) return send(res, 403, { error: "errands are filed from this machine only" }, req);
        const raw = await readBody(req, 1 << 16);
        let spec = {};
        try { spec = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { return send(res, 400, { error: "body must be JSON" }, req); }
        const r = errandFile(spec);
        return send(res, r.error ? 400 : 200, r, req);
      }
      if (req.method === "GET" && /^\/errands\/[a-f0-9]{12}$/.test(url.pathname)) {
        if (!fromThisMachine(req)) return send(res, 403, { error: "errands are read from this machine only" }, req);
        const r = errandGet(url.pathname.slice("/errands/".length));
        return send(res, r.error ? 404 : 200, r, req);
      }

      // ------------------------------------------------------- compute
      // GET /compute: local model lanes a process here may send prompts to.
      // Kenoma's router reads it before paying an API. Ifreglen has no paired
      // GPU nodes, so main.js answers an empty roster. Loopback only.
      if (req.method === "GET" && url.pathname === "/compute") {
        if (!fromThisMachine(req)) return send(res, 403, { error: "compute answers to this machine only" }, req);
        if (!compute) return send(res, 503, { error: "no node client here" }, req);
        let out;
        try { out = await compute(); }
        catch (e) { return send(res, 500, { error: String((e && e.message) || e) }, req); }
        return send(res, 200, out || { nodes: [] }, req);
      }

      // A hello, kept for a phone client that greets first. There is no
      // larder to reconcile any more, so `have` is always empty.
      if (req.method === "GET" && url.pathname === "/mut/sync/hello") {
        phoneSeen = Date.now();
        return send(res, 200, { ok: true, who: "ifreglen", app: APP_NAME, have: [] }, req);
      }

      // ---- Forge proxy: the phone can ask the coding agent ------------------
      // Streams SSE from Kenoma :8890 back to the phone, so the answer appears
      // token by token.
      if (req.method === "POST" && url.pathname === "/mut/forge/ask") {
        const body = await readBody(req, 1 << 18); // 256 KB max for the prompt
        const payload = body.length ? JSON.parse(body.toString("utf8")) : {};
        const prompt = String(payload.prompt || "").trim();
        if (!prompt) return send(res, 400, { error: "prompt is required" }, req);
        // Forward to Forge on the loopback. The laptop runs it on :8890.
        const forgeReq = http.request(
          { host: "127.0.0.1", port: 8890, path: "/chat", method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(JSON.stringify({ sessionId: "mut-phone", prompt })) },
            timeout: 300000 },
          (forgeRes) => {
            if (forgeRes.statusCode !== 200) {
              forgeRes.resume();
              res.writeHead(502, { "Content-Type": "application/json", ...cors(req) });
              return res.end(JSON.stringify({ error: "Forge answered " + forgeRes.statusCode }));
            }
            res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", ...cors(req) });
            forgeRes.pipe(res);
          });
        forgeReq.on("error", (e) => {
          res.writeHead(502, { "Content-Type": "application/json", ...cors(req) });
          res.end(JSON.stringify({ error: "Forge is not running: " + e.message }));
        });
        forgeReq.write(JSON.stringify({ sessionId: "mut-phone", prompt }));
        forgeReq.end();
        return;
      }

      // Voice through Forge: the phone sends audio, Forge transcribes and
      // optionally runs a turn, returns JSON.
      if (req.method === "POST" && url.pathname === "/mut/forge/voice") {
        const body = await readBody(req, 2 << 20);
        if (!body.length) return send(res, 400, { error: "audio data is required" }, req);
        const forgeReq = http.request(
          { host: "127.0.0.1", port: 8890, path: "/voice?sessionId=mut-phone", method: "POST",
            headers: { "Content-Type": "application/octet-stream", "Content-Length": body.length },
            timeout: 35000 },
          (forgeRes) => {
            const chunks = [];
            forgeRes.on("data", (d) => chunks.push(d));
            forgeRes.on("end", () => {
              let j = null;
              try { j = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
              if (!j) return send(res, 502, { error: "Forge voice: bad response" }, req);
              res.writeHead(forgeRes.statusCode, { "Content-Type": "application/json", ...cors(req) });
              res.end(JSON.stringify(j));
            });
          });
        forgeReq.on("error", (e) => send(res, 502, { error: "Forge is not running: " + e.message }, req));
        forgeReq.write(body);
        forgeReq.end();
        return;
      }

      // Abort the current Forge turn.
      //
      // WITH A sessionId. Forge's /abort takes one precisely so the phone and
      // the window stop aborting each other (server.js says so at the top),
      // and this relay sent none: a "stop" from the couch killed every run on
      // the laptop, including the one somebody was watching at the desk.
      // Forge's POST gate also refuses a body that is not JSON, so the
      // Content-Type matters as much as the body.
      if (req.method === "POST" && url.pathname === "/mut/forge/abort") {
        const raw = await readBody(req, 1 << 12);
        let want = {};
        try { want = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch {}
        const id = String(want.sessionId || "mut-phone");
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(id)) return send(res, 400, { error: "bad sessionId" }, req);
        // `all` stays possible, but only when the phone asks for it by name.
        const body = Buffer.from(JSON.stringify(want.all ? {} : { sessionId: id }));
        const out = await new Promise((resolve) => {
          const r = http.request({ host: "127.0.0.1", port: 8890, path: "/abort", method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": body.length }, timeout: 4000 },
            (fr) => {
              const chunks = [];
              fr.on("data", (d) => chunks.push(d));
              fr.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve({ ok: fr.statusCode === 200 }); } });
            });
          r.on("error", (e) => resolve({ ok: false, error: "Forge is not running: " + e.message }));
          r.on("timeout", () => { try { r.destroy(); } catch {} resolve({ ok: false, error: "Forge did not answer" }); });
          r.write(body); r.end();
        });
        return send(res, 200, { ok: true, ...out }, req);
      }

      // ---- Approvals relay: phone answers policy asks for Forge turns -------
      // Fetch pending prompts/approvals across sessions or for mut-phone specifically
      if (req.method === "GET" && url.pathname === "/mut/forge/approvals") {
        const forgeReq = http.request(
          { host: "127.0.0.1", port: 8890, path: "/sessions", method: "GET", timeout: 5000 },
          (forgeRes) => {
            const chunks = [];
            forgeRes.on("data", (d) => chunks.push(d));
            forgeRes.on("end", async () => {
              let sessionsList = [];
              try { sessionsList = JSON.parse(Buffer.concat(chunks).toString()).sessions || []; } catch {}
              const pendingAll = [];
              for (const s of sessionsList) {
                if (s.state === "waiting_approval" || s.state === "waiting_user") {
                  try {
                    const detail = await new Promise((resDetail) => {
                      const r = http.request({ host: "127.0.0.1", port: 8890, path: `/sessions/${encodeURIComponent(s.id)}`, method: "GET", timeout: 3000 },
                        (rRes) => {
                          const dChunks = [];
                          rRes.on("data", (d) => dChunks.push(d));
                          rRes.on("end", () => {
                            try { resDetail(JSON.parse(Buffer.concat(dChunks).toString())); } catch { resDetail(null); }
                          });
                        });
                      r.on("error", () => resDetail(null));
                      r.end();
                    });
                    if (detail && detail.pending && detail.pending.length) {
                      for (const p of detail.pending) pendingAll.push({ ...p, sessionId: s.id });
                    }
                  } catch {}
                }
              }
              // What every session is doing, trimmed here rather than on the
              // phone: the poll already has this answer in hand, so a phone
              // that wants to know whether a turn finished costs no extra
              // request. The prompt is cut short so a wall of text never
              // crosses the wire.
              const sessions = sessionsList.map((s) => ({
                id: s.id, running: !!s.running, state: s.state, turn: s.turn,
                updatedAt: s.updatedAt, lastPrompt: String(s.lastPrompt || "").slice(0, 80),
              }));
              return send(res, 200, { ok: true, pending: pendingAll, sessions }, req);
            });
          });
        forgeReq.on("error", (e) => send(res, 502, { error: "Forge is not running: " + e.message }, req));
        forgeReq.end();
        return;
      }

      // Submit an answer/decision to Forge for a pending prompt or approval
      if (req.method === "POST" && url.pathname === "/mut/forge/approve") {
        const body = await readBody(req, 1 << 16);
        if (!body.length) return send(res, 400, { error: "approval decision payload required" }, req);
        const forgeReq = http.request(
          { host: "127.0.0.1", port: 8890, path: "/approve", method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": body.length },
            timeout: 5000 },
          (forgeRes) => {
            const chunks = [];
            forgeRes.on("data", (d) => chunks.push(d));
            forgeRes.on("end", () => {
              let j = null;
              try { j = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
              res.writeHead(forgeRes.statusCode, { "Content-Type": "application/json", ...cors(req) });
              res.end(JSON.stringify(j || { ok: forgeRes.statusCode === 200 }));
            });
          });
        forgeReq.on("error", (e) => send(res, 502, { error: "Forge is not running: " + e.message }, req));
        forgeReq.write(body);
        forgeReq.end();
        return;
      }

      return send(res, 404, { error: "no such route" }, req);
    } catch (err) {
      return send(res, 400, { error: String(err.message || err) }, req);
    }
  });

  // 0.0.0.0 so the phone can reach it. That is the entire point, and it is why
  // the token is not optional.
  //
  // The default walks; a typed port does not (see EXPLICIT). The candidates
  // skip 8794-8799 (see the note at PORT) and go to 8803 and up.
  const cands = EXPLICIT ? [PORT] : [PORT, PORT + 10, PORT + 11, PORT + 12, PORT + 13, PORT + 14];
  let i = 0;
  const tryNext = () => { port = cands[i++]; server.listen(port, "0.0.0.0"); };
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && i < cands.length) {
      console.warn(`[bridge] :${port} is taken (another shell, most likely); trying :${cands[i]}`);
      return tryNext();
    }
    console.warn("[bridge] not listening:", err.message);
  });
  server.on("listening", () => { if (onListening) onListening(port); });
  tryNext();
  return server;
}

/**
 * The addresses the phone could actually type in.
 *
 * Pairing asks for a "desktop address" and the answer is not discoverable from
 * the phone: the listener binds 0.0.0.0, so it is reachable on whichever LAN
 * address this machine happens to have, and the person holding the phone has
 * no way to know what that is. Telling them to go and find their own IP is the
 * kind of instruction that ends a feature. So the shell prints it.
 *
 * Internal and non-IPv4 interfaces are dropped — loopback is useless to
 * another device — and link-local 169.254.x is dropped too, because it means
 * DHCP failed and nothing will reach it.
 */
// The addresses a phone might reach this machine at, best first. A VPN's
// WireGuard interface (AVG's hands out 100.x, the carrier-grade range) and
// a Tailscale address come up before the Wi-Fi one on this laptop, and the
// pairing code took the first: a QR the phone scanned its way to nothing.
// Private LAN ranges first, then the rest, 100.64/10 last.
function preferLan(list) {
  const rank = (a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) ? 0 : /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a) ? 2 : 1;
  return [...list].sort((a, b) => rank(a) - rank(b));
}
function addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.internal || ni.family !== "IPv4") continue;
      if (ni.address.startsWith("169.254.")) continue;
      out.push(ni.address);
    }
  }
  return preferLan(out);
}

// When the phone last asked for anything (errands, briefs, a note, hello): the
// app is open and in reach.
module.exports = { start, addresses, preferLan, PORT, port: () => port, phoneSeen: () => phoneSeen };
