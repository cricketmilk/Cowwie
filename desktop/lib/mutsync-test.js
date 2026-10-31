// What the phone bridge will and will not do.
//
//   node lib/mutsync-test.js
//
// This is the only thing in the shell that opens a port, so most of what is
// below is about refusing rather than accepting: no token, a wrong token, a
// request from another machine on a route that drives this one. Then the
// routes themselves: /ping answers as ifreglen, the install page keeps the key
// in the house, errands, compute, and the briefs and notes the phone lives on.

const mutSync = require("./mutsync.js");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-"));
const TOKEN = "correct-horse-battery-staple";
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log("  ok   " + n); }
  else { fail++; console.log("  FAIL " + n + (e !== undefined ? "  -> " + JSON.stringify(e) : "")); } };
// The port the test server actually got: a live shell may hold 8793, and the
// server walks (lib/mutsync.js); asking it beats assuming.
const B = { toString: () => `http://127.0.0.1:${mutSync.port()}` };
const auth = { Authorization: "Bearer " + TOKEN };
const JSONH = { ...auth, "content-type": "application/json" };

// A stand-in for main.js's briefs wiring: records what it was asked.
function fakeBriefs() {
  const items = [], noteList = [];
  return {
    items, noteList,
    file: (spec) => { if (!spec || !spec.title) return { error: "a brief needs a title" }; const b = { id: "b" + (items.length + 1), source: spec.source, title: spec.title, level: spec.level || "normal", when: spec.when || Date.now(), read: false }; items.unshift(b); return { ok: true, id: b.id }; },
    list: (since) => items.filter((b) => !since || b.when > since),
    ack: (ids) => { let n = 0; for (const b of items) if ((ids || []).includes(b.id) && !b.read) { b.read = true; n++; } return { ok: true, acked: n }; },
    note: (spec) => { if (!spec || !spec.text) return { error: "a note needs text" }; const x = { id: "n" + (noteList.length + 1), text: spec.text }; noteList.unshift(x); return { ok: true, id: x.id }; },
    notes: () => noteList,
  };
}

