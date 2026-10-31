// Sandboxed filesystem access.
//
// Each app gets a root and cannot escape it. The confinement is done by
// resolving the requested path and checking it is still inside the root
// AFTER normalization — checking the raw string for ".." is not enough,
// because symlinks, URL encoding, and Windows short names all get around it.
//
// HARD RULE, enforced in main.js and repeated here: apps of kind "external"
// never receive this capability. A remote page with filesystem access is a
// remote code execution problem wearing a config file. If a registry entry
// declares both, the capability is dropped and a warning is logged.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const MAX_READ = 8 * 1024 * 1024; // 8MB — refuse rather than hang the renderer

class ScopedFs {
  constructor(root) {
    this.root = path.resolve(root);
  }

  /** Resolve a caller-supplied path, or throw if it escapes the root. */
  resolve(rel) {
    if (typeof rel !== "string") throw new Error("path must be a string");
    // Strip any leading separators so "/etc/passwd" is treated as relative.
    const cleaned = rel.replace(/^[/\\]+/, "");
    const target = path.resolve(this.root, cleaned);

    // realpath where it exists, so a symlink pointing outside is caught.
    let check = target;
    try {
      check = fs.realpathSync(target);
    } catch {
      // Doesn't exist yet (a write): check the nearest existing ancestor.
      let dir = path.dirname(target);
      while (dir !== path.dirname(dir)) {
        try {
          check = path.join(fs.realpathSync(dir), path.relative(dir, target));
          break;
        } catch {
          dir = path.dirname(dir);
        }
      }
    }

    const rootReal = (() => {
      try {
        return fs.realpathSync(this.root);
      } catch {
        return this.root;
      }
    })();

    const rel2 = path.relative(rootReal, check);
    if (rel2.startsWith("..") || path.isAbsolute(rel2)) {
      throw new Error(`path escapes app folder: ${rel}`);
    }
    return target;
  }

  async list(rel = ".") {
    const dir = this.resolve(rel);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      dir: e.isDirectory(),
      path: path.relative(this.root, path.join(dir, e.name)).split(path.sep).join("/"),
    }));
  }

  async read(rel, encoding = "utf8") {
    const file = this.resolve(rel);
    const st = await fsp.stat(file);
    if (st.size > MAX_READ) throw new Error(`file too large (${st.size} bytes, max ${MAX_READ})`);
    return await fsp.readFile(file, encoding);
  }

  async write(rel, data) {
    const file = this.resolve(rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, data);
    return { ok: true, bytes: Buffer.byteLength(data) };
  }

  async append(rel, data) {
    const file = this.resolve(rel);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, data);
    return { ok: true };
  }

  async stat(rel) {
    const st = await fsp.stat(this.resolve(rel));
    return { size: st.size, dir: st.isDirectory(), modified: st.mtimeMs };
  }

  async remove(rel) {
    // No recursive delete exposed. An app that can rm -rf its own folder by
    // accident will eventually do it. Single files only.
    const file = this.resolve(rel);
    const st = await fsp.stat(file);
    if (st.isDirectory()) throw new Error("refusing to delete a directory");
    await fsp.unlink(file);
    return { ok: true };
  }
}

module.exports = { ScopedFs, MAX_READ };
