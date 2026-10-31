// Manifest importer for outside projects files.
//
// A ifreglen-apps.json file describes one or more apps that should live in the
// shell. Paths inside the manifest are relative to the manifest file's own
// directory, so the manifest can travel with its projects.
//
// The platform still holds only paths — this never copies app code into shell/.
// Imported apps become ordinary registry entries, so they work with the rail,
// palette, capture, clip, bus, live reload, and hibernation without any extra
// glue.

const fs = require("node:fs");
const path = require("node:path");
const { identify, toId, toName } = require("./scan");

const SHELL_ROOT = __dirname;
const PLATFORM_ROOT = path.resolve(SHELL_ROOT, "..");

function isInsidePlatform(abs) {
  const p = path.resolve(abs);
  const shell = path.resolve(SHELL_ROOT);
  const platform = path.resolve(PLATFORM_ROOT);
  return p === shell || p.startsWith(shell + path.sep) ||
         p === platform || p.startsWith(platform + path.sep);
}

function validateId(id) {
  return typeof id === "string" && /^[a-z0-9-]+$/.test(id) && id.length > 0 && id.length <= 64;
}

function readManifest(manifestPath) {
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("manifest must be a JSON object");
  if (!Array.isArray(raw.apps)) throw new Error("manifest must contain an 'apps' array");
  return raw;
}

function resolveRel(value, manifestDir) {
  if (typeof value !== "string" || !value) return null;
  return path.resolve(manifestDir, value);
}

function autoDetect(entry, manifestDir) {
  // A manifest can declare just a folder and ask us to figure out the rest.
  const dir = entry.cwd
    ? path.resolve(manifestDir, entry.cwd)
    : entry.root
      ? path.resolve(manifestDir, entry.root)
      : entry.path
        ? path.resolve(manifestDir, path.dirname(entry.path))
        : null;

  if (!dir) throw new Error(`cannot auto-detect '${entry.id}': no path/root/cwd provided`);
  if (!fs.existsSync(dir)) throw new Error(`cannot auto-detect '${entry.id}': folder not found: ${dir}`);

  const info = identify(dir);
  if (!info) throw new Error(`cannot auto-detect '${entry.id}': unrecognized project type in ${dir}`);

  const out = { ...entry, kind: info.kind, detected: info.detected };
  if (info.kind === "local") {
    out.command = info.command;
    out.cwd = entry.cwd || path.relative(manifestDir, dir) || ".";
  } else {
    out.path = entry.path || path.join(path.relative(manifestDir, dir), info.path).split(path.sep).join("/");
    if (!entry.root) out.root = path.relative(manifestDir, dir) || ".";
  }
  return out;
}

function resolveEntry(entry, manifestDir) {
  if (!entry || typeof entry !== "object") throw new Error("app entry must be an object");
  if (!entry.id) throw new Error("app entry missing 'id'");
  if (!validateId(entry.id)) throw new Error(`invalid app id '${entry.id}' — use lowercase letters, numbers, and hyphens only`);

  let resolved = { ...entry };

  if (!resolved.kind || resolved.autoDetect) {
    resolved = autoDetect(resolved, manifestDir);
  }

  // Resolve declared paths relative to the manifest file.
  for (const key of ["path", "root", "cwd", "art"]) {
    if (resolved[key]) resolved[key] = resolveRel(resolved[key], manifestDir);
  }

  // Validate per-kind requirements.
  if (resolved.kind === "static") {
    if (!resolved.path) throw new Error(`static app '${resolved.id}' missing 'path'`);
  } else if (resolved.kind === "local") {
    if (!resolved.command) throw new Error(`local app '${resolved.id}' missing 'command'`);
    if (!resolved.cwd) throw new Error(`local app '${resolved.id}' missing 'cwd'`);
  } else if (resolved.kind === "external") {
    if (!resolved.url) throw new Error(`external app '${resolved.id}' missing 'url'`);
  } else {
    throw new Error(`unknown kind '${resolved.kind}' for '${resolved.id}'`);
  }

  // Enforce platform/app separation. The manifest is for outside projects;
  // shell-internal apps already have their entries in apps.config.json.
  const checkPaths = [];
  if (resolved.path) checkPaths.push(["path", resolved.path]);
  if (resolved.root) checkPaths.push(["root", resolved.root]);
  if (resolved.cwd) checkPaths.push(["cwd", resolved.cwd]);
  for (const [label, p] of checkPaths) {
    if (isInsidePlatform(p)) {
      throw new Error(`'${label}' for '${resolved.id}' resolves inside the platform tree (${path.resolve(p)}) — outside projects must live outside ifreglen/`);
    }
  }

  return resolved;
}

