// Where THIS machine keeps its project folders.
//
// A registry path may carry the same ${NAME} placeholders a url can --
// "${ROOST}/Glamoire" -- so one committed apps.config.json can serve more than
// one machine. The values come from shell/roots.json, which is gitignored.
//
// Not secrets.json, and the distinction is not fussiness. That file exists so a
// token never enters git history; nothing is protected by hiding C:\, and the
// moment a path lives there the file's rule quietly becomes "things that vary
// by machine" -- after which somebody puts a real secret in the registry
// because "the secrets file is just paths now".
//
// The two also need OPPOSITE failures. An unresolved ${TOKEN} must stay literal
// and complain, because a tile that fails loudly beats one that loads the wrong
// thing. An unresolved ${ROOST} on a machine that never wrote a roots.json must
// quietly fall back to C:\, so a fresh clone boots without a setup step. And a
// root can be read once and cached, where a secret is deliberately re-read on
// every call so that rotating one needs no restart.
//
// This lives in lib/ rather than main.js so it can be tested without Electron.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SHELL_ROOT = path.resolve(__dirname, "..");
const ROOTS_FILE = path.join(SHELL_ROOT, "roots.json");

// ROOST is the folder outside projects (Kenoma, Haruspex) sit beside each
// other in. On Windows that is the drive root, because that is where they
// live. SHELL is this desktop folder: Ifreglen's own apps live under
// ${SHELL}/apps, unlike the platform it came from.
const DEFAULT_ROOTS = {
  ROOST: process.platform === "win32" ? "C:" : path.join(os.homedir(), "projects"),
  SHELL: SHELL_ROOT,
  HOME: os.homedir(),
};

// The substitution itself, shared with main.js's resolveSecrets. The two differ
// only in where values come from and what an unknown name means, so that is all
// a caller supplies.
function interpolate(str, lookup) {
  if (typeof str !== "string" || !str.includes("${")) return str;
  return str.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, name) => {
    const v = lookup(name);
    return v == null ? whole : v;
  });
}

let cache = null;
function roots() {
  if (cache) return cache;
  let file = {};
  try { file = JSON.parse(fs.readFileSync(ROOTS_FILE, "utf8")); } catch {}
  const out = { ...DEFAULT_ROOTS };
  // $-prefixed keys are the file's own prose, the way the registry does it.
  for (const [k, v] of Object.entries(file)) if (k[0] !== "$" && typeof v === "string") out[k] = v;
  // The environment wins, so a one-off run can point at another tree without
  // editing a file: IFREGLEN_ROOST=D:/dev npm start. The old XIXOXIS_ name is
  // still read, so a machine set up for the platform this one came from works.
  for (const k of Object.keys(out)) {
    const v = process.env["IFREGLEN_" + k] || process.env["XIXOXIS_" + k];
    if (v) out[k] = v;
  }
  return (cache = out);
}

// Registry paths are interpolated ONCE, in loadConfig, and not at each of the
// half-dozen path.resolve(ROOT, ...) sites that consume them. A site that
// forgot to call this would resolve a literal "${ROOST}/Glamoire" against the
// shell folder and report a missing directory nobody asked about.
function resolveRoots(str) {
  if (typeof str !== "string" || !str.includes("${")) return str;
  const r = roots();
  return interpolate(str, (name) => {
    if (r[name] != null) return r[name];
    console.warn(`[roost] unresolved root \${${name}} — name it in shell/roots.json`);
    return null;
  });
}

// Tests only: forget the cached file.
function _reset() { cache = null; }

module.exports = { interpolate, roots, resolveRoots, ROOTS_FILE, DEFAULT_ROOTS, _reset };
