// Unit tests for lib/netpolicy.js: the rule for when a page may go direct
// with Haruspex down. No Electron. The last block runs the real PowerShell
// helper against this machine (Windows only) and prints what it decided.
// Run: cd shell && node lib/netpolicy-test.js
const { classify, NetPolicy } = require("./netpolicy");

let pass = 0, fail = 0;
function ok(label, cond, got) {
  if (cond) { pass++; console.log("  ok  ", label); }
  else { fail++; console.log("  FAIL", label, got === undefined ? "" : `-> ${JSON.stringify(got)}`); }
}

// This laptop on 2026-10-13: AVG Secure VPN (WireGuard) carrying the
// internet over the "Guest 4" Wi-Fi, which Windows calls Public.
const WIFI = { ifIndex: 5, Name: "Wi-Fi", InterfaceDescription: "Intel(R) Wi-Fi 6E AX211 160MHz", Status: "Up", HardwareInterface: true };
const AVG = { ifIndex: 44, Name: "AVG Secure VPN WireGuard", InterfaceDescription: "AVG Secure VPN WireGuard Adapter", Status: "Up", HardwareInterface: false };
const VETH = { ifIndex: 60, Name: "vEthernet (Default Switch)", InterfaceDescription: "Hyper-V Virtual Ethernet Adapter", Status: "Up", HardwareInterface: false };
const lan = { InterfaceIndex: 5, DestinationPrefix: "0.0.0.0/0", RouteMetric: 0, InterfaceMetric: 60 };
const split = [
  { InterfaceIndex: 44, DestinationPrefix: "0.0.0.0/1", RouteMetric: 5, InterfaceMetric: 5 },
  { InterfaceIndex: 44, DestinationPrefix: "128.0.0.0/1", RouteMetric: 5, InterfaceMetric: 5 },
];
const prof = (cat, name = "Guest 4", i = 5) => ({ InterfaceIndex: i, Name: name, Category: cat });
const vpnProfile = prof("Public", "AVG Secure VPN WireGuard", 44);

let v = classify({ adapters: [WIFI, AVG], routes: [lan, ...split], profiles: [prof("Private", "Home"), vpnProfile] });
ok("VPN carrying the internet over a private network: allowed", v.allowed === true, v);

v = classify({ adapters: [WIFI, AVG], routes: [lan, ...split], profiles: [prof("Public"), vpnProfile] });
ok("VPN, but the Wi-Fi under it is public: held", v.allowed === false && /public network/.test(v.why), v);

v = classify({ adapters: [WIFI], routes: [lan], profiles: [prof("Private", "Home")] });
ok("no VPN, private network: held", v.allowed === false && /not on a VPN/.test(v.why), v);

v = classify({ adapters: [WIFI, { ...AVG, Status: "Disconnected" }], routes: [lan, ...split], profiles: [prof("Private", "Home")] });
ok("a VPN adapter that is down does not count", v.allowed === false && /not on a VPN/.test(v.why), v);

v = classify({ adapters: [WIFI, AVG], routes: [lan, ...split, { InterfaceIndex: 5, DestinationPrefix: "::/0", RouteMetric: 0, InterfaceMetric: 60 }], profiles: [prof("Private", "Home")] });
ok("IPv6 going out around the VPN: held", v.allowed === false && /IPv6/.test(v.why), v);

v = classify({ adapters: [WIFI, AVG, VETH], routes: [lan, ...split], profiles: [prof("Private", "Home"), vpnProfile, prof("Public", "Unidentified network", 60)] });
ok("a Hyper-V switch's 'public' network does not count", v.allowed === true, v);

v = classify({ adapters: [WIFI, AVG], routes: [lan, ...split], profiles: [prof(1, "Home"), vpnProfile] });
ok("numeric categories (1 = Private) are understood", v.allowed === true, v);
v = classify({ adapters: [WIFI, AVG], routes: [lan, ...split], profiles: [prof(0), vpnProfile] });
ok("numeric categories (0 = Public) are understood", v.allowed === false, v);

