// Clipping — fetch, hash, file, and fan out.
//
// The Trove is an archive of things you explicitly pointed at. Nothing arrives
// here ambiently: no clipboard watching, no history scraping, no contacts. A
// clip exists because a human chose it, and every line records which gesture
// did the choosing (the `agent` field).
//
// Why this lives in its own module rather than main.js: main.js already binds
// `net` to node:net for waitForPort (main.js:21). Requiring electron's `net`
// up there would shadow it and break every local-app launch. So the HTTP side
// stays here, where `net` can mean what Electron means by it.
//
// Storage follows the capture archive's posture — content-addressed blobs plus
// an append-only JSONL index. The index is evidence: lines are added, never
// rewritten, and a forgotten clip is a new line saying so.

const { net, nativeImage } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// 25MB matches Glamoire's own multer ceiling, so anything the Trove accepts
// can also be handed onward without a second size rule.
const MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 30000;
const THUMB_W = 320;

// ------------------------------------------------------------------ fetching

// Returns { buffer, mime, status } or throws. `ses` is the app's own Session,
// which is what makes useSessionCookies meaningful — a logged-in board CDN
// serves bytes to the persona that was already browsing it, and refuses a
// cold request. The persona design paying off somewhere new.
function fetchBytes(url, { ses, referer } = {}) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = net.request({ url, session: ses, useSessionCookies: !!ses, redirect: "follow" });
    } catch (err) {
      reject(new Error(`bad url: ${String(err.message || err)}`));
      return;
    }
    if (referer) req.setHeader("Referer", referer);
    req.setHeader("Accept", "*/*");

    const timer = setTimeout(() => {
      try { req.abort(); } catch {}
      reject(new Error(`timed out after ${TIMEOUT_MS / 1000}s`));
    }, TIMEOUT_MS);

    req.on("response", (res) => {
      const status = res.statusCode;
      const mime = String(res.headers["content-type"] || "").split(";")[0].trim();
      const declared = Number(res.headers["content-length"] || 0);
      if (declared > MAX_BYTES) {
        clearTimeout(timer);
        try { req.abort(); } catch {}
        reject(new Error(`too large: ${Math.round(declared / 1048576)}MB (cap ${MAX_BYTES / 1048576}MB)`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on("data", (c) => {
        total += c.length;
        if (total > MAX_BYTES) {
          clearTimeout(timer);
          try { req.abort(); } catch {}
          reject(new Error(`too large: exceeded ${MAX_BYTES / 1048576}MB mid-stream`));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ buffer: Buffer.concat(chunks), mime, status });
      });
      res.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    req.end();
  });
}

// Page title + og:image, for the omnibox's preview card. Deliberately capped:
// we want the <head>, not the document, and some pages are enormous.
async function pageMeta(url) {
  try {
    const { buffer, status } = await fetchBytes(url, {});
    if (status >= 400) return { title: null, image: null };
    const head = buffer.toString("utf8", 0, Math.min(buffer.length, 200000));
    const title = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const og = (head.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                head.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) || [])[1];
    return {
      title: title ? title.replace(/\s+/g, " ").trim().slice(0, 300) : null,
      image: og ? new URL(og, url).href : null,
    };
  } catch {
    return { title: null, image: null };
  }
}

// -------------------------------------------------------------------- naming

const MIME_EXT = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
  "image/webp": ".webp", "image/avif": ".avif", "image/svg+xml": ".svg",
  "image/bmp": ".bmp", "image/x-icon": ".ico",
  "video/mp4": ".mp4", "video/webm": ".webm",
  "application/pdf": ".pdf", "text/html": ".html", "text/plain": ".txt",
  "application/json": ".json", "application/zip": ".zip",
};

function extFor(mime, url) {
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  try {
    const clean = new URL(url).pathname;
    const e = path.extname(clean).toLowerCase();
    if (e && e.length <= 6 && /^\.[a-z0-9]+$/.test(e)) return e;
  } catch {}
  return ".bin";
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// A short, sortable, human-quotable id. Not a hash — two clips of the same
// bytes are two events and get two ids.
function clipId() {
  return "clip_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex");
}

// -------------------------------------------------------------------- store

