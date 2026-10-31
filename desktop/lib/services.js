// Where this shell's own services are listening, written down for the
// processes it did not start.
//
// The phone bridge takes 8793 when it can and walks to 8803 and up when it
// cannot (another shell, most often). Nothing used to say where it had gone,
// so every client went on dialling 8793: the MCP bridge (wilds-mcp.mjs),
// Kenoma's wilds tool, Haruspex, and the failure read as "The Wilds is broken".
//
// Two channels, because the clients come two ways:
//   - an app the shell starts gets IFREGLEN_PORT (and XIXOXIS_PORT, the name
//     Kenoma and Haruspex still read) in its environment (main.js sets both
//     once the server is up, and children inherit them);
//   - anything else -- the MCP bridge Claude Code starts, Lookout run by hand
//     -- reads data/services.json, which this module writes.
//
// The reader every client uses is mutSyncPort() below: the environment first
// (set by the shell at spawn, or by hand, and not second-guessed), then the
// file, then 8793. It is a few lines with no dependencies, so the other repos
// carry a copy rather than a path into this one.
const fs = require("node:fs");
const path = require("node:path");

const SHELL = path.join(__dirname, "..");
let doc = null;

// Merge `patch` into the published document and write it whole. A write that
// fails leaves the last good file in place; the next publish tries again.
function publish(dataDir, patch) {
  doc = { ...(doc || {}), ...patch, v: 1, pid: process.pid, t: Date.now() };
  const file = path.join(dataDir, "services.json");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch {}
  return doc;
}

function mutSyncPort({ shellDir = SHELL, env = process.env } = {}) {
  const e = Number(env.IFREGLEN_PORT || env.XIXOXIS_PORT);
  if (Number.isInteger(e) && e > 0 && e < 65536) return e;
  try {
    const p = Number(JSON.parse(fs.readFileSync(path.join(shellDir, "data", "services.json"), "utf8")).mutSync.port);
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  } catch {}
  return 8793;
}

function mutSyncToken({ shellDir = SHELL, env = process.env } = {}) {
  const e = env.MUT_SYNC_TOKEN;
  if (e && e.length > 16) return e;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(shellDir, "data", "services.json"), "utf8")).mutSync.token;
    if (t && t.length > 16) return t;
  } catch {}
  return null;
}

module.exports = { publish, mutSyncPort, mutSyncToken, _reset: () => { doc = null; } };