(async () => {
  const busStream = require("./busstream.js").createBusStream();
  const briefs = fakeBriefs();
  const server = mutSync.start({ root, token: () => TOKEN, stream: busStream, briefs });
  await new Promise(r => setTimeout(r, 400));

  const http = require("node:http");
  const raw = (p, { host, origin, method = "GET", headers = {}, body = null } = {}) => new Promise((resolve) => {
    const h = { ...headers }; if (host) h.Host = host; if (origin) h.Origin = origin;
    if (body) { h["content-type"] = "application/json"; h["content-length"] = Buffer.byteLength(body); }
    const q = http.request({ host: "127.0.0.1", port: mutSync.port(), path: p, method, headers: h }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    q.on("error", (e) => resolve({ status: 0, body: String(e) })); if (body) q.write(body); q.end();
  });
  const AWAY = `192.168.0.17:${mutSync.port()}`;   // a request from another machine

  // --- who it is ---
  let r = await fetch(`${B}/ping`); let j = await r.json();
  ok("/ping needs no key and answers as ifreglen", r.status === 200 && j.ok && j.who === "ifreglen" && j.port === mutSync.port(), j);
  ok("and names the phone app", j.app === "Professional Goat", j);

  // --- auth ---
  r = await fetch(`${B}/mut/sync/hello`);
  ok("no token is refused", r.status === 401, r.status);
  r = await fetch(`${B}/mut/sync/hello`, { headers: { Authorization: "Bearer wrong-but-same-length!!" } });
  ok("a wrong token is refused", r.status === 401, r.status);
  r = await fetch(`${B}/mut/sync/hello`, { headers: auth });
  j = await r.json();
  ok("the right token is let in, and the hello is ifreglen's", r.status === 200 && j.who === "ifreglen" && Array.isArray(j.have) && j.have.length === 0, j);
  r = await fetch(`${B}/mut/sync/art`, { method: "POST", headers: auth, body: "x" });
  ok("the art routes are gone", r.status === 404, r.status);
  r = await fetch(`${B}/mut/sync/memory`, { headers: auth });
  ok("so is the memory route", r.status === 404, r.status);
  r = await fetch(`${B}/mut/lab`, { method: "POST", headers: JSONH, body: "{}" });
  ok("and the model lab", r.status === 404, r.status);

  // --- the preflight, which is how a webview phone client reaches this ---
  r = await fetch(`${B}/briefs`, { method: "OPTIONS",
    headers: { Origin: "http://localhost", "Access-Control-Request-Method": "GET" } });
  ok("a preflight is answered without a token", r.status === 204, r.status);
  ok("...and names the app's origin",
    r.headers.get("access-control-allow-origin") === "http://localhost",
    r.headers.get("access-control-allow-origin"));
  ok("...and allows the Authorization header",
    /authorization/i.test(r.headers.get("access-control-allow-headers") || ""),
    r.headers.get("access-control-allow-headers"));
  r = await fetch(`${B}/briefs`, { method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } });
  ok("a stranger's origin is not echoed back", !r.headers.get("access-control-allow-origin"), r.headers.get("access-control-allow-origin"));
  r = await fetch(`${B}/briefs`, { headers: { Origin: "http://localhost" } });
  ok("a preflighted route still demands the token", r.status === 401, r.status);
  r = await fetch(`${B}/mut/sync/hello`, { headers: { ...auth, Origin: "http://localhost:8932" } });
  ok("the browser-dev origin is allowed too",
    r.headers.get("access-control-allow-origin") === "http://localhost:8932",
    r.headers.get("access-control-allow-origin"));
  r = await raw("/mut/sync/hello", { headers: auth, origin: "https://evil.example" });
  ok("a website's origin is not handed CORS", !r.headers["access-control-allow-origin"], r.headers["access-control-allow-origin"]);

  // --- where the phone should be pointed ---
  ok("it can say what to type into the phone",
    Array.isArray(mutSync.addresses())
      && mutSync.addresses().every((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
      && !mutSync.addresses().some((a) => a.startsWith("127.") || a.startsWith("169.254.")),
    mutSync.addresses());

  // --- the key stays in the house -------------------------------------------
  // /install printed the server's own token to anyone on the wifi, and that
  // token drives The Wilds, the bus and Kenoma. A request from another machine
  // is simulated with a Host that is not localhost -- which is also exactly
  // what a page rebinding its own name to 127.0.0.1 sends.
  const local = await raw("/install");
  ok("/install asked for on this machine still carries the pairing link", local.body.includes(`token=${encodeURIComponent(TOKEN)}`));
  ok("and it is Professional Goat's page", /Professional Goat/.test(local.body) && !/Müt/.test(local.body) && local.body.includes("/goat.apk"));
  ok("with a goat:// deep link into com.cowwie", /scheme=goat;package=com\.cowwie;/.test(local.body), local.body.match(/intent:[^"]*/)?.[0]);
  const away = await raw("/install", { host: AWAY });
  ok("/install asked for from anywhere else carries no key at all", away.status === 200 && !away.body.includes(TOKEN) && !away.body.includes("token="), away.body.slice(0, 120));
  const pair = await raw(`/pair?token=${encodeURIComponent("abc")}`, { host: AWAY });
  ok("/pair prints only the token in its own address", pair.status === 200 && pair.body.includes("token=abc") && !pair.body.includes(TOKEN));
  r = await raw("/goat.apk");
  ok("the APK route exists (404 until a build lands, never 500)", r.status === 200 || r.status === 404, r.status);
  r = await raw("/mut.apk");
  ok("and /mut.apk is still an alias for it", r.status === 200 || r.status === 404, r.status);
  r = await raw("/wilds/tabs", { method: "POST", headers: auth, host: AWAY });
  ok("The Wilds refuses a request that did not come from this machine, token or not", r.status === 403, r.status);
  r = await raw("/bus/stream", { headers: auth, host: AWAY });
  ok("so does the bus", r.status === 403, r.status);
  r = await raw("/bus/stream");
  ok("the bus stream wants the key", r.status === 401, r.status);
  const heard = await new Promise((resolve) => {
    let b = "";
    const q = http.get({ host: "127.0.0.1", port: mutSync.port(), path: "/bus/stream?topics=test.*", headers: auth }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (c) => { b += c; if (b.includes("event: bus")) { q.destroy(); resolve({ type: res.headers["content-type"], b }); } });
      setTimeout(() => busStream.push({ topic: "test.hello", payload: { n: 1 }, from: "test" }), 100);
    });
    q.on("error", () => {});
    setTimeout(() => { q.destroy(); resolve({ b }); }, 2000);
  });
  ok("with both, it streams the bus", String(heard.type || "").startsWith("text/event-stream") && heard.b.includes("event: hello") && heard.b.includes("\"topic\":\"test.hello\""), heard.b.slice(0, 200));

  // --- briefs ---
  r = await fetch(`${B}/briefs`, { headers: auth }); j = await r.json();
  ok("the phone's list starts empty", r.status === 200 && j.ok && Array.isArray(j.briefs) && j.briefs.length === 0, j);
  r = await raw("/briefs", { method: "POST", headers: auth, host: AWAY, body: JSON.stringify({ source: "x", title: "t" }) });
  ok("filing a brief from another machine is refused", r.status === 403, r.status);
  r = await fetch(`${B}/briefs`, { method: "POST", headers: JSONH, body: JSON.stringify({ source: "lookout", title: "Board moved", body: "a rule changed", level: "normal", url: "https://example.org" }) });
  j = await r.json();
  ok("filing one from this machine answers {ok, id}", r.status === 200 && j.ok && j.id && briefs.items.length === 1 && briefs.items[0].source === "lookout", j);
  const id1 = j.id;
  r = await fetch(`${B}/briefs`, { method: "POST", headers: JSONH, body: JSON.stringify({ source: "lookout" }) });
  ok("a brief main.js refuses is a 400", r.status === 400, r.status);
  r = await fetch(`${B}/briefs`, { method: "POST", headers: JSONH, body: "{not json" });
  ok("a body that is not JSON is a 400", r.status === 400, r.status);
  r = await raw("/briefs", { headers: auth, host: AWAY }); j = JSON.parse(r.body);
  ok("the phone (any address, bearer) reads the list, newest first", r.status === 200 && j.briefs.length === 1 && j.briefs[0].id === id1 && j.briefs[0].read === false, j);
  r = await raw(`/briefs?since=${Date.now() + 60000}`, { headers: auth, host: AWAY }); j = JSON.parse(r.body);
  ok("?since= filters", j.briefs.length === 0, j);
  r = await raw("/briefs/ack", { method: "POST", headers: auth, host: AWAY, body: JSON.stringify({ ids: [id1, "nope"] }) }); j = JSON.parse(r.body);
  ok("the phone acks what it read", r.status === 200 && j.ok && j.acked === 1 && briefs.items[0].read === true, j);
  r = await fetch(`${B}/briefs/nope`, { headers: auth });
  ok("an unknown briefs route is 404", r.status === 404, r.status);
  ok("the phone has been heard from", mutSync.phoneSeen() > 0);

  // --- notes ---
  r = await raw("/notes", { method: "POST", headers: auth, host: AWAY, body: JSON.stringify({ text: "call the pharmacy" }) }); j = JSON.parse(r.body);
  ok("the phone posts a note from anywhere", r.status === 200 && j.ok && j.id && briefs.noteList[0].text === "call the pharmacy", j);
  r = await raw("/notes", { method: "POST", headers: auth, host: AWAY, body: JSON.stringify({}) });
  ok("an empty note is a 400", r.status === 400, r.status);
  r = await raw("/notes", { headers: auth, host: AWAY });
  ok("reading notes from another machine is refused", r.status === 403, r.status);
  r = await fetch(`${B}/notes`, { headers: auth }); j = await r.json();
  ok("this machine reads them back", r.status === 200 && j.ok && j.notes.length === 1, j);

  // --- errands ---
  r = await fetch(`${B}/errands/status`, { headers: auth }); j = await r.json();
  ok("errands: the queue starts empty", r.status === 200 && j.queued === 0, j);
  r = await fetch(`${B}/errands`, { method: "POST", headers: JSONH, body: JSON.stringify({ url: "https://example.com/a" }) });
  j = await r.json();
  ok("an errand is filed from this machine", r.status === 200 && j.ok && /^[a-f0-9]{12}$/.test(j.id), j);
  const errandId = j.id;
  r = await fetch(`${B}/errands`, { method: "POST", headers: JSONH, body: JSON.stringify({ url: "ftp://nope" }) });
  ok("an errand is one http(s) URL, nothing else", r.status === 400, r.status);
  r = await raw("/errands", { method: "POST", headers: auth, host: AWAY });
  ok("filing from anywhere else is refused", r.status === 403, r.status);
  r = await raw("/errands/next", { headers: auth, host: AWAY }); j = JSON.parse(r.body);
  ok("the phone (any address, bearer) takes the next errand", r.status === 200 && j.errand && j.errand.id === errandId, j);
  r = await raw("/errands/next", { headers: auth, host: AWAY }); j = JSON.parse(r.body);
  ok("and the queue is then empty", j.errand === null, j);
  r = await fetch(`${B}/errands/${errandId}`, { method: "POST", headers: JSONH, body: JSON.stringify({ ok: true, status: 200, contentType: "text/html", text: "<html>hi</html>", ms: 120 }) });
  ok("the phone posts the result", r.status === 200, r.status);
  r = await fetch(`${B}/errands/${errandId}`, { headers: auth }); j = await r.json();
  ok("Kenoma reads it back, and knows a phone was just here", j.done && j.result.text === "<html>hi</html>" && j.phoneSeenMs < 5000, j);
  r = await fetch(`${B}/errands/ffffffffffff`, { headers: auth });
  ok("an unknown errand is 404", r.status === 404, r.status);

  // --- compute ---
  r = await fetch(`${B}/compute`, { headers: auth });
  ok("compute without a roster function is 503", r.status === 503, r.status);
  r = await fetch(`${B}/briefs`, { headers: auth });
  server.close();
  const s3 = mutSync.start({ root, token: () => TOKEN, compute: async () => ({ t: 1, nodes: [] }) });
  await new Promise(r => setTimeout(r, 300));
  r = await fetch(`${B}/compute`);
  ok("compute wants the bearer", r.status === 401, r.status);
  r = await fetch(`${B}/compute`, { headers: auth }); j = await r.json();
  ok("compute hands an empty roster through", r.status === 200 && Array.isArray(j.nodes) && j.nodes.length === 0, j);
  r = await raw("/compute", { headers: auth, host: AWAY });
  ok("compute refuses a request not addressed to this machine", r.status === 403, r.status);
  r = await fetch(`${B}/briefs`, { headers: auth });
  ok("without briefs wired, the route says so", r.status === 503, r.status);
  s3.close();

  // --- off by default ---
  const s2 = mutSync.start({ root, token: () => null });
  await new Promise(r => setTimeout(r, 300));
  r = await fetch(`${B}/mut/sync/hello`, { headers: auth });
  ok("with no token set, it refuses everything authed", r.status === 503, r.status);
  r = await fetch(`${B}/ping`);
  ok("but /ping still answers", r.status === 200, r.status);
  s2.close();

  console.log("\n" + pass + " passed, " + fail + " failed");
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
