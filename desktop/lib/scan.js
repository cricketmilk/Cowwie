// Project scanner.
//
// Point it at a folder and it writes the registry entries, so you never type
// a path or guess a port. Solves the two annoying parts of onboarding a
// project: where it lives and how it starts.
//
// Port detection is deliberately NOT guessed from framework conventions —
// those are wrong often enough to be worse than useless. Instead the shell
// watches the spawned process's stdout for a localhost URL (see main.js) and
// uses whatever it actually printed. Every dev server prints its URL.

const fs = require("node:fs");
const path = require("node:path");

const SKIP = new Set([
  "node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build",
  ".next", ".nuxt", "target", ".cache", "vendor", ".idea", ".vscode",
  "site-packages", ".tox", "coverage",
]);

// Ordered by preference — the first matching script wins. "watch" is
// deliberately absent: in the wild it is usually `tsc -w` or a test watcher,
// which spawns fine, prints no URL, and leaves a zombie compiler behind the
// tile. A project whose only script is "watch" isn't a server.
const DEV_SCRIPTS = ["dev", "start", "serve", "develop"];

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Identify what a single folder is, or null if it isn't a project. */
function identify(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const name = path.basename(dir);

  // --- Node ---------------------------------------------------------------
  if (has("package.json")) {
    const pkg = readJson(path.join(dir, "package.json")) || {};
    const scripts = pkg.scripts || {};
    const script = DEV_SCRIPTS.find((s) => scripts[s]);
    if (script) {
      return {
        kind: "local",
        command: `npm run ${script}`,
        detected: `node · npm run ${script}`,
        name: pkg.name || name,
      };
    }
    // A package.json with no dev script is usually a library, but if there's
    // an index.html it's likely a static prototype.
    if (has("index.html")) {
      return { kind: "static", path: "index.html", detected: "static html", name: pkg.name || name };
    }
    return null;
  }

  // --- Python -------------------------------------------------------------
  if (has("manage.py")) {
    return { kind: "local", command: "python manage.py runserver", detected: "django", name };
  }
  for (const entry of ["app.py", "main.py", "server.py", "run.py", "wsgi.py"]) {
    if (has(entry)) {
      const src = (() => {
        try {
          return fs.readFileSync(path.join(dir, entry), "utf8").slice(0, 4000);
        } catch {
          return "";
        }
      })();
      if (/fastapi|FastAPI/.test(src)) {
        return { kind: "local", command: `uvicorn ${entry.replace(/\.py$/, "")}:app --reload`, detected: "fastapi", name };
      }
      if (/flask|Flask/.test(src)) {
        return { kind: "local", command: `python ${entry}`, detected: "flask", name };
      }
      if (/streamlit/.test(src)) {
        return { kind: "local", command: `streamlit run ${entry}`, detected: "streamlit", name };
      }
      return { kind: "local", command: `python ${entry}`, detected: `python · ${entry}`, name };
    }
  }

  // --- MkDocs -------------------------------------------------------------
  if (has("mkdocs.yml") || has("mkdocs.yaml")) {
    return { kind: "local", command: "mkdocs serve", detected: "mkdocs", name };
  }

  // --- Static -------------------------------------------------------------
  if (has("index.html")) {
    return { kind: "static", path: "index.html", detected: "static html", name };
  }
  for (const sub of ["public", "docs", "src", "site"]) {
    if (fs.existsSync(path.join(dir, sub, "index.html"))) {
      return { kind: "static", path: `${sub}/index.html`, detected: `static html · ${sub}/`, name };
    }
  }

  return null;
}

/** Turn a folder name into a stable registry id. */
function toId(name) {
  return (
    name
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app"
  );
}

/** Title-case a folder name for display: "lil-scrapey" -> "Lil Scrapey". */
function toName(name) {
  return name
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Scan `root` for projects, one level deep by default.
 * Returns registry-ready entries with paths relative to `relativeTo`.
 */
function scan(root, { depth = 1, relativeTo = null, persona = "workshop" } = {}) {
  const found = [];
  const seen = new Set();

  const walk = (dir, level) => {
    if (level > depth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (seen.has(full)) continue;

      const info = identify(full);
      if (info) {
        seen.add(full);
        const rel = relativeTo
          ? path.relative(relativeTo, full).split(path.sep).join("/")
          : full;

        const entry = {
          id: toId(e.name),
          name: toName(info.name || e.name),
          kind: info.kind,
          // Filesystem access is scoped to the project's own folder.
          root: rel,
          capabilities: ["store", "fs"],
          persona,
          detected: info.detected,
        };
        if (info.kind === "local") {
          entry.command = info.command;
          entry.cwd = rel;
          // No url: main.js reads it from the process's own stdout.
        } else {
          entry.path = `${rel}/${info.path}`;
        }
        found.push(entry);
      } else {
        walk(full, level + 1);
      }
    }
  };

  walk(path.resolve(root), 1);
  return found;
}

module.exports = { scan, identify, toId, toName, SKIP };