class Trove {
  constructor(root) {
    this.root = path.resolve(root);
    this.objects = path.join(this.root, "objects");
    this.thumbs = path.join(this.root, "thumbs");
    this.index = path.join(this.root, "index.jsonl");
  }

  ensure() {
    fs.mkdirSync(this.objects, { recursive: true });
    fs.mkdirSync(this.thumbs, { recursive: true });
    const readme = path.join(this.root, "README.md");
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, TROVE_README, "utf8");
    }
    if (!fs.existsSync(this.index)) fs.writeFileSync(this.index, "", "utf8");
  }

  // Content-addressed: objects/<first two hex>/<sha256><ext>. The same image
  // clipped twice stores one blob and writes two index lines, because two
  // clip events happened and the record should say so.
  objectRel(sha, ext) {
    return path.posix.join("objects", sha.slice(0, 2), sha + ext);
  }

  writeObject(buffer, ext) {
    const sha = sha256(buffer);
    const rel = this.objectRel(sha, ext);
    const abs = path.join(this.root, rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buffer);
    }
    return { sha, rel, abs, deduped: false };
  }

  // Thumbnails are made HERE, in the main process, and never read back
  // full-size through roost.fs — ScopedFs.read caps at 8MB (lib/fsapi.js) and
  // that cap exists for good reasons. A GIF keeps its animation in the object;
  // only the thumbnail is a flattened first frame.
  writeThumb(buffer, sha) {
    try {
      const img = nativeImage.createFromBuffer(buffer);
      if (img.isEmpty()) return null;
      const { width } = img.getSize();
      const small = width > THUMB_W ? img.resize({ width: THUMB_W, quality: "good" }) : img;
      const rel = path.posix.join("thumbs", sha + ".png");
      fs.writeFileSync(path.join(this.root, rel), small.toPNG());
      return rel;
    } catch {
      return null; // not an image, or an encoder we don't have — fine
    }
  }

  append(line) {
    this.ensure();
    fs.appendFileSync(this.index, JSON.stringify(line) + "\n", "utf8");
    this._mtime = -1;
    this._size = -1;
    return line;
  }

  // Tolerant read: a truncated final line (power loss mid-append) is skipped
  // rather than losing the file, same posture as the capture importer.
  read() {
    try {
      const st = fs.statSync(this.index);
      if (this._rows && st.mtimeMs === this._mtime && st.size === this._size) return this._rows.slice();
      const rows = fs.readFileSync(this.index, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      this._mtime = st.mtimeMs;
      this._size = st.size;
      this._rows = rows;
      return rows.slice();
    } catch {
      return [];
    }
  }
}

const TROVE_README = `# The Trove

Things you explicitly clipped, with where they came from.

- \`index.jsonl\` — append-only. One line per clip EVENT, not per file. Clipping
  the same image twice writes one blob and two lines, because two things
  happened. Lines are never rewritten; forgetting a clip appends a
  \`"kind":"forgotten"\` line.
- \`objects/<aa>/<sha256><ext>\` — the bytes, content-addressed. Identical
  content is stored once.
- \`thumbs/<sha256>.png\` — 320px previews, generated at clip time.
- \`leads.jsonl\` — append-only, same posture. Research leads ("gather
  everything about X in one container"): a \`"kind":"lead"\` line creates one,
  \`"kind":"lead-retired"\` removes it, \`"kind":"filed"\`/\`"kind":"unfiled"\`
  move a clip in or out by reference, and \`"kind":"lead-active"\` sets the one
  lead new clips are auto-filed into (\`ref: null\` clears it). Never rewritten;
  later lines win.

Every line carries \`agent\`, which records the gesture that made the clip:
\`context-menu\`, \`omnibox\`, \`will-download\`, \`mut-drop\`, or \`routine:<name>\`.
That is how a clip proves a human pointed at it.

Nothing arrives here ambiently. No clipboard watching, no history, no contacts.
`;

// -------------------------------------------------------------------- leads

function leadId() {
  return "lead_" + Date.now().toString(36) + "_" + crypto.randomBytes(3).toString("hex");
}

