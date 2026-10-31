// Live reload: watch an app's files and fire when they change.
//
// Three kinds of app need three different treatments:
//
//   static   watch the folder, reload the WebContentsView on any change.
//   local    the dev server (vite, next, flask --reload) already pushes its
//            own hot updates; the shell must NOT also reload, or it fights the
//            HMR socket and you get double reloads and lost state. So for
//            local apps we watch nothing by default and let the server drive.
//   external no watching — it's a website.
//
// The watcher is debounced because editors save in bursts (write temp, rename,
// touch mtime) and a naive watch fires 3-5 times per save. It also ignores the
// noise directories that would otherwise wake it constantly.

const fs = require("node:fs");
const path = require("node:path");

const DEBOUNCE_MS = 150;

const IGNORE = new Set([
  "node_modules", ".git", "__pycache__", "dist", "build", ".next",
  ".nuxt", "target", ".cache", "data", "browser-profile", ".venv", "venv",
  "catches", ".claude", "kernels", "congregation", "vault", "edge", "docs",
]);

// Editor scratch files that fire spurious events. Reloading on these means
// reloading on every keystroke in some editors.
const IGNORE_FILE = /(^\.#|~$|\.swp$|\.swx$|\.tmp$|^4913$|\.crswap$)/;

class Watcher {
  constructor(root, onChange, { debounceMs = DEBOUNCE_MS } = {}) {
    this.root = path.resolve(root);
    this.onChange = onChange;
    this.debounceMs = debounceMs;
    this.watchers = [];
    this.timer = null;
    this.closed = false;
  }

  start() {
    if (!fs.existsSync(this.root)) return false;

    // Prefer one recursive watcher — supported on Windows and macOS, which is
    // where this app runs. Fall back to per-directory watchers on platforms
    // (some Linux setups) where recursive isn't available.
    try {
      const w = fs.watch(this.root, { recursive: true }, (_e, file) => this.hit(file));
      w.on("error", () => {});
      this.watchers.push(w);
      return true;
    } catch {
      this.watchManual(this.root);
      return this.watchers.length > 0;
    }
  }

  watchManual(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    try {
      const w = fs.watch(dir, (_e, file) => this.hit(file));
      w.on("error", () => {});
      this.watchers.push(w);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !IGNORE.has(e.name) && !e.name.startsWith(".")) {
        this.watchManual(path.join(dir, e.name));
      }
    }
  }

  hit(file) {
    if (this.closed) return;
    if (file) {
      const base = path.basename(file);
      if (IGNORE_FILE.test(base)) return;
      const parts = file.split(/[/\\]/);
      if (parts.some((p) => IGNORE.has(p))) return;
    }
    // Debounce: collapse a burst of events from one save into a single reload.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.closed) this.onChange();
    }, this.debounceMs);
  }

  stop() {
    this.closed = true;
    clearTimeout(this.timer);
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {}
    }
    this.watchers = [];
  }
}

module.exports = { Watcher };
