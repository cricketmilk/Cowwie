// Unit tests for lib/busstream.js, over real HTTP.
// Run: cd shell && node lib/busstream-test.js
const http = require("node:http");
const { createBusStream } = require("./busstream");

let pass = 0, fail = 0;
function ok(label, cond, extra) { if (cond) { pass++; console.log("  ok  ", label); } else { fail++; console.log("  FAIL", label, extra ?? ""); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A listener that parses the stream into [{event, id, data}].
function listen(port, query = "", headers = {}) {
  const got = [];
  let buf = "";
  const req = http.get({ host: "127.0.0.1", port, path: "/bus/stream" + query, headers }, (res) => {
    got.status = res.statusCode;
    res.setEncoding("utf8");
    res.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = { event: "message" };
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) { ev.comment = true; continue; }
          const k = line.slice(0, line.indexOf(":")), v = line.slice(line.indexOf(":") + 1).trimStart();
          if (k === "event") ev.event = v; else if (k === "id") ev.id = Number(v); else if (k === "data") ev.data = JSON.parse(v);
        }
        if (!ev.comment) got.push(ev);
      }
    });
  });
  req.on("error", () => {});
  got.close = () => req.destroy();
  return got;
}

(async () => {
  const bus = createBusStream({ max: 5, heartbeatMs: 200, maxClients: 3 });
  const srv = http.createServer((req, res) => { const url = new URL(req.url, "http://x"); bus.handle(req, res, url); });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  const all = listen(port);
  const some = listen(port, "?topics=haruspex.*,brain.request");
  const brain = listen(port, "?me=brain");
  await sleep(150);
  ok("a listener is greeted with where the stream is and which run this is", all[0] && all[0].event === "hello" && all[0].data.seq === 0 && all[0].data.boot === bus.boot);

  bus.push({ topic: "haruspex.threat", payload: { ip: "10.0.0.9" }, from: "haruspex" });
  bus.push({ topic: "app.started", payload: { id: "forge" } });
  bus.push({ topic: "brain.request", payload: { power: "atlas", verb: "map" }, from: "kixen" });
  bus.push({ topic: "brain.finding.created", payload: { id: 1 }, from: "brain" });
  await sleep(150);
  const evs = (g) => g.filter((e) => e.event === "bus");
  ok("everything reaches a listener with no filter, in order, with ids", evs(all).map((e) => e.id).join() === "1,2,3,4" && evs(all)[0].data.topic === "haruspex.threat" && evs(all)[1].data.from === "shell");
  ok("a topic filter (and a prefix) keeps only those", evs(some).map((e) => e.data.topic).join() === "haruspex.threat,brain.request");
  ok("?me= drops the listener's own publishes", evs(brain).length === 3 && !evs(brain).some((e) => e.data.from === "brain"));

  ok("a fourth listener over the cap is refused", await new Promise((r) => { const g = listen(port); setTimeout(() => { r(g.status === 503); g.close(); }, 150); }));
  some.close(); brain.close();
  await sleep(100);
  ok("a listener that leaves is let go", bus.listeners() === 1);

  const back = listen(port, "", { "Last-Event-ID": "2" });
  await sleep(150);
  ok("a reconnect with Last-Event-ID is given what it missed", evs(back).map((e) => e.id).join() === "3,4");
  back.close();
  const q = listen(port, "?since=3");
  await sleep(150);
  ok("so is ?since=", evs(q).map((e) => e.id).join() === "4");
  q.close();

  for (let i = 0; i < 6; i++) bus.push({ topic: "tick", payload: i });
  const old = listen(port, "?since=0");
  await sleep(150);
  ok("the ring keeps only the last few", evs(old).length === 5 && evs(old)[0].id === 6);
  old.close();
  const stale = listen(port, "?since=99999");
  await sleep(150);
  ok("a cursor from an earlier run of the shell is given this run's ring", evs(stale).length === 5);
  stale.close();

  await sleep(350);
  ok("the stream stays open across heartbeats", !all.closed && bus.listeners() >= 1);
  all.close();
  srv.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
