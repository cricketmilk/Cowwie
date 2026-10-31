// Project absorption — point the shell at an outside folder and make it a
// first-class app without moving it.
//
// Absorbed apps stay in their own folders, keep their own repos, and remain
// editable independently. The shell only writes a registry entry and (if asked)
// a ifreglen-apps.json manifest inside the project so the app can travel.

const fs = require("node:fs");
const path = require("node:path");
const { identify, toId, toName } = require("./scan");

const SHELL_ROOT = path.resolve(__dirname, "..");
const PLATFORM_ROOT = path.resolve(SHELL_ROOT, "..");

function isInsidePlatform(abs) {
  const p = path.resolve(abs);
  const platform = path.resolve(PLATFORM_ROOT);
  return p === platform || p.startsWith(platform + path.sep);
}

function validateId(id) {
  return typeof id === "string" && /^[a-z0-9-]+$/.test(id) && id.length > 0 && id.length <= 64;
}

/** Trim and slug a candidate id so it always passes validateId. */
function sanitizeId(raw) {
  let id = String(raw)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) id = "app";
  if (id.length > 64) id = id.slice(0, 64).replace(/-+$/, "");
  if (!validateId(id)) id = "app";
  return id;
}

function uniqueId(base, existingIds) {
  let id = base;
  let counter = 2;
  while (existingIds.has(id) || !validateId(id)) {
    const suffix = `-${counter}`;
    const head = base.slice(0, Math.max(1, 64 - suffix.length)).replace(/-+$/, "");
    id = `${head}${suffix}`;
    counter++;
  }
  return id;
}

/**
 * Default capabilities for an absorbed app.
 *
 * Absorbed projects become ordinary citizens: they can store state, talk on the
 * bus, and open links externally. Local and static apps also get scoped fs so
 * they can read and write their own folder. They do NOT get launcher-only
 * powers (apps), the audit surface (ledger/captures), or auto-injection
 * (capture) by default — those are opt-in.
 */
function nativeCaps(kind) {
  const caps = ["store", "bus", "shell"];
  if (kind === "static" || kind === "local") caps.push("fs");
  return caps;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function relToShell(abs) {
  const rel = path.relative(SHELL_ROOT, path.resolve(abs));
  if (rel.startsWith("..")) return path.resolve(abs);
  return rel.split(path.sep).join("/");
}

/**
 * Absorb a single outside project folder.
 *
 * @param {string} projectDir
 * @param {object} options
 * @param {Set<string>} [options.existingIds]  ids already in the registry
 * @param {string} [options.id]                preferred id (validated / uniquified)
 * @param {string} [options.name]              preferred display name
 * @param {string} [options.persona]           persona tag
 * @param {string[]} [options.capabilities]    override default capabilities
 * @param {boolean} [options.writeManifest=true] write ifreglen-apps.json in the project
 * @param {boolean} [options.writeNote=true]   write ROOST.md in the project
 * @returns {object} { entry, info, manifestWritten, manifestPath, noteWritten, notePath }
 */
function absorb(projectDir, options = {}) {
  const dryRun = options.dryRun === true;
  const dir = path.resolve(projectDir);
  if (!fs.existsSync(dir)) throw new Error(`project folder not found: ${dir}`);
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) throw new Error(`not a folder: ${dir}`);
  if (isInsidePlatform(dir)) {
    throw new Error("cannot absorb a folder inside the platform tree — projects must live outside ifreglen/");
  }

  const info = identify(dir);
  if (!info) throw new Error(`unrecognized project type in ${dir}`);

  const existingIds = options.existingIds || new Set();
  const preferredId = options.id || toId(path.basename(dir));
  const baseId = validateId(preferredId)
    ? preferredId
    : sanitizeId(options.id ? toId(path.basename(dir)) : preferredId);
  const id = uniqueId(baseId, existingIds);
  const name = options.name || toName(info.name || path.basename(dir));

  const entry = {
    id,
    name,
    kind: info.kind,
    capabilities: options.capabilities || nativeCaps(info.kind),
    persona: options.persona || "workshop",
    detected: info.detected,
  };

  if (info.kind === "local") {
    entry.command = info.command;
    entry.cwd = relToShell(dir);
    entry.root = relToShell(dir);
  } else if (info.kind === "static") {
    entry.path = relToShell(path.join(dir, info.path));
    entry.root = relToShell(dir);
  } else if (info.kind === "external") {
    entry.url = info.url;
  }

  const result = { entry, info, manifestWritten: false, manifestPath: null, noteWritten: false, notePath: null };

  if (!dryRun && options.writeManifest !== false) {
    const manifestPath = path.join(dir, "ifreglen-apps.json");
    if (!fs.existsSync(manifestPath)) {
      const manifestApp = {
        id,
        name,
        kind: info.kind,
        capabilities: entry.capabilities,
        persona: entry.persona,
      };
      if (info.kind === "local") {
        manifestApp.cwd = ".";
        manifestApp.command = info.command;
      } else if (info.kind === "static") {
        manifestApp.path = info.path;
        manifestApp.root = ".";
      } else if (info.kind === "external") {
        manifestApp.url = info.url;
      }
      const manifest = {
        $comment: "This project is absorbed by the Ifreglen shell. Edit id/name/capabilities with care.",
        apps: [manifestApp],
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
      result.manifestWritten = true;
      result.manifestPath = manifestPath;
    }
  }

  if (!dryRun && options.writeNote !== false) {
    const notePath = path.join(dir, "ROOST.md");
    if (!fs.existsSync(notePath)) {
      const note = `# ${name} in Ifreglen

This project has been absorbed into the Ifreglen shell as app \`${id}\`.

It remains an independent folder and git repo. The shell only stores a path to it.

## Communicating with the platform

Inside Ifreglen, \`window.roost\` is available with these capabilities:

${entry.capabilities.map((c) => `- \`${c}\``).join("\n")}

Example:

\`\`\`js
if (window.roost) {
  await window.roost.bus.pub("my-event", { hello: "from ${id}" });
  window.roost.bus.sub("system:app.started", ({ id }) => console.log(id, "started"));
}
\`\`\`
`;
      fs.writeFileSync(notePath, note, "utf8");
      result.noteWritten = true;
      result.notePath = notePath;
    }
  }

  return result;
}

module.exports = { absorb, nativeCaps, validateId };
