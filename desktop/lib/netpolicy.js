// May a page go direct when Haruspex is not answering?
//
// Every session routes through Haruspex's Egress Guard (main.js
// applyEgressProxy). When it is down, Chromium can fail over to direct:// --
// which keeps pages loading and also sends them out unfiltered and unmasked.
// The rule (2026-10-13): fail over only while this machine is on a VPN AND
// not on a public network. Anything this module cannot establish counts as
// "no": unknown, still checking, helper dead, not Windows.
//
// Windows knows both facts; Node does not. So one PowerShell helper is started
// and KEPT: it answers each "check" line on its stdin with one JSON line on
// stdout, and exits when its stdin closes -- a crashed shell leaves no orphan.
// A PowerShell per poll would cost ~0.5 s of CPU each time; the helper costs
// a few CIM queries per check. Checks are asked for when os.networkInterfaces()
// changes (cheap, polled here) and once a minute (a network's category can
// change without its addresses changing). The moment the interfaces change,
// the answer drops to "no" until the check comes back, so a VPN that has just
// gone away is never trusted for the seconds it takes to notice.
//
// Restarts of the helper are budgeted (3 in 10 minutes, backing off): a helper
// that keeps dying leaves the answer at "no" and says so, rather than being
// respawned forever. That is the lesson Haruspex's watchdog taught the same day.
//
// Electron-free, like lib/roam.js, so lib/netpolicy-test.js can drive
// classify() with no window.
const { spawn } = require("node:child_process");
const os = require("node:os");

// Adapters that carry a tunnel. Positive identification only: an adapter this
// does not recognise is not a VPN, which errs toward failing closed.
// AVG Secure VPN shows as "AVG Secure VPN WireGuard Adapter" / "...Wintun
// Adapter", Bitdefender's as "Bitdefender TAP Adapter", Windows' own VPNs as
// "WAN Miniport (IKEv2)" etc. on a PPP interface.
const VPN_ADAPTER = /VPN|WireGuard|Wintun|\bTAP\b|OpenVPN|Tunnel|WAN Miniport|\bPPP\b|NordLynx|SecureLine/i;
// NetConnectionProfile.NetworkCategory, as a number when PowerShell 5.1's
// ConvertTo-Json flattens the enum.
const CATEGORY = { 0: "Public", 1: "Private", 2: "DomainAuthenticated" };

const HELPER = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "while ($null -ne ($line = [Console]::In.ReadLine())) {",
  "$a = @(Get-NetAdapter | Select-Object ifIndex, Name, InterfaceDescription, Status, HardwareInterface)",
  "$r = @(Get-NetRoute -DestinationPrefix 0.0.0.0/0,0.0.0.0/1,128.0.0.0/1,::/0,::/1,8000::/1 | Select-Object InterfaceIndex, DestinationPrefix, RouteMetric, InterfaceMetric)",
  "$p = @(Get-NetConnectionProfile | Select-Object InterfaceIndex, Name, @{n='Category';e={[string]$_.NetworkCategory}})",
  "[Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 3 -InputObject @{ adapters = $a; routes = $r; profiles = $p }))",
  "}",
].join("; ").replace("{; ", "{ ").replace("; }", " }");

const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const held = (why) => ({ known: true, allowed: false, why });

// One snapshot from the helper in, a verdict out. Pure, for the tests.
function classify(snap) {
  const adapters = new Map(arr(snap && snap.adapters).map((a) => [a.ifIndex, a]));
  if (!adapters.size) return held("Windows listed no network adapters");
  const up = (i) => String((adapters.get(i) || {}).Status) === "Up";
  const tunnel = (a) => !!a && VPN_ADAPTER.test(`${a.Name || ""} ${a.InterfaceDescription || ""}`);
  const name = (r) => (adapters.get(r.InterfaceIndex) || {}).Name || `interface ${r.InterfaceIndex}`;

  // The way out to the internet: the most specific default-ish route, then the
  // cheapest. A full-tunnel VPN installs 0.0.0.0/1 + 128.0.0.0/1 precisely so
  // they beat the LAN's 0.0.0.0/0.
  const plen = (r) => Number(String(r.DestinationPrefix).split("/")[1]) || 0;
  const cost = (r) => (Number(r.RouteMetric) || 0) + (Number(r.InterfaceMetric) || 0);
  const internet = (v6) => arr(snap.routes)
    .filter((r) => String(r.DestinationPrefix).includes(":") === v6 && up(r.InterfaceIndex))
    .sort((a, b) => plen(b) - plen(a) || cost(a) - cost(b))[0] || null;
  const v4 = internet(false), v6 = internet(true);
  if (!v4 && !v6) return held("no route to the internet");
  if (v4 && !tunnel(adapters.get(v4.InterfaceIndex))) return held(`not on a VPN: the internet goes out through ${name(v4)}`);
  if (v6 && !tunnel(adapters.get(v6.InterfaceIndex))) return held(`IPv6 goes out through ${name(v6)}, outside the VPN`);
  const vpn = name(v4 || v6);

  // Public: the category Windows gave the networks the machine is physically
  // on. A VPN's own adapter is usually "Public" too, and a Hyper-V switch is an
  // unidentified (public) network that is no network at all, so only hardware
  // adapters count.
  const cat = (p) => CATEGORY[p.Category] || String(p.Category);
  const physical = arr(snap.profiles).filter((p) => {
    const a = adapters.get(p.InterfaceIndex);
    return a && a.HardwareInterface === true && !tunnel(a) && up(p.InterfaceIndex);
  });
  if (!physical.length) return held(`on ${vpn}, but the network under it could not be told`);
  const open = physical.filter((p) => cat(p) !== "Private" && cat(p) !== "DomainAuthenticated");
  if (open.length) return held(`on ${vpn}, but on a public network: ${open.map((p) => `${p.Name} (${cat(p)})`).join(", ")}`);
  return { known: true, allowed: true, why: `on ${vpn} over ${physical.map((p) => p.Name).join(", ")} (private)` };
}