// Research leads: named containers that gather clips from anywhere — an LLM
// chat, a link, a video, an agent's deep-dive — into one trail. The file is
// append-only like index.jsonl, and for the same reason: this is the story of
// a research effort, and stories are not edited in place.
//
// Lines and their fold order:
//   {kind:"lead", id, name}            create
//   {kind:"lead-retired", ref}         remove (its filed lines become inert)
//   {kind:"filed", lead, ref}          clip is in the lead
//   {kind:"unfiled", lead, ref}        clip is out again
//   {kind:"lead-active", ref|null}     the lead new clips are filed into; last wins
class Leads {
  constructor(root) {
    this.file = path.join(path.resolve(root), "leads.jsonl");
  }

  append(line) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(line) + "\n", "utf8");
    this._mtime = -1;
    this._size = -1;
    return line;
  }

  // Tolerant read, same posture as Trove.read: a truncated final line is
  // skipped, not fatal — the file is evidence, and evidence survives power loss.
  read() {
    try {
      const st = fs.statSync(this.file);
      if (this._rows && st.mtimeMs === this._mtime && st.size === this._size) return this._rows.slice();
      const rows = fs.readFileSync(this.file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      this._mtime = st.mtimeMs;
      this._size = st.size;
      this._rows = rows;
      this._folded = null;
      return rows.slice();
    } catch {
      return [];
    }
  }

  fold() {
    try {
      const st = fs.statSync(this.file);
      if (this._folded && st.mtimeMs === this._mtime && st.size === this._size) {
        return {
          leads: this._folded.leads.map((x) => ({ ...x, clips: new Set(x.clips) })),
          active: this._folded.active,
        };
      }
    } catch {}
    const leads = new Map(); // id -> { id, name, t, clips:Set }
    let active = null;
    for (const l of this.read()) {
      if (l.kind === "lead") {
        if (!leads.get(l.id)) leads.set(l.id, { id: l.id, name: l.name || l.id, t: l.t, clips: new Set() });
        else leads.get(l.id).name = l.name || leads.get(l.id).name; // rename
      } else if (l.kind === "lead-retired") leads.delete(l.ref);
      else if (l.kind === "filed") leads.get(l.lead)?.clips.add(l.ref);
      else if (l.kind === "unfiled") leads.get(l.lead)?.clips.delete(l.ref);
      else if (l.kind === "lead-active") active = l.ref || null;
    }
    // An active lead that has since been retired files clips nowhere — the
    // switch reads as off rather than pointing at a container that no longer is.
    const list = [...leads.values()];
    if (active && !leads.has(active)) active = null;
    this._folded = {
      leads: list.map((x) => ({ ...x, clips: new Set(x.clips) })),
      active,
    };
    return { leads: list, active };
  }
}

// ------------------------------------------------------------------- fanout

