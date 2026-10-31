// Unit tests for lib/services.js.
// Run: cd shell && node lib/services-test.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const services = require("./services");

let pass = 0, fail = 0;
function ok(label, cond, extra) { if (cond) { pass++; console.log("  ok  ", label); } else { fail++; console.log("  FAIL", label, extra ?? ""); } }

const T = fs.mkdtempSync(path.join(os.tmpdir(), "ifreglen-services-"));
const shellDir = path.join(T, "shell"), data = path.join(shellDir, "data");
const file = path.join(data, "services.json");
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));

ok("nothing published and nothing set: the default", services.mutSyncPort({ shellDir, env: {} }) === 8793);

services.publish(data, { mutSync: { port: 8803 } });
ok("publish writes the port, with who wrote it and when", read().mutSync.port === 8803 && read().pid === process.pid && read().v === 1 && Date.now() - read().t < 5000);
ok("a client that only has the file finds the walked port", services.mutSyncPort({ shellDir, env: {} }) === 8803);
ok("an environment the shell (or a person) set wins", services.mutSyncPort({ shellDir, env: { XIXOXIS_PORT: "8811" } }) === 8811);
ok("a nonsense environment value is ignored", services.mutSyncPort({ shellDir, env: { XIXOXIS_PORT: "nope" } }) === 8803);

services.publish(data, { other: { x: 1 } });
ok("a second publish keeps what the first said", read().mutSync.port === 8803 && read().other.x === 1);

fs.writeFileSync(file, "{ not json");
ok("a broken file falls back to the default", services.mutSyncPort({ shellDir, env: {} }) === 8793);
fs.writeFileSync(file, JSON.stringify({ mutSync: { port: 70000 } }));
ok("so does a port that cannot be one", services.mutSyncPort({ shellDir, env: {} }) === 8793);

services._reset();
services.publish(path.join(T, "fresh"), { mutSync: { port: 8793 } });
ok("a data folder that does not exist yet is made", JSON.parse(fs.readFileSync(path.join(T, "fresh", "services.json"), "utf8")).mutSync.port === 8793);

try { fs.rmSync(T, { recursive: true, force: true }); } catch {}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
