// cartridge.js — the shell's side of the Brain's Forge power.
//
// The Forge (a power of Goblin Brain, not to be confused with Kenoma, which is
// the agentic coder in C:\Forge) compiles a Context Cartridge you hand to a
// chat LLM, then parses the reply back into edits: previewed per file, written
// snapshot-first, verified, and rolled back if the verify goes red.
//
// Its cheapest transport was always the one that cost the most labour — the
// paste path is free with any chat subscription, and its whole price was a
// person ferrying text between a browser and a terminal. Now that The Wilds
// puts the chat window INSIDE the shell, that ferry is two right-clicks:
//
//   out    put the cursor in the chat box, then "Cartridge for <app>" from the
//          palette — the shell types it in and you press Enter yourself
//   back   select the model's reply, right-click, "Preview through the Forge"
//
// Deliberately NOT an automation of the chat UI. You drive the conversation,
// which is the half you are good at and the half that breaks when a site
// redesigns itself; the shell does the return leg, which is the tedious half.
// forge.relay (in the Brain) exists for when you do want it hands-off.
//
// Nothing here writes. `preview` is a dry run and `apply` is a separate, named
// call the person makes after reading it — the Forge's own guards (snapshot
// first, verify, rollback) sit behind that, and a reply nobody read is exactly
// the wrong thing to trust.

const { net } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.GOBLIN_BRAIN_BASE || "http://localhost:3001";
const TIMEOUT_MS = 120000;           // packing a large app is not quick
const BRAIN_ROOT = "C:\\Goblin Brain";

let tokenCache = null;

// Same two doors lib/clip.js uses: the token is published in a meta tag on the
// Brain's own page, and the dev server writes it to a file for its proxy.
function brainToken() {
  if (tokenCache) return Promise.resolve(tokenCache);
  return new Promise((resolve) => {
    let req;
    try { req = net.request(BASE + "/"); } catch { resolve(null); return; }
    const timer = setTimeout(() => { try { req.abort(); } catch {} resolve(null); }, 4000);
    req.on("response", (res) => {
      let out = "";
      res.on("data", (c) => { out += c; if (out.length > 100000) { try { req.abort(); } catch {} } });
      res.on("end", () => {
        clearTimeout(timer);
        const m = out.match(/<meta[^>]+name=["']brain-token["'][^>]+content=["']([^"']+)["']/i);
        if (m) { tokenCache = m[1]; resolve(m[1]); return; }
        try {
          const tok = fs.readFileSync(path.join(BRAIN_ROOT, ".brain-dev-token"), "utf8").trim();
          if (tok) { tokenCache = tok; resolve(tok); return; }
        } catch {}
        resolve(null);
      });
    });
    req.on("error", () => { clearTimeout(timer); resolve(null); });
    req.end();
  });
}

const DOWN =
  "Goblin Brain is not answering on " + BASE + " — start it (its tile is in the rail) " +
  "and try again.";

// Every failure RESOLVES, the way lib/clip.js and lib/wire.js do. A verb in a
// context menu must never throw into the main process.
async function invoke(verb, args, { timeout = TIMEOUT_MS } = {}) {
  const token = await brainToken();
  if (!token) return { ok: false, error: DOWN };
  const body = JSON.stringify(args || {});
  return new Promise((resolve) => {
    let req;
    try {
      req = net.request({ method: "POST", url: `${BASE}/api/powers/forge/${verb}` });
    } catch (e) {
      resolve({ ok: false, error: String(e.message || e) });
      return;
    }
    req.setHeader("Content-Type", "application/json");
    req.setHeader("Authorization", `Bearer ${token}`);
    const timer = setTimeout(() => { try { req.abort(); } catch {} resolve({ ok: false, error: `the Forge did not answer in ${Math.round(timeout / 1000)}s` }); }, timeout);
    req.on("response", (res) => {
      let out = "";
      res.on("data", (c) => { out += c; });
      res.on("end", () => {
        clearTimeout(timer);
        let json = null;
        try { json = JSON.parse(out); } catch {}
        if (!json) { resolve({ ok: false, error: `the Forge answered ${res.statusCode}` }); return; }
        // A power answers { ok, ... } or { error }.
        if (json.error) { resolve({ ok: false, error: String(json.error) }); return; }
        resolve({ ok: true, ...json });
      });
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: /ECONNREFUSED/.test(e.message) ? DOWN : String(e.message || e) });
    });
    req.write(body);
    req.end();
  });
}

// The apps the Forge knows how to write to. Used to build the palette's list
// and to pick a default when a reply does not name one.
const apps = () => invoke("apps.list", {}, { timeout: 15000 });

// Compile the cartridge for one or more apps.
const pack = ({ appIds, goal, sessionId }) => invoke("pack", { appIds, goal, sessionId });

// Dry run. Nothing is written; the result says, per file, what would change
// and what did not match.
const preview = ({ changeSet, defaultAppId }) => invoke("preview", { changeSet, defaultAppId });

// The correction request for whatever failed the preview — the text you paste
// back into the same conversation.
const correction = ({ changeSet, defaultAppId, sessionId }) =>
  invoke("correction", { changeSet, defaultAppId, sessionId });

// The write. Separate, named, and only ever called from a person's click after
// they have read a preview.
const apply = ({ changeSet, planId, defaultAppId, verify = true, rollbackOnFail = true, goal }) =>
  invoke("apply", { changeSet, planId, defaultAppId, verify, rollbackOnFail, goal });

// Does a blob of text even look like a change-set? The Forge's own parser is
// the authority, but this keeps the context menu from offering a verb that is
// certain to come back empty — and tells the person WHY when it would.
const LOOKS_LIKE = /(<<<+\s*SEARCH|^```[a-z]*\s*$|^---\s*$|^\+\+\+|@@ )/mi;
function couldBeChangeSet(text) {
  const s = String(text || "");
  if (s.trim().length < 20) return false;
  return LOOKS_LIKE.test(s);
}

module.exports = { invoke, apps, pack, preview, correction, apply, couldBeChangeSet, brainToken, BASE };
