// Briefs and notes: the words that cross between the work apps and the phone.
//
// A BRIEF is something an app on this machine wants the person to know
// wherever they are -- Lookout saw a thing, Credentials has a renewal due,
// Onboarding has a starter waiting on a form. It is filed here (POST /briefs
// from a process holding the bearer, or `briefs.file` on the bus from a hosted
// app), kept in a bounded in-memory list for the phone to poll, and appended
// to data/briefs.jsonl so a restart does not lose the record. The phone marks
// what it has read (POST /briefs/ack).
//
// A NOTE is the other direction: a line typed or spoken into Professional Goat
// that should be on the laptop when the person gets back. Appended to
// data/notes.jsonl; main.js raises it as one of Auri's cards.
//
// Nothing here touches Electron or the network, so it is testable on its own
// (lib/briefs-test.js). Text is treated as untrusted: it is bounded, control
// characters are stripped, and it is only ever displayed -- never handed to a
// model, never put on the bus by this module.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const KEEP = 200;            // briefs held in memory
const PAGE = 50;             // the most a GET /briefs answers with
const NOTES_KEEP = 100;      // notes GET /notes answers with
const LEVELS = new Set(["quiet", "normal", "urgent"]);

const str = (v, n) => (v === undefined || v === null ? "" : String(v)).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, n);
const when = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : Date.now(); };
const id = () => Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");

class Briefs {
  /** @param {string} dataDir where briefs.jsonl and notes.jsonl live */
  constructor(dataDir) {
    this.dir = dataDir;
    this.briefsFile = path.join(dataDir, "briefs.jsonl");
    this.notesFile = path.join(dataDir, "notes.jsonl");
    this.items = [];     // newest first
    this.noteItems = []; // newest first
    this._load();
  }

  // The last KEEP briefs and NOTES_KEEP notes come back from disk at start, so
  // a phone that polls after a restart still sees what it missed. A truncated
  // last line (power loss mid-append) is skipped, not fatal.
  _load() {
    const read = (file) => {
      const out = [];
      try {
        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try { const o = JSON.parse(line); if (o && o.id) out.push(o); } catch {}
        }
      } catch {}
      return out;
    };
    // Acks are their own lines; fold them into the briefs they name, then keep
    // the newest KEEP briefs.
    const all = read(this.briefsFile);
    const acked = new Set(all.filter((x) => x.ack).map((x) => x.ack));
    this.items = all.filter((x) => !x.ack).slice(-KEEP).reverse().map((x) => (acked.has(x.id) ? { ...x, read: true } : x));
    this.noteItems = read(this.notesFile).slice(-NOTES_KEEP).reverse();
  }

  _append(file, obj) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
    } catch {}
  }

  /** File a brief. Returns { ok, brief } or { error }. */
  file(spec) {
    if (!spec || typeof spec !== "object") return { error: "a brief is an object" };
    const source = str(spec.source, 60);
    const title = str(spec.title, 200);
    if (!source) return { error: "a brief needs a source" };
    if (!title) return { error: "a brief needs a title" };
    const level = LEVELS.has(spec.level) ? spec.level : "normal";
    const url = str(spec.url, 2000);
    const brief = {
      id: id(), source, title, body: str(spec.body, 2000), level,
      url: url && /^https?:\/\//i.test(url) ? url : (url && /^[a-z][a-z0-9+.-]*:/i.test(url) ? "" : url) || null,
      when: when(spec.when), read: false,
    };
    this.items.unshift(brief);
    if (this.items.length > KEEP) this.items.length = KEEP;
    this._append(this.briefsFile, brief);
    return { ok: true, brief };
  }

  /** Newest first, at most PAGE, filed after `since` (ms) when given. */
  list(since) {
    const s = Number(since) || 0;
    return this.items.filter((b) => !s || b.when > s).slice(0, PAGE);
  }

  /** Mark briefs read. Returns { ok, acked: n }. */
  ack(ids) {
    const want = new Set((Array.isArray(ids) ? ids : []).map((x) => str(x, 40)).filter(Boolean));
    let n = 0;
    for (const b of this.items) {
      if (want.has(b.id) && !b.read) { b.read = true; n++; this._append(this.briefsFile, { id: id(), ack: b.id, t: Date.now() }); }
    }
    return { ok: true, acked: n };
  }

  /** A note from the phone. Returns { ok, note } or { error }. */
  note(spec) {
    if (!spec || typeof spec !== "object") return { error: "a note is an object" };
    const text = str(spec.text, 4000);
    if (!text) return { error: "a note needs text" };
    const note = { id: id(), text, when: when(spec.when), from: "phone" };
    this.noteItems.unshift(note);
    if (this.noteItems.length > NOTES_KEEP) this.noteItems.length = NOTES_KEEP;
    this._append(this.notesFile, note);
    return { ok: true, note };
  }

  /** The last NOTES_KEEP notes, newest first. */
  notes() {
    return this.noteItems.slice(0, NOTES_KEEP);
  }
}

module.exports = { Briefs, KEEP, PAGE, NOTES_KEEP };