class NetPolicy {
  constructor({ onChange = () => {}, log = console.log, spawnImpl = spawn, everyMs = 60000, pollMs = 3000 } = {}) {
    this.onChange = onChange;
    this.log = log;
    this.spawnImpl = spawnImpl;
    this.everyMs = everyMs;
    this.pollMs = pollMs;
    this.state = { known: false, allowed: false, why: "not checked yet" };
    this.child = null;
    this.timers = [];
    this.restarts = [];
    this.pending = false;
    this.again = false;
    this.stopped = false;
    this.ifaces = null;
  }

  allowed() { return this.state.allowed === true; }
  status() { return { ...this.state }; }

  start() {
    if (process.platform !== "win32") {
      this._set({ known: true, allowed: false, why: "no VPN check on this platform, so no direct fallback" });
      return;
    }
    this.ifaces = this._ifaceSig();
    this._spawn();
    this.timers.push(setInterval(() => this._ask(), this.everyMs));
    this.timers.push(setInterval(() => {
      const sig = this._ifaceSig();
      if (sig === this.ifaces) return;
      this.ifaces = sig;
      // Stop trusting the old answer the moment the network moves.
      if (this.state.allowed) this._set({ known: false, allowed: false, why: "network changed; checking again" });
      this._ask();
    }, this.pollMs));
    for (const t of this.timers) if (t.unref) t.unref();
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers = [];
    const c = this.child;
    this.child = null;
    if (c) {
      try { c.stdin.end(); } catch {}
      const k = setTimeout(() => { try { c.kill(); } catch {} }, 2000);
      if (k.unref) k.unref();
    }
  }

  _ifaceSig() {
    try {
      return JSON.stringify(Object.entries(os.networkInterfaces()).map(([n, list]) => [n, (list || []).map((x) => x.address).sort()]).sort());
    } catch { return null; }
  }

  _spawn() {
    let c;
    try {
      c = this.spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", HELPER],
        { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch (e) {
      this._set({ known: false, allowed: false, why: `network check could not start: ${e.message}` });
      return;
    }
    this.child = c;
    this.pending = false;
    let buf = "";
    c.stdout.setEncoding("utf8");
    c.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this._answer(line);
      }
    });
    c.on("error", () => {});
    c.stdin.on("error", () => {});
    c.on("exit", (code) => {
      if (this.child === c) this.child = null;
      if (this.stopped) return;
      this._set({ known: false, allowed: false, why: `network check stopped (exit ${code})` });
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 10 * 60 * 1000);
      if (this.restarts.length >= 3) {
        this.log("[egress] the network check keeps stopping; direct fallback stays off until the shell restarts");
        return;
      }
      this.restarts.push(now);
      const t = setTimeout(() => { if (!this.stopped) { this._spawn(); } }, [5000, 30000, 120000][this.restarts.length - 1]);
      if (t.unref) t.unref();
      this.timers.push(t);
    });
    this._ask();
  }

  _ask() {
    if (!this.child) return;
    if (this.pending) { this.again = true; return; }
    this.pending = true;
    try { this.child.stdin.write("check\n"); } catch { this.pending = false; return; }
    // An answer that never comes means a wedged helper: end it, and the exit
    // handler restarts it within the budget.
    clearTimeout(this.deadline);
    const c = this.child;
    this.deadline = setTimeout(() => { if (this.pending && this.child === c) { try { c.kill(); } catch {} } }, 20000);
    if (this.deadline.unref) this.deadline.unref();
  }

  _answer(line) {
    this.pending = false;
    clearTimeout(this.deadline);
    let st;
    try { st = classify(JSON.parse(line)); }
    catch (e) { st = { known: false, allowed: false, why: `network check unreadable: ${e.message}` }; }
    this._set(st);
    if (this.again) { this.again = false; this._ask(); }
  }

  _set(st) {
    const before = this.state;
    this.state = st;
    if (st.why !== before.why) this.log(`[egress] direct fallback ${st.allowed ? "ALLOWED" : "off"}: ${st.why}`);
    if (st.allowed !== before.allowed) {
      try { this.onChange(this.status()); } catch (e) { this.log(`[egress] fallback change handler failed: ${e.message}`); }
    }
  }
}

module.exports = { NetPolicy, classify, VPN_ADAPTER, HELPER };