function starterHtml(title) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { margin:0; font-family: system-ui, sans-serif; background:#0f1419;
           color:#e6edf3; display:grid; place-items:center; height:100vh; }
    main { text-align:center; }
    h1 { font-weight:600; letter-spacing:-0.02em; }
    p  { color:#8b98a5; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>Edit <code>index.html</code> and save — the shell reloads automatically.</p>
  </main>
  <script>
    if (window.roost) {
      console.log("running in Ifreglen with:", window.roost.capabilities);
    }
  </script>
</body>
</html>
`;
}

function starterLocal(entry) {
  return `Put your app here. The shell will run:
    ${entry.command}
and read the dev server's URL from its stdout.
`;
}

function scaffoldIfMissing(entry) {
  if (entry.kind === "static") {
    const dir = entry.root || path.dirname(entry.path);
    let createdDir = false;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      createdDir = true;
    }
    if (!fs.existsSync(entry.path)) {
      fs.mkdirSync(path.dirname(entry.path), { recursive: true });
      fs.writeFileSync(entry.path, starterHtml(entry.name || toName(entry.id)), "utf8");
      return { scaffolded: true, createdDir, file: entry.path };
    }
    return { scaffolded: false, createdDir };
  }

  if (entry.kind === "local") {
    const dir = entry.cwd;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "START_HERE.txt"), starterLocal(entry), "utf8");
      return { scaffolded: true, createdDir: true, folder: dir };
    }
  }

  return { scaffolded: false };
}

function relPath(abs, base) {
  try {
    const rel = path.relative(base, abs);
    // On Windows, a different drive throws; fall back to absolute.
    if (rel.startsWith("..")) return abs;
    return rel.split(path.sep).join("/") || ".";
  } catch {
    return abs;
  }
}

function toRegistryEntry(entry) {
  // Convert absolute paths back to relative-to-shell where possible. This keeps
  // the registry portable when the whole tree moves together.
  const out = {
    id: entry.id,
    name: entry.name || toName(entry.id),
    kind: entry.kind,
    capabilities: Array.isArray(entry.capabilities) && entry.capabilities.length
      ? [...entry.capabilities]
      : ["store"],
    persona: entry.persona || "workshop",
  };
  if (entry.group) out.group = entry.group;
  if (entry.note) out.note = entry.note;
  if (entry.art) out.art = relPath(entry.art, SHELL_ROOT);
  if (entry.cohort) out.cohort = entry.cohort;
  if (entry.recipe) out.recipe = entry.recipe;
  if (entry.liveReload === true || entry.liveReload === false) out.liveReload = entry.liveReload;

  if (entry.kind === "static") {
    out.path = relPath(entry.path, SHELL_ROOT);
    if (entry.root) out.root = relPath(entry.root, SHELL_ROOT);
  } else if (entry.kind === "local") {
    out.command = entry.command;
    out.cwd = relPath(entry.cwd, SHELL_ROOT);
    if (entry.url) out.url = entry.url;
  } else if (entry.kind === "external") {
    out.url = entry.url;
  }
  return out;
}

/**
 * Import a manifest file.
 *
 * @param {string} manifestPath
 * @param {object} opts
 * @param {Set<string>} opts.existingIds  ids already in the registry
 * @param {boolean} opts.scaffold         create missing project folders/files
 * @param {boolean} opts.replace          overwrite existing registry entries
 * @returns {object} { added, skipped, errors, scaffolded }
 */
function importManifest(manifestPath, { existingIds = new Set(), scaffold = true, replace = false } = {}) {
  const manifestDir = path.dirname(path.resolve(manifestPath));
  const raw = readManifest(manifestPath);
  const results = { added: [], skipped: [], errors: [], scaffolded: [] };

  for (const entry of raw.apps) {
    try {
      const resolved = resolveEntry(entry, manifestDir);

      if (existingIds.has(resolved.id) && !replace) {
        results.skipped.push({ id: resolved.id, reason: "already registered" });
        continue;
      }

      if (scaffold) {
        const sc = scaffoldIfMissing(resolved);
        if (sc.scaffolded) results.scaffolded.push({ id: resolved.id, ...sc });
      }

      results.added.push(toRegistryEntry(resolved));
    } catch (err) {
      results.errors.push({ id: (entry && entry.id) || "(unknown)", error: String(err.message || err) });
    }
  }

  return results;
}

module.exports = {
  importManifest,
  readManifest,
  _internals: { resolveEntry, toRegistryEntry, isInsidePlatform },
};