// Glamoire's vault. Two things that fail SILENTLY if you get them wrong, both
// verified in C:\Glamoire\server.js:86-87 — the multipart field is `files`
// (not `files[]`), and the route takes the NUMERIC characters.id, not the
// slug. A wrong field name returns {ok:true} having saved nothing.
function toGlamoire({ characterId, filename, buffer, mime, base = "http://localhost:8790" }) {
  return new Promise((resolve) => {
    const boundary = "----ifreglen" + crypto.randomBytes(8).toString("hex");
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${filename.replace(/"/g, "")}"\r\n` +
      `Content-Type: ${mime || "application/octet-stream"}\r\n\r\n`,
      "utf8"
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    const body = Buffer.concat([head, buffer, tail]);

    let req;
    try {
      req = net.request({ method: "POST", url: `${base}/character/${characterId}/files` });
    } catch (err) {
      resolve({ ok: false, error: String(err.message || err) });
      return;
    }
    req.setHeader("Content-Type", `multipart/form-data; boundary=${boundary}`);
    // No Content-Length: Electron's net rejects an explicit one on an upload
    // with net::ERR_INVALID_ARGUMENT before the request ever leaves the
    // machine (verified in Electron 43, same as lib/wire.js). Chromium derives
    // it from the written body.
    const timer = setTimeout(() => { try { req.abort(); } catch {}; resolve({ ok: false, error: "timed out" }); }, TIMEOUT_MS);
    req.on("response", (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => {
        clearTimeout(timer);
        resolve(res.statusCode < 300
          ? { ok: true, ref: filename }
          : { ok: false, error: `glamoire ${res.statusCode}: ${out.slice(0, 160)}` });
      });
    });
    req.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, error: String(err.message || err) }); });
    req.write(body);
    req.end();
  });
}

function glamoireCharacters(base = "http://localhost:8790") {
  return new Promise((resolve) => {
    let req;
    try { req = net.request(`${base}/api/characters`); }
    catch { resolve([]); return; }
    const timer = setTimeout(() => { try { req.abort(); } catch {}; resolve([]); }, 4000);
    req.on("response", (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => {
        clearTimeout(timer);
        try {
          const j = JSON.parse(out);
          resolve(Array.isArray(j) ? j : (j.characters || []));
        } catch { resolve([]); }
      });
    });
    req.on("error", () => { clearTimeout(timer); resolve([]); });
    req.end();
  });
}

// The Brain. We never POST bytes at it — brain-bridge.js states the principle
// plainly: the bus carries the decision to infuse, not the megabytes. A clip
// becomes a HELD JOB in the verdict queue, so the human stays in the loop
// structurally rather than by promise.
//
// The token is scraped, not stored: the Brain injects <meta name="brain-token">
// into the HTML it serves, and only /api/* is gated — so GET / is open. That
// means no stale secret in secrets.json and rotation costs nothing.
let brainTokenCache = null;

function brainToken(base = "http://localhost:3001") {
  if (brainTokenCache) return Promise.resolve(brainTokenCache);
  return new Promise((resolve) => {
    let req;
    try { req = net.request(base + "/"); }
    catch { resolve(null); return; }
    const timer = setTimeout(() => { try { req.abort(); } catch {}; resolve(null); }, 4000);
    req.on("response", (res) => {
      let out = "";
      res.on("data", (c) => { out += c; if (out.length > 100000) { try { req.abort(); } catch {} } });
      res.on("end", () => {
        clearTimeout(timer);
        const m = out.match(/<meta[^>]+name=["']brain-token["'][^>]+content=["']([^"']+)["']/i);
        if (m) { brainTokenCache = m[1]; resolve(m[1]); return; }
        // Vite-dev fallback: the server writes this file for the proxy.
        try {
          // GOBLIN_BRAIN is exported by main.js from the registry at start.
          const devFile = path.join(process.env.GOBLIN_BRAIN || "C:\\Goblin Brain", ".brain-dev-token");
          const tok = fs.readFileSync(devFile, "utf8").trim();
          if (tok) { brainTokenCache = tok; resolve(tok); return; }
        } catch {}
        resolve(null);
      });
    });
    req.on("error", () => { clearTimeout(timer); resolve(null); });
    req.end();
  });
}

async function toBrain({ rite = "research", subject, context, meta, base = "http://localhost:3001" }, retry = true) {
  const token = await brainToken(base);
  if (!token) return { ok: false, error: "brain not reachable (no token)" };
  const payload = JSON.stringify({ rite, subject, context, meta, origin: "trove" });

  const result = await new Promise((resolve) => {
    let req;
    try { req = net.request({ method: "POST", url: `${base}/api/jobs` }); }
    catch (err) { resolve({ ok: false, status: 0, error: String(err.message || err) }); return; }
    req.setHeader("Content-Type", "application/json");
    req.setHeader("Authorization", `Bearer ${token}`);
    req.setHeader("X-Brain-Token", token);
    const timer = setTimeout(() => { try { req.abort(); } catch {}; resolve({ ok: false, status: 0, error: "timed out" }); }, TIMEOUT_MS);
    req.on("response", (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => {
        clearTimeout(timer);
        resolve(res.statusCode < 300
          ? { ok: true, status: res.statusCode, ref: out.slice(0, 160) }
          : { ok: false, status: res.statusCode, error: `brain ${res.statusCode}: ${out.slice(0, 160)}` });
      });
    });
    req.on("error", (err) => { clearTimeout(timer); resolve({ ok: false, status: 0, error: String(err.message || err) }); });
    req.write(payload);
    req.end();
  });

  // A rotated token looks exactly like a 401. Drop the cache and try once.
  if (!result.ok && result.status === 401 && retry) {
    brainTokenCache = null;
    return toBrain({ rite, subject, context, meta, base }, false);
  }
  return result;
}

module.exports = {
  MAX_BYTES, THUMB_W,
  fetchBytes, pageMeta, extFor, sha256, clipId, leadId,
  Trove, Leads, toGlamoire, glamoireCharacters, toBrain, brainToken,
};
