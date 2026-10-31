// The Wilds — the browsing surface's memory.
//
// Deliberately Electron-free. Everything here is pure state and pure string
// work: what the omnibox does with what you typed, where you have been, what
// you pinned, which tabs were open last time. The main process owns the views;
// this owns the parts that must survive a restart, and it can be unit-tested
// without booting a window (lib/roam-test.js).
//
// Why history lives HERE and not in the Trove: the Trove is evidence. Its
// index is append-only and nothing lands in it that you did not explicitly
// point at — that property is the whole reason it is worth trusting, and a
// browser quietly appending every page you glanced at would destroy it. So
// history is a separate, bounded, rewritable convenience file, and it can be
// switched off entirely ("history": false on the registry entry) or forgotten
// per-persona without touching the archive.

const fs = require("node:fs");
const path = require("node:path");

// Big enough that the omnibox actually remembers things; small enough that the
// file stays a few hundred KB and rewriting it whole costs nothing.
const HISTORY_KEEP = 800;

// Schemes the omnibox will hand to a view. Anything else typed with a scheme
// is treated as a search phrase rather than navigated to — `javascript:` in an
// address bar is a script-injection gesture with a URL costume on, and
// `file:` is only here because pointing the browser at a local build output is
// a thing you genuinely do in this shell.
const NAVIGABLE = new Set(["http:", "https:", "file:", "about:"]);

// Hosts that take a port and no dot — "localhost:5173" must not become a
// search for the phrase "localhost:5173", which is what every naive
// has-a-dot rule does to it.
const BARE_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

const DEFAULT_SEARCH = "https://duckduckgo.com/?q=%s";

// ------------------------------------------------------------------ omnibox