v = classify({ adapters: [WIFI, AVG], routes: [lan, ...split], profiles: [vpnProfile] });
ok("on a VPN with no readable network under it: held", v.allowed === false, v);

ok("an empty snapshot is held, not allowed", classify({}).allowed === false && classify(null).allowed === false);
ok("no internet route: held", classify({ adapters: [WIFI], routes: [], profiles: [prof("Private")] }).allowed === false);

const UNKNOWN = { ...AVG, Name: "Ethernet 3", InterfaceDescription: "Some Unknown Virtual NIC" };
v = classify({ adapters: [WIFI, UNKNOWN], routes: [lan, ...split], profiles: [prof("Private", "Home")] });
ok("an adapter it does not recognise is not a VPN", v.allowed === false, v);

// The watcher, with a fake helper: answers drive state; the change handler
// fires only on a flip; a helper that keeps dying is given up on.
const { EventEmitter } = require("node:events");
function fakeSpawn(script) {
  return () => {
    const c = new EventEmitter();
    c.stdin = new EventEmitter();
    c.stdin.write = () => { const next = script.shift(); if (next === "die") setImmediate(() => c.emit("exit", 1)); else if (next) setImmediate(() => c.stdout.emit("data", JSON.stringify(next) + "\n")); return true; };
    c.stdin.end = () => {};
    c.stdout = new EventEmitter();
    c.stdout.setEncoding = () => {};
    c.kill = () => {};
    return c;
  };
}

(async () => {
  const snapOk = { adapters: [WIFI, AVG], routes: [lan, ...split], profiles: [prof("Private", "Home"), vpnProfile] };
  const snapPublic = { adapters: [WIFI, AVG], routes: [lan, ...split], profiles: [prof("Public"), vpnProfile] };
  if (process.platform === "win32") {
    const flips = [];
    const p = new NetPolicy({ spawnImpl: fakeSpawn([snapOk, snapPublic]), log: () => {}, onChange: (s) => flips.push(s.allowed), everyMs: 1e9, pollMs: 1e9 });
    ok("starts held, before any answer", p.allowed() === false);
    p.start();
    await new Promise((r) => setTimeout(r, 30));
    ok("an allowed answer allows", p.allowed() === true, p.status());
    p._ask();
    await new Promise((r) => setTimeout(r, 30));
    ok("a later public answer holds again", p.allowed() === false, p.status());
    ok("the change handler fired once per flip", JSON.stringify(flips) === "[true,false]", flips);
    p.stop();

    // Three restarts already spent inside ten minutes; the helper dies again.
    const lines = [];
    const q = new NetPolicy({ spawnImpl: fakeSpawn(["die"]), log: (l) => lines.push(l), everyMs: 1e9, pollMs: 1e9 });
    q.restarts = [Date.now(), Date.now(), Date.now()];
    q.start();
    await new Promise((r) => setTimeout(r, 30));
    ok("a helper that dies leaves it held", q.allowed() === false && /stopped/.test(q.status().why), q.status());
    ok("past its budget the helper is not restarted, and it says so",
      q.child === null && q.timers.length === 2 && lines.some((l) => /keeps stopping/.test(l)), { timers: q.timers.length, lines });
    q.stop();

    // The real helper, on this machine, once.
    const real = new NetPolicy({ log: () => {}, everyMs: 1e9, pollMs: 1e9 });
    const t = Date.now();
    real.start();
    while (!real.status().known && Date.now() - t < 20000) await new Promise((r) => setTimeout(r, 100));
    const s = real.status();
    ok("the real PowerShell helper answers", s.known === true, s);
    console.log(`        this machine, ${Date.now() - t} ms: direct fallback ${s.allowed ? "ALLOWED" : "off"} -- ${s.why}`);
    real.stop();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