// What you typed -> where to go. Returns { url, searched } so the caller can
// say "searched for X" rather than pretending it navigated somewhere.
//
// The rule, in order: an explicit navigable scheme wins; a protocol-relative
// "//host" is https; a bare host (dotted, or localhost-ish with a port) is a
// host; everything else is a search. Anything with a space in it is a search
// no matter what else it looks like, because "site down again" contains a dot
// often enough to matter.
function resolve(input, searchTemplate = DEFAULT_SEARCH) {
  const raw = String(input == null ? "" : input).trim();
  if (!raw) return { url: "", searched: false };

  // The negative lookahead is load-bearing: without it "localhost:5173" parses
  // as the scheme `localhost:`, fails the navigable check, and gets SEARCHED
  // FOR — which is exactly the gesture a shell full of dev servers makes most
  // often. A colon followed by digits is a port, never a scheme.
  const scheme = /^([a-z][a-z0-9+.\-]*):(?!\d)/i.exec(raw);
  if (scheme) {
    const s = scheme[1].toLowerCase() + ":";
    if (NAVIGABLE.has(s)) return { url: raw, searched: false };
    // A non-navigable scheme is not an address. Fall through to search, which
    // is both safer and what you meant if you pasted "mailto:" into the bar.
    return { url: search(raw, searchTemplate), searched: true, query: raw };
  }

  if (raw.startsWith("//")) return { url: "https:" + raw, searched: false };

  if (!/\s/.test(raw)) {
    // Strip a path/query before judging the host, so "example.com/a b" is
    // still a URL and "what is a.m. time" is still a search.
    const hostPart = raw.split(/[/?#]/)[0];
    const bare = hostPart.replace(/:\d+$/, "").toLowerCase();
    const local = BARE_HOSTS.has(bare) || /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
    // A trailing dot-something that is all digits is a version number, not a
    // TLD: "1.2.3" should search. A single-label host with a port is only a
    // host if it is one of the local ones.
    const dotted = /\.[a-z]{2,}$/i.test(bare);
    if (local) return { url: `http://${raw}`, searched: false };
    if (dotted) return { url: `https://${raw}`, searched: false };
  }

  return { url: search(raw, searchTemplate), searched: true, query: raw };
}

function search(query, template = DEFAULT_SEARCH) {
  const t = template && template.includes("%s") ? template : DEFAULT_SEARCH;
  return t.replace("%s", encodeURIComponent(query));
}

// Shown in the address bar when the view is idle. Full URLs are noise; the
// host is what tells you where you are, and the rest is available on focus.
function prettyHost(url) {
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return "local file";
    return u.host.replace(/^www\./, "") || u.protocol;
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------- state

class Roam {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "state.json");
    this.state = { v: 1, history: [], pins: [], session: [], seeded: [] };
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.state = {
        v: 1,
        history: Array.isArray(raw.history) ? raw.history : [],
        pins: Array.isArray(raw.pins) ? raw.pins : [],
        session: Array.isArray(raw.session) ? raw.session : [],
        seeded: Array.isArray(raw.seeded) ? raw.seeded : [],
      };
    } catch {
      // No file yet, or a half-written one. Either way an empty browser is a
      // working browser — this must never be a reason not to start.
    }
    return this.state;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 600);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // Write-then-rename: a crash mid-write otherwise leaves a truncated file
      // and the next boot silently starts with no history and no pins.
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
    } catch {}
  }

  // ------------------------------------------------------------- history

  // One entry per URL, carrying a visit count and the last time and persona.
  // Deduping on the way in is what makes a small cap feel large: forty visits
  // to one site cost one row, so 800 rows is 800 distinct places.
  visit({ url, title, persona }) {
    if (!url || !/^https?:/i.test(url)) return null;  // file:// and about: are not places
    const h = this.state.history;
    const i = h.findIndex((e) => e.url === url);
    const now = Date.now();
    if (i >= 0) {
      const e = h[i];
      e.t = now;
      e.n = (e.n || 1) + 1;
      if (title) e.title = title;
      if (persona) e.persona = persona;
      h.splice(i, 1);
      h.unshift(e);
    } else {
      h.unshift({ url, title: title || "", t: now, n: 1, persona: persona || null });
      if (h.length > HISTORY_KEEP) h.length = HISTORY_KEEP;
    }
    this.save();
    return h[0];
  }

  // Retitle without counting a visit. Titles arrive after the navigation that
  // recorded the row, so without this every history entry is called by its URL.
  retitle(url, title) {
    if (!url || !title) return;
    const e = this.state.history.find((x) => x.url === url);
    if (e && e.title !== title) { e.title = title; this.save(); }
  }

  forget({ persona, url, all } = {}) {
    const before = this.state.history.length;
    if (all) this.state.history = [];
    else if (url) this.state.history = this.state.history.filter((e) => e.url !== url);
    else if (persona) this.state.history = this.state.history.filter((e) => e.persona !== persona);
    this.save();
    return before - this.state.history.length;
  }

  // ---------------------------------------------------------------- pins

  // A pin may name the cookie jar it belongs in. That is not decoration: a
  // board you are signed into is worthless opened signed-out, and the whole
  // reason these were registry entries rather than bookmarks was that a
  // registry entry could say `persona`. A pin that cannot would be a downgrade.
  pin({ url, title, persona }) {
    if (!url) return this.state.pins;
    const found = this.state.pins.find((p) => p.url === url);
    if (found) {
      // Re-pinning an existing one is how you correct its jar or its name.
      if (persona && found.persona !== persona) { found.persona = persona; this.save(); }
      return this.state.pins;
    }
    this.state.pins.push({ url, title: title || prettyHost(url), persona: persona || null, t: Date.now() });
    this.save();
    return this.state.pins;
  }

  // Pins the registry declares, added once each.
  //
  // Seeding every boot would undo an unpin on the next restart; seeding only
  // what has never been seeded means the registry can grow new pins later and
  // a removed one stays removed. The record of what was seeded is what makes
  // both true at once.
  seed(pins) {
    let added = 0, dirty = false;
    for (const p of pins || []) {
      if (!p || !p.url) continue;
      if (this.state.seeded.includes(p.url)) continue;
      this.state.seeded.push(p.url);
      dirty = true;
      if (!this.state.pins.some((x) => x.url === p.url)) {
        this.state.pins.push({ url: p.url, title: p.title || prettyHost(p.url), persona: p.persona || null, t: Date.now() });
        added += 1;
      }
    }
    if (dirty) this.save();
    return added;
  }

  unpin(url) {
    this.state.pins = this.state.pins.filter((p) => p.url !== url);
    this.save();
    return this.state.pins;
  }

  isPinned(url) {
    return this.state.pins.some((p) => p.url === url);
  }

  // ---------------------------------------------------------- suggestions

  // Omnibox completions: pins first (you chose those), then history ranked by
  // how often and how recently you went there. Matching is a plain substring
  // over host+path+title — fuzzy matching in an address bar mostly produces
  // confident wrong answers.
  suggest(query, limit = 7) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) {
      return this.state.history.slice(0, limit).map((e) => ({ ...e, kind: "history" }));
    }
    const hit = (e) =>
      e.url.toLowerCase().includes(q) || (e.title || "").toLowerCase().includes(q);

    const pins = this.state.pins.filter(hit).map((p) => ({ ...p, kind: "pin" }));
    const now = Date.now();
    const hist = this.state.history
      .filter(hit)
      .map((e) => {
        // Recency in days, visits as a mild multiplier. A place seen twenty
        // times last month should still outrank one seen once last Tuesday.
        const days = (now - (e.t || 0)) / 86400000;
        return { ...e, kind: "history", score: Math.log2(1 + (e.n || 1)) * 4 - days };
      })
      .sort((a, b) => b.score - a.score);

    const seen = new Set(pins.map((p) => p.url));
    return [...pins, ...hist.filter((e) => !seen.has(e.url))].slice(0, limit);
  }

  // -------------------------------------------------------------- session

  // What was open when you last closed it. Stored URL+persona only: rebuilding
  // the views is the main process's job, and storing anything live here would
  // put Electron objects in a JSON file.
  remember(tabs) {
    this.state.session = (tabs || [])
      .filter((t) => t && t.url && /^(https?|file):/i.test(t.url))
      .slice(0, 24)
      .map((t) => ({ url: t.url, persona: t.persona || null, title: t.title || "" }));
    this.save();
    return this.state.session;
  }

  session() {
    return this.state.session.slice();
  }
}

module.exports = { Roam, resolve, search, prettyHost, DEFAULT_SEARCH, HISTORY_KEEP, NAVIGABLE };
