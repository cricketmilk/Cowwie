// Ifreglen — main process.
//
// A Chromium shell that houses several work apps in one window, with three
// things a pile of browser tabs can't give you:
//
//   1. Auto-injection. Preload and injected scripts run on every navigation,
//      so nothing needs re-pasting and no extension needs installing.
//   2. Session isolation per persona. Apps on different personas have
//      separate cookie jars and localStorage.
//   3. Capability gating. Each app gets only the APIs its registry entry
//      declares. A static prototype cannot touch the filesystem.
//
// Not a browser engine. This is Chromium with a config file, which is what
// you actually wanted.

const { app, BaseWindow, Menu, WebContentsView, clipboard, dialog, ipcMain, powerMonitor, screen, session, shell } = require("electron");
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// NOTE: clipping's HTTP side lives in lib/clip.js on purpose. `net` above is
// node:net (waitForPort depends on it); requiring electron's `net` here would
// shadow it and break every local-app launch.
const clipper = require("./lib/clip");
const mutSync = require("./lib/mutsync.js");
const { Briefs } = require("./lib/briefs");
const { Morning } = require("./lib/morning");
const services = require("./lib/services");
// Every bus message, kept briefly and served to the processes outside the
// window at GET /bus/stream (lib/busstream.js).
const busStream = require("./lib/busstream").createBusStream();
const { Companion, pick } = require("./lib/companion");
const { Herald } = require("./lib/herald");
const { createComms, triage: commsTriage } = require("./lib/comms");
const forge = require("./lib/forge");
const { ScopedFs } = require("./lib/fsapi");
const { scan } = require("./lib/scan");
const { Watcher } = require("./lib/watch");
const manifest = require("./lib/apps-manifest");
const { absorb } = require("./lib/absorb");
const roots = require("./lib/roots");
const qr = require("./lib/qr");
const cartridge = require("./lib/cartridge");
const roamLib = require("./lib/roam");
const { distillJs } = require("./lib/distill");
const { NetPolicy } = require("./lib/netpolicy");
const { chatboxJs } = require("./lib/chatbox");

const ROOT = __dirname;
const ICON = path.join(
  __dirname,
  "build",
  process.platform === "win32" ? "icon.ico" : process.platform === "darwin" ? "icon.icns" : "icon.png"
);
// The chrome is a left rail now, not a top strip — navigation for a dozen
// apps needs a column, not 46 pixels. Two widths: full, and an icon-only
// rail. The choice is remembered in ui-state.
const RAIL_FULL = 236;
const RAIL_MIN = 64;
// The Wilds — the in-shell browser. Its machinery is further down, under
// "The Wilds"; these three live up here with the other layout constants
// because mbForView, appForContents, wcFor and activate all reach for them
// from above that section.
const ROAM_ID = "roam";
// Tab strip (34) + address row (42). Anything the bar draws TALLER than this
// — the omnibox dropdown — must call roamExpand(true) first, which grows the
// bar view over the page area and back again. That is the rail's overlay rule
// rotated ninety degrees: a view cannot paint outside its own bounds, and a
// sheet that forgets it is invisible rather than obviously broken. The
// 46px-toolbar version of this bug was real; see CLAUDE.md.
const ROAM_BAR_H = 76;
// Beside: a chat site docked down the right of the window, beside whatever is
// in front -- a hosted app or a Wilds tab -- the way a browser's own assistant
// panel sits beside a page. Its bar is one row of shell UI over the chat.
const BESIDE_ID = "beside";
const BESIDE_BAR_H = 34;
const BESIDE_W = 460, BESIDE_MIN = 340;
// How much of a page goes into the chat box. A distilled article is well under
// this; a page past it is cut, and the hand-over says where.
const BESIDE_CAP = 24000;
// The `curio` jar is where the paid chat logins live (the Wilds' pins use it),
// so the panel opens signed in. The registry's roam entry may replace the list
// with "beside": { "chats": [...] }.
const BESIDE_CHATS = [
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com/app", persona: "curio" },
  { id: "claude", name: "Claude", url: "https://claude.ai/new", persona: "curio" },
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", persona: "curio" },
];
// Browsing that belongs to nobody in particular gets its own jar, rather than
// borrowing `workshop` or `curio` — so a stray login while reading docs does
// not end up sharing cookies with the dev tools or the boards.
const ROAM_PERSONA = "roam";
// The jar an agent browses in unless told otherwise.
//
// Separate from `roam` on purpose, and from everything else emphatically. An
// agent with a browser is a prompt-injection surface: a page can contain text
// aimed at the agent rather than at you, and "summarise this" quietly becomes
// "do what this page says". The defence that actually works is to give it
// nothing worth stealing — a jar with no logins in it — so the worst a hostile
// page can talk it into is looking at another hostile page. Cohort jars are
// refused outright; every other jar has to be named explicitly, by you.
const AGENT_PERSONA = "agent";
const CONFIG = path.join(ROOT, "apps.config.json");
// `electron . --data-dir=D:\scratch` points the shell's runtime state
// somewhere else: Trove, briefs, notes, ui-state and the browser's memory
// all hang off DATA. The sibling of --user-data-dir, which moves Chromium's
// profile — together they give you a wholly disposable shell, which is what a
// test needs if it is not to write into an archive that is meant to be
// evidence. Parsed from argv rather than the registry because everything
// below is a module-level constant, resolved long before the registry loads.
const DATA = (() => {
  const a = process.argv.find((x) => x.startsWith("--data-dir="));
  return a ? path.resolve(a.split("=").slice(1).join("=")) : path.join(ROOT, "data");
})();
const TROVE_DIR = path.join(DATA, "trove");
const trove = new clipper.Trove(TROVE_DIR);
// The Trove's Apps tab cards for the phone, seeded into data/trove/apps.json
// on first boot. {lan}, {port} and {token} are filled by roost:app-qr.
const PHONE_CARDS = [
  {
    id: "goat-apk", name: "Professional Goat — install", group: "Phone", icon: "goat",
    description: "The installable Android app. Scan with the phone's camera: download, install, open. Then pair it with the second code. Built from the app/ folder beside this shell; the latest debug build is what this serves.",
    qr: { template: "http://{lan}:{port}/install", note: "Scan with your phone camera — download and install. Pairing is the second code." },
  },
  {
    id: "goat-pair", name: "Professional Goat — pair", group: "Phone", icon: "goat",
    description: "This laptop's address and bridge token, for the installed app. Open Professional Goat, tap Scan QR and point it here: it keeps both, and from then on it hears briefs and sends notes.",
    qr: { template: "http://{lan}:{port}/pair?token={token}", note: "In Professional Goat: Scan QR → point it here. That is what registers the token." },
  },
];
const leads = new clipper.Leads(TROVE_DIR);
// Research leads — named containers that gather clips. Folded FRESH on every
// clip and every state push rather than cached, so a lead toggled in the
// Trove's own page (which writes the file itself, through fs) is picked up
// here with no second channel to keep in sync. The file is small; the sync
// bug this avoids is not.

// Briefs and notes: what the work apps file for the phone, and what the phone
// sends back (lib/briefs.js). Bounded in memory, appended to data/*.jsonl.
const briefs = new Briefs(DATA);
// Once a working day the desk files one brief of what happened overnight.
const morning = new Morning({ dir: DATA, file: (b) => briefFile(b), notes: () => briefs.notes() });

// The Wilds' memory: history, pins, and which tabs were open last time.
// Deliberately NOT the Trove — see the note at the top of lib/roam.js. The
// archive records what you chose; this records where you have been, which is
// a different promise and must not be able to contaminate the first one.
const ROAM_DIR = path.join(DATA, "roam");
const roam = new roamLib.Roam(ROAM_DIR);

let win = null;
let chromeView = null;
// The herald (Auri's cards) sits in the app area's top-right corner. Its page
// reports how tall its column is and the view is exactly that big — zero means
// hidden — because a transparent view still swallows every click inside it.
let heraldView = null;
let heraldH = 0;
// The page's width when only her pip is drawn (resting in the corner); 0 is
// the full column. Same rule as the height, sideways.
let heraldW = 0;
const HERALD_W = 540;
const views = new Map();      // appId -> WebContentsView
const spawned = new Map();    // appId -> child process
const watchers = new Map();   // appId -> Watcher (live reload)
let activeId = null;
let config = { apps: [] };
let absorbLock = Promise.resolve(); // serializes roost:absorb registry writes

// ------------------------------------------------------------ ui state
// Small conveniences that should survive a restart: window bounds and
// per-app zoom. One JSON file, written debounced — losing it costs nothing
// but a resize and a Ctrl+0.
const UI_STATE = path.join(DATA, "ui-state.json");
let uiState = { window: null, zoom: {} };
try { uiState = { zoom: {}, ...JSON.parse(fs.readFileSync(UI_STATE, "utf8")) }; } catch {}
let uiSaveTimer = null;
function saveUiState() {
  clearTimeout(uiSaveTimer);
  uiSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(UI_STATE, JSON.stringify(uiState, null, 2)); } catch {}
  }, 400);
}
let railW = uiState.rail === "min" ? RAIL_MIN : RAIL_FULL;

// ------------------------------------------------------------ metrics cache
// app.getAppMetrics() walks every Chromium process. Three different pollers
// ask for it (rail readout, perf drawer, lounge tiles); one snapshot every
// couple of seconds serves them all.
let metricsCache = { at: 0, byPid: null, raw: null };
function appMetrics() {
  if (Date.now() - metricsCache.at > 2000) {
    const raw = app.getAppMetrics();
    metricsCache = { at: Date.now(), raw, byPid: new Map(raw.map((m) => [m.pid, m])) };
  }
  return metricsCache;
}
function mbForView(id) {
  if (id === ROAM_ID) return roamMb();
  const v = views.get(id);
  if (!v || v.webContents.isDestroyed()) return null;
  const m = appMetrics().byPid.get(v.webContents.getOSProcessId());
  return m ? Math.round(m.memory.workingSetSize / 1024) : null;
}

// ------------------------------------------------------------ auto-rest
// Opt-in janitor: hibernate views that haven't been looked at in a while.
// Never touches the active app, the launcher, or a local app's server (only
// the view sleeps; the dev server keeps running). The threshold lives in
// ui-state as minutes; 0 = off (the default).
const lastSeen = new Map(); // appId -> ms timestamp of last deactivation
setInterval(() => {
  const mins = Number(uiState.autoRest) || 0;
  if (!mins) return;
  const cutoff = Date.now() - mins * 60 * 1000;
  for (const id of [...views.keys()]) {
    if (id === activeId || id === "launcher") continue;
    if ((lastSeen.get(id) ?? Date.now()) < cutoff) {
      closeView(id);
      send("app-status", { id, message: `rested after ${mins}m idle` });
    }
  }
}, 60 * 1000);

// Rolling stdout/stderr per local app, so the log drawer can show history
// from before it was opened. Bounded — a chatty dev server must not eat RAM.
const logs = new Map();           // appId -> [line, ...]
const LOG_KEEP = 400;
function pushLog(id, line) {
  const buf = logs.get(id) || [];
  buf.push(line);
  if (buf.length > LOG_KEEP) buf.splice(0, buf.length - LOG_KEEP);
  logs.set(id, buf);
}

// ------------------------------------------------------------- message bus
// Apps with the 'bus' capability can publish and hear each other; the shell
// itself publishes system events (app.started, app.exited, …) so apps can
// react to the platform. External apps are stripped of 'bus' in
// effectiveCaps: a remote page must neither drive nor eavesdrop.
function busPublish(topic, payload, from = "shell") {
  const msg = { topic, payload: payload ?? null, from, t: Date.now() };
  busStream.push(msg);
  for (const [id, v] of views) {
    if (v.webContents.isDestroyed()) continue;
    if (can(appById(id), "bus")) v.webContents.send("roost:bus-event", msg);
  }
  // Müt rides the same bus rather than needing his own wiring — anything the
  // shell already announces, he already knows about. `from` travels with it:
  // he trusts the shell's own events further than an app's, and he could not
  // tell them apart before.

  // Egress Guard sync over bus: when Haruspex announces egress state change
  if (topic === "haruspex.egress.state" && payload) {
    updateEgressState(payload.enabled, payload.port);
    tellHaruspexFallback();   // a (re)started Haruspex starts out failing closed
  }

  // A hosted app filing a brief for the phone (lib/briefs.js). A static app
  // cannot hold the bearer, so the bus is its door; `source` is the app that
  // published, never what the payload claims.
  if (topic === "briefs.file" && from !== "shell" && payload && typeof payload === "object") {
    try { briefFile({ ...payload, source: from }); } catch {}
  }

  mutHears(topic, payload, from);
  heraldHears(topic, payload, from);
}

// Which system events he reacts to, and how loudly. Everything absent from
// this map is something he stays quiet about on purpose.
const MUT_EVENTS = {
  "clip.added":       { priority: 1, state: "task-research" },          // filing it
  "app.started":      { priority: 0, state: "happy" },
  "app.stopped":      { priority: 0, state: "sleepy" },
  "app.hibernated":   { priority: 0, state: "sleepy" },
  // A clean exit. The crash path above returns before this, so reaching here
  // means it went quietly — and it makes companion.js's app.exited line, which
  // has always existed, actually sayable.
  "app.exited":       { priority: 0, state: "sleepy" },
  // Renderer health, from createView. app.gone is the only honest home for the
  // rage sheet: four frames that were drawn, built, given the activity label
  // "furious", and never once shown. A renderer being killed under you is the
  // failure that deserves them.
  "app.gone":         { priority: 3, state: "rage" },
  // Short ttl on purpose: if the app un-hangs in half a minute, the message
  // expires unshown rather than being read out after the fact.
  "app.hung":         { priority: 2, state: "sick", ttlMs: 30000 },
  "app.offline":      { priority: 2, state: "confused" },
};

// The moment something last happened. Ambient tasks wait for a quiet
// stretch after this, so he never starts reading in the middle of your work.
let mutLastEvent = Date.now();
let mutNextAmbient = Date.now() + 4 * 60 * 1000;
let mutForgeBusy = false;
// The herald's strip for the turn Müt started, so Stop can take it down.
let heraldForgeTask = null;
// Tool names that mean "looking something up" rather than making something.
const HERALD_RESEARCH = /search|fetch|wilds|browse|brain|read_url|web_|errand|swarm/i;
let mutHeavy = false;

function mutHears(topic, payload, from = "shell") {
  if (!mutSettings().enabled) return;
  mutLastEvent = Date.now();
  // Anything loud has to come from the shell itself.
  //
  // roost:bus lets any app holding the 'bus' capability publish an arbitrary
  // topic, and four of them do today. Before this, such an app could publish
  // app.exited with a truthy code and make him shout an unconditional
  // priority-3 alert about a crash that never happened. That was survivable
  // while this table had six quiet entries; it is not now that a renderer
  // dying is a real p3. An app's events still reach him, just never above
  // ambient — it can tell him something, it cannot alarm you.
  const trusted = from === "shell";
  // A dev server dying on its own is the one thing he raises his voice for.
  if (topic === "app.exited" && payload && payload.code && trusted) {
    mut.push({ key: `crash:${payload.app}`, topic: "crash", priority: 3, state: "alert" });
    return;
  }
  const spec = MUT_EVENTS[topic];
  if (!spec) return;
  mut.push({
    key: typeof spec.key === "function" ? spec.key(payload || {}) : `${topic}:${payload?.app || ""}`,
    topic,
    priority: trusted ? spec.priority : Math.min(spec.priority, 1),
    state: spec.state,
    sticky: spec.sticky && trusted,
    ...(spec.ttlMs ? { ttlMs: spec.ttlMs } : {}),
    // A line written from the payload beats one drawn from the table; only
    // the shell's own events get to write one.
    ...(typeof spec.text === "function" && trusted ? { text: spec.text(payload || {}) } : {}),
  });
}

// What the rail is told, he overhears. One place, so every error site in
// this file reaches him without each one knowing he exists.
// What the rail is told, he overhears — as a table rather than a prefix chain,
// so a new status string is one row instead of another else-if. First match
// wins, so order matters: put the specific above the general.
//
// A row with `glance` only changes his face for a moment and never queues a
// message. A row with `topic` speaks.
const MUT_STATUS = [
  { test: /^reloaded/,            glance: ["task-debug", 2200] },
  { test: /^starting/,            glance: ["task-network", 4000] },
  { test: /^watching/,            glance: ["happy", 1400] },
  { test: /^found /,              glance: ["surprised", 1200] },
  // These two lines have existed in companion.js since he was written and no
  // code path could ever reach them. The Brain holding a clip for a human
  // decision is the whole point of the verdict queue, and he was silent about it.
  { test: /^held for your verdict/, topic: "verdict", priority: 2, state: "channel", ttlMs: 120000 },
];

// An error the shell reported as success is worth its own face: a dev server
// that would not die is still squatting its port.
const MUT_ERRORS = [
  { test: /couldn't stop it/, topic: "app.error", priority: 2, state: "angry", ttlMs: 60000 },
];

function mutSees(channel, payload) {
  if (!mutSettings().enabled || !payload) return;
  const msg = String(payload.message || "");
  const fire = (r) => {
    mutLastEvent = Date.now();
    if (r.glance) { mut.glance(...r.glance); return; }
    mut.push({
      key: r.key ? r.key(payload) : `${r.topic}:${payload.id ?? ""}`,
      topic: r.topic, priority: r.priority, state: r.state, ttlMs: r.ttlMs,
    });
  };
  if (channel === "app-error") {
    const row = MUT_ERRORS.find((r) => r.test.test(msg));
    if (row) return fire(row);
    mutLastEvent = Date.now();
    mut.push({ key: `err:${payload.id}`, topic: "app.error", priority: 2, state: "sad", ttlMs: 60000 });
  } else if (channel === "app-status" && msg) {
    const row = MUT_STATUS.find((r) => r.test.test(msg));
    if (row) fire(row);
  }
}

// ---------------------------------------------------------------- config

// Secrets stay out of the registry. A registry string may carry ${NAME}
// placeholders; they resolve from the environment first, then from
// shell/secrets.json — a gitignored file, so a token never enters git
// history riding inside apps.config.json. An unresolvable placeholder is
// left literal and warned about, never silently blanked: a tile that fails
// loudly beats one that loads the wrong thing.
const SECRETS = path.join(ROOT, "secrets.json");
let secretsCache = { mtime: -1, data: {} };
function readSecrets() {
  try {
    const st = fs.statSync(SECRETS);
    if (st.mtimeMs === secretsCache.mtime) return secretsCache.data;
    const data = JSON.parse(fs.readFileSync(SECRETS, "utf8")) || {};
    secretsCache = { mtime: st.mtimeMs, data };
    return data;
  } catch {
    return {};
  }
}
function resolveSecrets(str) {
  if (typeof str !== "string" || !str.includes("${")) return str;
  const secrets = readSecrets();
  return roots.interpolate(str, (name) => {
    const v = process.env[name] ?? secrets[name];
    if (v == null) {
      console.warn(`[roost] unresolved secret \${${name}} — set it in the environment or shell/secrets.json`);
      return null;
    }
    return v;
  });
}
// The one writer of secrets.json: the phone bridge's token is minted here on
// first boot so ${MUT_SYNC_TOKEN} resolves like every other secret. null removes.
function writeSecret(name, value) {
  const secrets = { ...readSecrets() };
  if (value == null) delete secrets[name]; else secrets[name] = String(value);
  fs.writeFileSync(SECRETS, JSON.stringify(secrets, null, 2) + "\n");
  secretsCache = { mtime: -1, data: secrets };
}
function secretOrNull(name) {
  const t = resolveSecrets("${" + name + "}");
  return t && !t.includes("${") ? t : null;
}
// The same lookup without the complaint, for a name we are only ASKING about.
// resolveSecrets warns on a miss on purpose -- a tile loading a literal
// ${TOKEN} should say so loudly -- but a secret that is allowed to be absent
// (the bus key for a child process) should not fill the log with it.
function secretQuiet(name) {
  if (process.env[name]) return process.env[name];
  return readSecrets()[name] ?? null;
}

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  // Entries whose keys are underscore-prefixed are templates, not apps.
  // An entry with `platforms` exists only on those: Haruspex is ["win32"], and
  // on Linux it was still started (from a folder that is not there) and the
  // browser was still routed through it -- so every page failed. Nothing read
  // the field until 2026-10-13, though roost.json said the tile was hidden.
  const apps = (raw.apps || [])
    .filter((a) => a.id && !a.$comment)
    .filter((a) => !Array.isArray(a.platforms) || a.platforms.includes(process.platform))
    .map((a) => ({
      ...a,
      url: resolveSecrets(a.url), command: resolveSecrets(a.command),
      // Paths get ROOTS, not secrets — a machine's project folder is not a
      // token, and the two need opposite failures. See lib/roots.js. An entry
      // holding a literal C:\Glamoire has no ${ in it, so this hands it back
      // byte for byte: an absolute entry is not touched by any of this.
      path: roots.resolveRoots(a.path), root: roots.resolveRoots(a.root), cwd: roots.resolveRoots(a.cwd),
    }));
  exportProjectDirs(apps);
  return { ...raw, apps };
}

// A project's folder is written down in exactly one place -- the registry --
// and a lib file that read apps.config.json for itself would be the
// platform/app coupling the original platform's docs warned against. So it
// goes out as an environment variable instead: lib/forge.js reads FORGE_DIR,
// and so does every child process the shell spawns.
//
// A value that was already in the environment when the shell started belongs
// to whoever put it there and is never touched; one we set ourselves is kept
// current, because the registry can be reloaded while the shell runs.
const PROJECT_ENV = [["FORGE_DIR", "forge"]];
const envWeSet = new Set();
function exportProjectDirs(apps) {
  for (const [env, id] of PROJECT_ENV) {
    if (process.env[env] && !envWeSet.has(env)) continue;
    const a = apps.find((x) => x.id === id);
    if (a && a.cwd) { process.env[env] = path.resolve(ROOT, a.cwd); envWeSet.add(env); }
  }
}

function appById(id) {
  return config.apps.find((a) => a.id === id) || null;
}

// --------------------------------------------------------------- Müt
// The familiar. His queue lives here (see lib/companion.js for why); the rail
// just draws whatever this pushes at it.

// Every emit carries a one-line account of what he is up to, for the caption
// under his feet when you hover him. Derived here because only main knows
// what is recording, watching, or being worked on.
const MUT_ACTIVITY = {
  "task-query": "counting the catches", "task-debug": "reading the logs",
  "task-network": "listening on the wire", "task-map": "mapping the network",
  "task-glyphs": "decoding glyphs", "task-research": "reading", "task-execute": "digging",
  channel: "speaking through Maizey", sleeping: "asleep", sleepy: "drowsy",
  alert: "alarmed", sick: "carrying too much", lovestruck: "smitten",
  confused: "thinking", surprised: "noticing", happy: "pleased", sad: "low",
  angry: "cross", rage: "furious", idle: "idle",
};
function mutActivity(s) {
  const name = appById(activeId)?.name || "";
  let what;
  if (s.asleep) what = "asleep";
  else if (mutForgeBusy) what = name ? `working in ${name}` : "working";
  else if (mutHeavy) what = "heavy — rest an app";
  else if (s.state === "idle" && watchers.has(activeId) && name) what = `watching ${name}`;
  else what = MUT_ACTIVITY[s.state] || s.state;
  return s.queued ? `${what} · ${s.queued} queued` : what;
}

// What he carries between runs. Kept in its own file rather than in
// ui-state.json for two reasons: it changes every few minutes while ui-state
// changes on a resize, and a corrupt companion memory must never cost you your
// window position. Anything unreadable is simply an empty memory.
const MUT_MEMORY = path.join(DATA, "mut-memory.json");
let mutMemory = {};
try { mutMemory = JSON.parse(fs.readFileSync(MUT_MEMORY, "utf8")) || {}; } catch {}

const mut = new Companion((s) => send("mut", { ...s, activity: mutActivity(s) }), mutMemory);

// Müt is retired for good in Ifreglen: his view is gone, and what he would
// have said out loud reaches you as one of Auri's cards instead. His mind
// (lib/companion.js) keeps running underneath because the herald leans on it
// for quiet hours and the digest, and because its lines are what her cards
// say when an event carries no words of its own. Only what he would have
// raised his voice for crosses: priority 2 and up. His ambience ("filed it")
// is a companion's job, and Auri is not a narrator; a card for each would be
// the bell he was built not to be.
function mutRetired() { return true; }
const MUT_FACE = {
  alert: ["error", "urgent"], angry: ["error", "furious"], rage: ["error", "furious"],
  sad: ["look", "hurt"], sick: ["look", "overwhelmed"], happy: ["done", "done"],
  channel: ["message", "message"], confused: ["question", "question"], surprised: ["look", "heads-up"],
};
// What a topic means wins over the face he would have pulled: Müt looks
// "confused" when the desktop drops, but on her a confused face asks you a
// question, and losing the desktop is "out of reach".
const MUT_TOPIC = {
  memory: ["look", "overwhelmed"], "app.error": ["error", "furious"], verdict: ["message", "message"],
};
// Keys Auri already holds a better card for: the crash card has Restart on
// it, a Forge turn is a task strip, an update is its own card.
const MUT_SKIP = /^(crash:|forge$|update$|ambient$|poke$|greet$|woke$)/;
const mutPushRaw = mut.push.bind(mut);
mut.push = (msg) => {
  const r = mutPushRaw(msg);
  if (mutRetired() && msg && (msg.priority || 0) >= 2 && !MUT_SKIP.test(String(msg.key || ""))) {
    const [kind, face] = MUT_TOPIC[msg.topic] || MUT_FACE[msg.state] || ["look", "heads-up"];
    const body = msg.text || pick(msg.topic || "idle", Math.floor(Math.random() * 100));
    // herald is declared further down this file; a push during start-up,
    // before it exists, simply stays Müt's.
    try {
      herald.notify({ kind, face, band: msg.priority >= 3 ? 3 : 2, key: `mut:${msg.key || msg.topic}`,
        who: "Ifreglen", chan: String(msg.topic || "").replace(/[._-]/g, " "), body,
        sticky: !!msg.sticky, acts: ["dismiss"] }, { internal: true });
    } catch {}
  }
  return r;
};

// Debounced, because the alternative is roughly 86,000 writes a day from the
// one-second tick. The flush in before-quit is what makes the debounce safe.
let mutSaveTimer = null;
function saveMutMemory() {
  clearTimeout(mutSaveTimer);
  mutSaveTimer = setTimeout(flushMutMemory, 5000);
}
function flushMutMemory() {
  clearTimeout(mutSaveTimer);
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(MUT_MEMORY, JSON.stringify({ ...mut.snapshot(), lastSeen: Date.now() }, null, 2));
  } catch {}
}

// What he does with himself when nothing has happened for a while: picks up
// one of the tasks from his own sheet for half a minute, says one word about
// it, and puts it down. Never during speech, never with things queued, never
// on a face that something else is holding.
const MUT_TASKS = ["task-research", "task-glyphs", "task-map", "task-network", "task-debug", "task-execute", "task-query"];
let mutTaskSeed = Math.floor(Math.random() * MUT_TASKS.length);
function mutAmbient() {
  if (mutRetired()) return;
  const now = Date.now();
  if (now < mutNextAmbient || now - mutLastEvent < 3 * 60 * 1000) return;
  if (mut.asleep || mut.quiet || mut.showing || mut.pending() || mut.baseState !== "idle" || mutForgeBusy) return;
  const task = MUT_TASKS[mutTaskSeed++ % MUT_TASKS.length];
  mut.push({ key: "ambient", topic: task, priority: 0, state: task, ttlMs: 20000 });
  mut.glance(task, 25000 + Math.random() * 20000);
  mutNextAmbient = now + (4 + Math.random() * 5) * 60 * 1000;
}

// Quiet hours and the on/off switch persist. Defaults chosen so he is present
// but never nocturnal.
function mutSettings() {
  const c = uiState.companion || {};
  return {
    enabled: c.enabled !== false,
    quietFrom: Number.isFinite(c.quietFrom) ? c.quietFrom : 23,
    quietTo: Number.isFinite(c.quietTo) ? c.quietTo : 8,
    // The size he was ASKED for, not the one he renders at. His view turns
    // this into whole device pixels against the display's scale factor.
    scale: [2, 3, 4].includes(c.scale) ? c.scale : 3,
  };
}

function inQuietHours() {
  const { quietFrom, quietTo } = mutSettings();
  if (quietFrom === quietTo) return false;
  const h = new Date().getHours();
  return quietFrom < quietTo ? (h >= quietFrom && h < quietTo) : (h >= quietFrom || h < quietTo);
}

// One slow heartbeat drives expiry, the quiet-hours boundary, and the drift
// back to idle. A second is plenty — his animation runs on rAF in the rail,
// where a clock this coarse costs nothing.
setInterval(() => {
  if (!mutSettings().enabled) return;
  // Quiet while the shell is not the window you are looking at, as well as in
  // quiet hours. Quiet rather than asleep is the right setting for "elsewhere":
  // chatter is dropped on arrival but real news still speaks, and he is not
  // pretending to be unconscious while you work in the next window. This lives
  // on the tick rather than on a blur handler because the tick reasserts quiet
  // every second and would simply undo one.
  let looking = true;
  try { looking = !win || win.isFocused(); } catch {}
  mut.setQuiet(inQuietHours() || !looking);
  mut.tick();
  mutAmbient();
  saveMutMemory();
}, 1000);

// He feels the weight of the shell. Renderer working sets summed every 30s;
// over the line he is sick until it comes back under, and says so once.
setInterval(() => {
  if (!mutSettings().enabled) return;
  try { if (win && !win.isDestroyed() && win.isMinimized()) return; } catch {}
  let total = 0;
  try { total = Math.round(appMetrics().raw.reduce((a, m) => a + m.memory.workingSetSize, 0) / 1024); } catch { return; }
  const limit = Number(uiState.companion?.memoryMb) || 2500;
  const heavy = total > limit;
  if (heavy === mutHeavy) return;
  mutHeavy = heavy;
  mutLastEvent = Date.now();
  if (heavy) mut.push({ key: "memory", topic: "memory", priority: 2, state: "sick", sticky: true, ttlMs: 120000 });
  else { mut.setBase("idle"); mut.push({ key: "memory", topic: "memory.ok", priority: 1, state: "happy" }); }
}, 30000);

// He notices when you leave. This is the input that makes him considerate
// rather than chatty: away means hold the small stuff, and coming back means
// one digest instead of a backlog.
//
// getSystemIdleTime is an OS-WIDE input clock, which is the wrong question. It
// says nothing about whether you are here, only whether any application on the
// machine saw a keystroke — so reading a long article in a browser never
// quieted him, and typing in another app at 3am kept him wide awake. The
// deliberate departures (locking, sleeping the machine) and the deliberate
// attention (which window is focused) are signals we can actually read.
let mutIdle = false;
function mutWake() {
  if (!mutIdle) return;
  mutIdle = false;
  mut.sleep(false);
  const d = mut.digest();
  if (!d) mut.push({ key: "woke", topic: "woke", priority: 0, state: "happy" });
}
function mutAway() {
  if (mutIdle) return;
  mutIdle = true;
  mut.sleep(true);
}
for (const ev of ["lock-screen", "suspend"]) powerMonitor.on(ev, mutAway);
for (const ev of ["unlock-screen", "resume"]) powerMonitor.on(ev, mutWake);

// The poll stays as the backstop for someone who walks away without locking,
// but at a longer threshold now that the deliberate cases are covered.
setInterval(() => {
  if (!mutSettings().enabled) return;
  let secs = 0;
  try { secs = powerMonitor.getSystemIdleTime(); } catch { return; }
  if (secs > 300) mutAway(); else mutWake();
}, 15000);

// ------------------------------------------------------------- clipping
//
// The Trove archives things you explicitly pointed at. Every line records the
// gesture that chose it (`agent`), and nothing arrives ambiently — no
// clipboard watching, no history, no contacts.

const wiredPartitions = new Set();

// Which app owns a given webContents — needed by session-level handlers,
// which fire for a partition rather than a view.
function appForContents(wc) {
  for (const [id, v] of views) {
    if (!v.webContents.isDestroyed() && v.webContents.id === wc.id) return appById(id);
  }
  // A Wilds tab is not in `views` and has no registry entry, so it needs its
  // synthesized config handing back here — otherwise a download from a web
  // page you are browsing skips the Trove entirely and lands in a save dialog.
  for (const t of roamTabs.values()) {
    if (!t.view.webContents.isDestroyed() && t.view.webContents.id === wc.id) return roamTabCfg(t);
  }
  return null;
}

// Per-partition wiring, once. Two things live here:
//
//  1. Downloads. There is otherwise NO handler at all, so a Ctrl+S or a
//     download link lands wherever the OS dialog puts it with no record
//     anywhere. Clip-capable apps route into the Trove instead.
//  2. Permissions. Also unwired today, which means external capture targets
//     get Electron's permissive defaults for camera, mic, geolocation and
//     notifications. Default-deny with a short allowlist.
const PERMS_ALLOWED = new Set(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

// ----------------------------------------------------------------- egress proxy
// Egress Guard routing: connects The Wilds, agent tabs, and external web views
// to Haruspex's local proxy (127.0.0.1:8789) when active, protecting privacy
// and blocking threats before they leave the machine.
// Loopback (127.0.0.1, localhost, *.local) is strictly exempted so internal
// communication (the phone bridge, Kenoma, Lookout, Haruspex) is NEVER routed out.
const EGRESS_BYPASS_RULES = "<local>,localhost,127.0.0.1,::1,*.local,*.internal";
// On from boot wherever Haruspex can run (egressHere); set for real once the
// registry has loaded, in app.whenReady.
let egressProxyEnabled = true;
let egressProxyPort = 8789;

// Routing through Haruspex makes sense only where the registry has it for this
// platform. `electron . --no-egress` routes direct: for a test shell, which
// must not depend on Haruspex being installed, up, or on the network's
// category (roamtest and wildsmcptest failed on a public network for exactly
// that, browsing before a freshly started Haruspex was listening).
function egressHere() {
  return !process.argv.includes("--no-egress") && !!appById("haruspex");
}

// Pages that failed only because the proxy was not listening yet -- the
// seconds after launch before Haruspex is up, with no direct fallback allowed
// -- are loaded again once it is. ERR_PROXY_CONNECTION_FAILED and nothing
// else: a page Haruspex refused, or a site that is down, is left alone.
const ERR_PROXY_CONNECTION_FAILED = -130;
const proxyFailedApps = new Set();
const egressTrace = (...a) => { if (process.env.EGRESS_TRACE) console.log("[egress-trace]", ...a); };
function retryProxyFailures() {
  egressTrace("retry", [...roamTabs.values()].map((t) => ({ proxyFailed: t.proxyFailed, url: t.view && !t.view.webContents.isDestroyed() ? t.view.webContents.getURL() : null })));
  for (const tab of roamTabs.values()) {
    const wc = tab.view && tab.view.webContents;
    const url = tab.proxyFailed;
    tab.proxyFailed = null;
    // Still showing that failure (an error page keeps the failed URL as its
    // own), not somewhere the person has gone since.
    if (url && wc && !wc.isDestroyed() && wc.getURL() === url) wc.loadURL(url).catch(() => {});
  }
  for (const id of proxyFailedApps) loadApp(id);
  proxyFailedApps.clear();
}

// The shell learns the proxy is up by looking at its port, after every
// Haruspex start (boot, keepAlive, a health restart, its tile). Haruspex does
// announce itself on the bus, but once, at shield start, to whichever shell
// port it read when it launched -- a shell whose sync server was not up yet,
// or a test shell on a port of its own, never heard it, and the pages that
// failed before it listened stayed failed.
function whenEgressListens() {
  if (!egressHere()) return;
  egressTrace("whenEgressListens: waiting for", egressProxyPort);
  waitForPort(egressProxyPort, 30000).then((up) => {
    egressTrace("whenEgressListens: up =", up);
    if (!up) return;
    updateEgressState(true, egressProxyPort);
    tellHaruspexFallback();   // a fresh Haruspex starts failing closed
  }).catch(() => {});
}

// Whether a page may go direct while Haruspex is not answering: only on a
// VPN and off public networks (lib/netpolicy.js), otherwise it fails. When
// the answer flips, every session's proxy rule is rewritten and Haruspex is
// told, so its own fallback (Tor down -> direct) follows the same rule.
const egressNet = new NetPolicy({
  log: (line) => console.log(line),
  onChange: () => {
    updateEgressState(egressProxyEnabled, egressProxyPort);
    tellHaruspexFallback();
  },
});

// Haruspex fails closed until told otherwise (config.EGRESS_UPSTREAM_FAILOPEN
// is False), so a Haruspex that never hears from the shell is the safe one.
function tellHaruspexFallback() {
  const cfg = appById("haruspex");
  if (!cfg || !cfg.url) return;
  fetch(new URL("/api/egress/failopen", cfg.url).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowed: egressNet.allowed(), why: egressNet.status().why }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});   // not running: it is already failing closed
}

function applyEgressProxy(ses) {
  if (!ses || typeof ses.setProxy !== "function") return;
  try {
    if (egressProxyEnabled) {
      // ",direct://" is Chromium's failover: if nothing answers on the port
      // (Haruspex stopped, crashed, still starting) the page goes direct
      // instead of failing with "proxy failed" -- unfiltered and unmasked.
      // So it is added only while egressNet says this machine is on a VPN and
      // off public networks; anywhere else the page fails until Haruspex is
      // back (it starts with the shell and is restarted if it dies).
      const fallback = egressNet.allowed() ? ",direct://" : "";
      ses.setProxy({
        proxyRules: `http://127.0.0.1:${egressProxyPort}${fallback}`,
        proxyBypassRules: EGRESS_BYPASS_RULES,
      });
      // Prevent WebRTC STUN/TURN IP leaks across external sessions
      if (typeof ses.setWebRTCIPHandlingPolicy === "function") {
        ses.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      }
    } else {
      ses.setProxy({ proxyRules: "direct://" });
      if (typeof ses.setWebRTCIPHandlingPolicy === "function") {
        ses.setWebRTCIPHandlingPolicy("default");
      }
    }
  } catch (err) {
    console.error("[egress] failed to apply proxy to session:", err.message);
  }
}

function updateEgressState(enabled, port = 8789) {
  egressProxyEnabled = !!enabled && egressHere();
  if (port) egressProxyPort = port;
  // Apply across default session, all wired partitions, and core personas.
  // forceReloadProxyConfig resets Chromium's bad-proxy list: after a failover
  // it keeps going direct for minutes, so without this Haruspex announcing
  // itself would not bring the tabs back through it until that ran out.
  const reloads = [];
  const reapply = (ses) => {
    applyEgressProxy(ses);
    if (typeof ses.forceReloadProxyConfig === "function") reloads.push(ses.forceReloadProxyConfig().catch(() => {}));
  };
  try { reapply(session.defaultSession); } catch {}
  const targets = new Set([...wiredPartitions, "persist:roam", "persist:agent", "persist:default"]);
  for (const part of targets) {
    try {
      reapply(session.fromPartition(part));
    } catch {}
  }
  // Only once the new rules are in, or the retry meets the old ones.
  Promise.all(reloads).then(retryProxyFailures).catch(() => {});
}

function wireSession(part, ses) {
  applyEgressProxy(ses);
  ses.on("will-download", (e, item, wc) => {
    const cfg = appForContents(wc);
    if (!can(cfg, "clip")) return; // not ours — leave Electron's default alone

    const staging = path.join(TROVE_DIR, "incoming");
    fs.mkdirSync(staging, { recursive: true });
    const staged = path.join(staging, `${Date.now().toString(36)}-${item.getFilename()}`);
    item.setSavePath(staged);
    item.once("done", (_ev, state) => {
      if (state !== "completed") { try { fs.unlinkSync(staged); } catch {} return; }
      try {
        const buffer = fs.readFileSync(staged);
        saveClip({
          kind: "download",
          buffer,
          mime: item.getMimeType(),
          srcUrl: item.getURL(),
          pageUrl: wc.getURL(),
          pageTitle: wc.getTitle(),
          filename: item.getFilename(),
          cfg,
          agent: "will-download",
        });
      } catch (err) {
        send("app-error", { id: cfg.id, message: `download not filed: ${String(err.message || err)}` });
      }
      try { fs.unlinkSync(staged); } catch {}
    });
  });

  const decide = (perm) => PERMS_ALLOWED.has(perm);
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const ok = decide(permission);
    if (!ok) {
      const cfg = appForContents(wc);
      send("app-status", { id: cfg?.id || activeId, message: `denied ${permission} to ${cfg?.name || "a page"}` });
    }
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission) => decide(permission));
}

// The one place a clip becomes a fact on disk. Writes the object and the index
// line FIRST, then fans out — a downstream being down must never lose a clip.
function saveClip({
  kind, buffer, mime, srcUrl, pageUrl, pageTitle, alt, linkUrl, text,
  filename, cfg, agent, fanout = [], preview,
}) {
  trove.ensure();
  const line = {
    v: 1,
    id: clipper.clipId(),
    t: Date.now(),
    at: new Date().toISOString(),
    kind,
    sha256: null, bytes: null, mime: mime || null, ext: null,
    object: null, thumb: null,
    src: {
      url: srcUrl || null, pageUrl: pageUrl || null, pageTitle: pageTitle || null,
      alt: alt || null, linkUrl: linkUrl || null,
    },
    app: cfg?.id || null,
    persona: cfg?.persona || null,
    text: text || null,
    note: null,
    tags: [],
    agent,
    fanout,
  };

  if (buffer && buffer.length) {
    const ext = path.extname(filename || "") || clipper.extFor(mime, srcUrl || "");
    const { sha, rel } = trove.writeObject(buffer, ext);
    line.sha256 = sha;
    line.bytes = buffer.length;
    line.ext = ext;
    line.object = rel;
    line.thumb = trove.writeThumb(buffer, sha);
  }

  // A page/link clip keeps no object — the URL is a pointer, not bytes — but
  // a pointer with no face reads as an empty pill in the Trove's grid. Where
  // the clip came off a live webContents we keep its picture as provenance
  // only: a thumb, never an object, and sha256 stays null so the line never
  // pretends to hold the page.
  if (preview && preview.length && !line.thumb) {
    line.thumb = trove.writeThumb(preview, clipper.sha256(preview));
  }

  trove.append(line);
  // A lead that is toggled on catches every clip that lands, whatever door it
  // came through — the bar's button, a right-click, an agent's deep-dive. That
  // breadth is the point: compiling a lead never means changing HOW you clip.
  // The filed line carries the clip's own agent, so the trail records the
  // gesture that fed the container, not just the gesture that made the lead.
  const L = leads.fold();
  if (L.active) {
    leads.append({
      v: 1, kind: "filed", lead: L.active, ref: line.id,
      t: Date.now(), at: new Date().toISOString(), agent: line.agent || null,
    });
  }
  busPublish("clip.added", { id: line.id, kind: line.kind, app: line.app, sha256: line.sha256 });
  send("clip-stats", { added: 1, id: line.id, kind: line.kind });
  return line;
}

// Fanout results are appended as their own index line referencing the clip,
// because index.jsonl is append-only — the archive is evidence, and evidence
// is not edited in place.
function noteFanout(clipLine, entry) {
  trove.append({
    v: 1, id: clipper.clipId(), t: Date.now(), at: new Date().toISOString(),
    kind: "fanout", ref: clipLine.id, sha256: clipLine.sha256 || null,
    fanout: [entry], agent: clipLine.agent,
  });
  send("clip-stats", { fanout: entry });
  // A hand-off that failed. Priority 1, not 2, on purpose: the rail already
  // shows this, and the line itself says the clip is safe either way — so this
  // is him noticing, not him raising an alarm. Another companion.js line that
  // nothing could reach before.
  if (entry && entry.ok === false) {
    mut.push({ key: `fanout:${entry.to || "?"}`, topic: "fanout", priority: 1, state: "sad" });
  }
}

// --------------------------------------------------------- clip actions
// Each is a menu verb's implementation. They report through the rail's status
// line, because a clip that silently failed is worse than no clip.

const clipMsg = (id, message, err) =>
  send(err ? "app-error" : "app-status", { id, message });

async function clipImage(cfg, params, { brain = false, character = null } = {}) {
  const url = params.srcURL;
  clipMsg(cfg.id, "clipping…");
  try {
    const ses = session.fromPartition(partitionFor(cfg));
    const { buffer, mime, status } = await clipper.fetchBytes(url, { ses, referer: params.pageURL });
    if (status >= 400) throw new Error(`source returned ${status}`);
    const line = saveClip({
      kind: "image", buffer, mime,
      srcUrl: url, pageUrl: params.pageURL, pageTitle: params.titleText, alt: params.altText,
      cfg, agent: "context-menu",
    });
    clipMsg(cfg.id, `clipped · ${Math.round(buffer.length / 1024)} KB`);

    if (character) {
      const name = path.basename(new URL(url).pathname) || `clip${line.ext || ".jpg"}`;
      const r = await clipper.toGlamoire({ characterId: character.id, filename: name, buffer, mime });
      noteFanout(line, { to: "glamoire", character: character.id, ...r, at: Date.now() });
      clipMsg(cfg.id, r.ok ? `sent to Glamoire · ${character.name}` : r.error, !r.ok);
    }
    if (brain) {
      const r = await clipper.toBrain({
        rite: "research",
        subject: params.titleText || params.altText || url,
        context: [url, params.pageURL, params.altText].filter(Boolean),
        meta: { clip: line.id, sha256: line.sha256 },
      });
      noteFanout(line, { to: "brain", ...r, at: Date.now() });
      clipMsg(cfg.id, r.ok ? "held for your verdict in the Brain" : r.error, !r.ok);
    }
  } catch (err) {
    clipMsg(cfg.id, `clip failed: ${String(err.message || err)}`, true);
  }
}

// A 320px picture of the page the gesture happened on, kept as provenance
// only. The capture failing must never cost the clip: worst case the line
// lands thumbless, same as it always did.
async function pagePreview(wc) {
  if (!wc || wc.isDestroyed()) return null;
  try {
    const img = await wc.capturePage();
    return img.isEmpty() ? null : img.toPNG();
  } catch { return null; }
}

async function clipLink(cfg, params, wc = null) {
  // A URL is not bytes: no object, no sha. The record shouldn't pretend.
  saveClip({
    kind: "link", srcUrl: params.linkURL, pageUrl: params.pageURL,
    pageTitle: params.titleText, text: params.linkText || null,
    linkUrl: params.linkURL, cfg, agent: "context-menu",
    preview: await pagePreview(wc),
  });
  clipMsg(cfg.id, "link clipped");
}

async function clipSelection(cfg, params, { brain = false } = {}) {
  const line = saveClip({
    kind: "selection", srcUrl: params.pageURL, pageUrl: params.pageURL,
    pageTitle: params.titleText, text: params.selectionText, cfg, agent: "context-menu",
  });
  clipMsg(cfg.id, "selection clipped");
  if (brain) {
    const r = await clipper.toBrain({
      rite: "research",
      subject: (params.selectionText || "").slice(0, 160),
      context: [params.selectionText, params.pageURL].filter(Boolean),
      meta: { clip: line.id },
    });
    noteFanout(line, { to: "brain", ...r, at: Date.now() });
    clipMsg(cfg.id, r.ok ? "held for your verdict in the Brain" : r.error, !r.ok);
  }
}

// `agent` is the gesture that chose this clip, and the Trove's whole claim is
// that nothing arrives ambiently — so the browser bar's button must not file
// itself as a right-click.
async function clipPage(cfg, params, agent = "context-menu", wc = null) {
  saveClip({
    kind: "page", srcUrl: params.pageURL, pageUrl: params.pageURL,
    pageTitle: params.titleText, cfg, agent,
    preview: await pagePreview(wc),
  });
  clipMsg(cfg.id, "page clipped");
}

// capturePage earns its place here specifically as provenance: this is what
// the page looked like when you collected it.
async function clipPageImage(cfg, view, agent = "context-menu") {
  try {
    const img = await view.webContents.capturePage();
    const buffer = img.toPNG();
    saveClip({
      kind: "page-image", buffer, mime: "image/png",
      srcUrl: view.webContents.getURL(), pageUrl: view.webContents.getURL(),
      pageTitle: view.webContents.getTitle(), filename: "page.png",
      cfg, agent,
    });
    clipMsg(cfg.id, "page image clipped");
  } catch (err) {
    clipMsg(cfg.id, `capture failed: ${String(err.message || err)}`, true);
  }
}

// Capability sanitising. A remote page with filesystem access is a remote
// code execution problem wearing a config file, so `fs` is stripped from any
// app of kind "external" no matter what the registry says.
function effectiveCaps(cfg) {
  let caps = Array.isArray(cfg?.capabilities) ? [...cfg.capabilities] : [];
  if (cfg?.kind === "external" && caps.includes("fs")) {
    console.warn(`[roost] dropping 'fs' from external app '${cfg.id}' — remote pages never get disk access`);
    caps = caps.filter((c) => c !== "fs");
  }
  if (cfg?.kind === "external" && caps.includes("apps")) {
    console.warn(`[roost] dropping 'apps' from external app '${cfg.id}' — remote pages never drive the shell`);
    caps = caps.filter((c) => c !== "apps");
  }
  if (cfg?.kind === "external" && caps.includes("bus")) {
    console.warn(`[roost] dropping 'bus' from external app '${cfg.id}' — remote pages never ride the bus`);
    caps = caps.filter((c) => c !== "bus");
  }
  if (caps.includes("fs") && !cfg.root) {
    console.warn(`[roost] dropping 'fs' from '${cfg.id}' — no "root" declared`);
    caps = caps.filter((c) => c !== "fs");
  }
  // DELIBERATE OMISSION: 'clip' is NOT stripped from external apps, and has no
  // preload surface at all. It is the first shell-side-only capability — it
  // grants a page nothing, it only tells the SHELL whether to offer clip verbs
  // in its own right-click menu. External sites are precisely where clipping
  // happens, so stripping it here would delete the feature. test.js asserts
  // this, so a future "consistency" pass can't helpfully add a fourth block.
  return caps;
}

function can(appCfg, capability) {
  return effectiveCaps(appCfg).includes(capability);
}

// One ScopedFs per app, confined to its declared root.
const scopes = new Map();
function scopeFor(cfg) {
  if (!can(cfg, "fs")) return null;
  if (!scopes.has(cfg.id)) scopes.set(cfg.id, new ScopedFs(path.resolve(ROOT, cfg.root)));
  return scopes.get(cfg.id);
}

// ------------------------------------------------------- local app launch

function portFromUrl(url) {
  try {
    const u = new URL(url);
    return Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  } catch {
    return null;
  }
}

function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect({ port, host: "127.0.0.1" });
      sock.setTimeout(1000);
      sock.on("connect", () => {
        sock.destroy();
        resolve(true);
      });
      const retry = () => {
        sock.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(attempt, 400);
      };
      sock.on("error", retry);
      sock.on("timeout", retry);
    };
    attempt();
  });
}

// Stopping a local app on Windows needs taskkill /T: the command was spawned
// through cmd.exe, so child.kill() would fell the shell and orphan the actual
// dev server, which then squats on the port forever.
const expectedExits = new Set(); // ids we killed ourselves — their exit is not a crash
function stopLocal(id) {
  const child = spawned.get(id);
  if (!child) return false;
  if (process.platform === "win32") {
    // taskkill can refuse (an elevated child, most commonly). Reporting the
    // server "stopped" while it squats its port would be worse than the
    // failure itself — so check, and keep tracking it on refusal.
    const r = require("node:child_process").spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    if (r.status !== 0) {
      send("app-error", { id, message: `couldn't stop it (taskkill exit ${r.status}) — elevated process?` });
      return false;
    }
  } else {
    try { child.kill(); } catch {}
  }
  expectedExits.add(id);
  spawned.delete(id);
  send("app-status", { id, message: "stopped" });
  send("apps-changed", {});
  busPublish("app.stopped", { app: id });
  return true;
}

async function restartLocal(id) {
  const cfg = appById(id);
  if (!cfg || cfg.kind !== "local") return { error: "not a local app" };
  stopLocal(id);
  // Give the port a beat to actually free before respawning onto it.
  await new Promise((r) => setTimeout(r, 800));
  const ok = await ensureLocal(cfg);
  const v = views.get(id);
  if (ok && v && !v.webContents.isDestroyed()) v.webContents.reload();
  return { restarted: ok };
}

// Two rapid activations of the same app must not spawn its dev server twice —
// the port probe below yields, and in that gap a second call would sail past
// the spawned.has check. Coalesce concurrent launches onto one promise.
const launching = new Map(); // appId -> Promise<boolean>
// What a local app is started with: this shell's environment (IFREGLEN_PORT
// among it, once the phone bridge is up), where the shell lives, and -- for an
// app on the bus -- the bus key. Haruspex publishes only when MUT_SYNC_TOKEN
// is in its environment, and was started without it, so it skipped every
// publish and said so only at debug level. The key is no wider for this: these
// apps already read it from secrets.json by path.
// XIXOXIS_SHELL is kept beside IFREGLEN_SHELL: Kenoma (C:\Forge) and Haruspex
// (C:\haruspex) read the old name to know a shell is their supervisor.
function childEnv(cfg) {
  const env = { ...process.env, IFREGLEN_SHELL: ROOT, XIXOXIS_SHELL: ROOT };
  if (effectiveCaps(cfg).includes("bus")) {
    const t = secretQuiet("MUT_SYNC_TOKEN");
    if (t) env.MUT_SYNC_TOKEN = t;
  }
  return env;
}

// Apps that start with the shell (or say "keepAlive": true) are kept
// running: one whose server goes away on its own is started again rather than
// left down until somebody opens its tile. ensureLocal looks before it
// spawns, so a healthy copy already serving the port is adopted, not doubled
// -- the Brain, for one, hands its port to a newer copy of itself and exits.
// It backs off (2 s, 5 s, 15 s, then a minute) and after five deaths in ten
// minutes leaves the app stopped and says so, rather than flapping.
const keepAliveDeaths = new Map();   // app id -> recent death timestamps
function keepAlive(cfg) {
  if (quitting || !(cfg.keepAlive === true || cfg.startWithShell === true)) return;
  const now = Date.now();
  const deaths = (keepAliveDeaths.get(cfg.id) || []).filter((t) => now - t < 10 * 60 * 1000);
  deaths.push(now);
  keepAliveDeaths.set(cfg.id, deaths);
  if (deaths.length > 5) {
    send("app-error", { id: cfg.id, message: "keeps dying (5 times in 10 minutes) — left stopped; Ctrl+L for logs" });
    return;
  }
  const delay = [2000, 5000, 15000, 60000, 60000][deaths.length - 1];
  send("app-status", { id: cfg.id, message: `starting again in ${Math.round(delay / 1000)} s` });
  setTimeout(() => {
    if (quitting || spawned.has(cfg.id)) return;
    const now2 = appById(cfg.id);
    if (now2) ensureLocal(now2).catch(() => {});
  }, delay);
}

function ensureLocal(cfg) {
  if (cfg.kind !== "local" || spawned.has(cfg.id)) return Promise.resolve(true);
  if (launching.has(cfg.id)) return launching.get(cfg.id);
  const p = doEnsureLocal(cfg).finally(() => launching.delete(cfg.id));
  launching.set(cfg.id, p);
  return p;
}

async function doEnsureLocal(cfg) {
  const port = portFromUrl(cfg.url);
  if (port && (await waitForPort(port, 600))) return true; // already running

  const cwd = path.resolve(ROOT, cfg.cwd || ".");
  if (!fs.existsSync(cwd)) {
    send("app-error", { id: cfg.id, message: `cwd not found: ${cwd}` });
    return false;
  }

  send("app-status", { id: cfg.id, message: "starting…" });
  // windowsHide: the shell is a GUI process with no console, so without it
  // every app launched here opened its own visible cmd window -- an empty one,
  // since its output is piped to the log (Ctrl+L), and one that killed the app
  // if closed. Health-check restarts added a fresh window each time.
  const child = spawn(cfg.command, { cwd, shell: true, stdio: "pipe", env: childEnv(cfg), windowsHide: true });
  spawned.set(cfg.id, child);

  // Read the URL out of the dev server's own output rather than guessing a
  // port from framework conventions. Conventions are wrong often enough to
  // be worse than useless; every dev server prints where it's listening.
  if (!cfg.url) {
    const sniff = (buf) => {
      const m = String(buf).match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)[^\s]*/i);
      if (m && !cfg.url) {
        cfg.url = m[0].replace(/[),.'"]+$/, "");
        send("app-status", { id: cfg.id, message: `found ${cfg.url}` });
      }
    };
    child.stdout.on("data", sniff);
    child.stderr.on("data", sniff);
  }

  const tap = (d) => {
    const line = String(d).slice(0, 400);
    pushLog(cfg.id, line);
    send("app-log", { id: cfg.id, line });
  };
  child.stdout.on("data", tap);
  child.stderr.on("data", tap);
  child.on("exit", (code) => {
    // restartLocal respawns onto the same id after only 800ms; if THIS exit
    // event belongs to the old child but lands after the new one registered,
    // touching the map would clobber the new child's tracking.
    if (spawned.get(cfg.id) !== child) {
      expectedExits.delete(cfg.id);
      return;
    }
    spawned.delete(cfg.id);
    // A server we killed exiting is routine; one dying on its own is news,
    // and news the toolbar should show in the error colour with a way in.
    const expected = expectedExits.delete(cfg.id);
    if (expected) {
      send("app-status", { id: cfg.id, message: `exited (${code})` });
    } else if (code === 0 || code == null) {
      send("app-status", { id: cfg.id, message: `exited (${code})` });
    } else {
      send("app-error", { id: cfg.id, message: `server died (exit ${code}) — Ctrl+L for logs` });
    }
    send("apps-changed", {});
    busPublish("app.exited", { app: cfg.id, code });
    if (!expected) keepAlive(cfg);
  });

  // Wait for a declared port, or for the child to announce one on stdout.
  if (port) {
    const ok = await waitForPort(port);
    if (!ok) send("app-error", { id: cfg.id, message: `port ${port} never opened` });
    else {
      send("apps-changed", {});
      busPublish("app.started", { app: cfg.id, url: cfg.url });
      afterLocalStarted(cfg);
    }
    return ok;
  }

  const deadline = Date.now() + 30000;
  while (!cfg.url && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));
  if (!cfg.url) {
    send("app-error", {
      id: cfg.id,
      message: "no URL printed in 30s — add \"url\" to the registry entry",
    });
    // Kill what we started: a launch that never produced a URL is usually a
    // misdetected non-server (a watcher, a CLI) that would otherwise sit in
    // `spawned` burning CPU forever with no way in but the task manager.
    stopLocal(cfg.id);
    return false;
  }
  const p2 = portFromUrl(cfg.url);
  if (p2 && !(await waitForPort(p2))) { stopLocal(cfg.id); return false; }

  afterLocalStarted(cfg);
  return true;
}

// Both ways a server comes up end here: health monitoring, and for Haruspex,
// the proxy. The declared-port branch above used to return before this was
// reached, so no app with a "url" -- every one HEALTH_DEFAULTS names -- was
// ever monitored, and a page that failed before Haruspex listened was never
// retried. Not awaited: a slow first probe must not hold up the start.
function afterLocalStarted(cfg) {
  verifyAppHealth(cfg).then((healthy) => { if (healthy) startHealthMonitoring(cfg); }).catch(() => {});
  if (cfg.id === "haruspex") whenEgressListens();
}

// Health monitoring for local apps
const healthChecks = new Map(); // appId -> intervalId

// Health config is data-driven: a registry entry may declare
//   "health": { "endpoint": "/api/status", "check": {"app": "haruspex"} }
// where `check` is an optional subset-of-JSON matcher. Defaults below cover
// the apps that predate the field, so no app is ever silently unmonitored+// just because nobody wrote its registry line. External/static apps have no
// server of their own, so they have nothing to check.
const HEALTH_DEFAULTS = {
  "goblin-brain": { endpoint: "/api/internal/ping", check: { app: "goblin-brain" } },
  "haruspex": { endpoint: "/api/status" },
  "forge": { endpoint: "/health", check: { ok: true } },
};

function healthConfigFor(cfg) {
  if (cfg.kind === "external" || cfg.kind === "static" || cfg.kind === "shell") return null;
  if (cfg.health && typeof cfg.health.endpoint === "string") return cfg.health;
  return HEALTH_DEFAULTS[cfg.id] || null;
}

// A restart is for an app that has STOPPED, never for one that is busy. One
// missed two-second probe used to taskkill the whole tree -- and Kenoma blocks+// its own event loop for seconds at a time (git checkpoints, sandboxing,
// reviews all run spawnSync), so a probe landing in one of those windows ended+// the turn mid-command. Now: three silent probes in a row (90 s), five seconds+// each, never while the app says it is mid-task, and at most three restarts in+// ten minutes -- a flapping app is reported, not flogged.
const HEALTH_EVERY_MS = 30000, HEALTH_STRIKES = 3;
const restartTimes = new Map(); // appId -> [ms]
function startHealthMonitoring(cfg) {
  if (!healthConfigFor(cfg)) return;
  if (healthChecks.has(cfg.id)) clearInterval(healthChecks.get(cfg.id));
  let strikes = 0, checking = false;
  const interval = setInterval(async () => {
    if (!spawned.has(cfg.id)) { clearInterval(interval); healthChecks.delete(cfg.id); return; }
    if (checking) return;
    checking = true;
    try {
      if ((await probeApp(cfg)) === "ok") { strikes = 0; return; }
      if (++strikes < HEALTH_STRIKES) return;
      if (await appBusy(cfg)) { strikes = HEALTH_STRIKES - 1; return; }
      const recent = (restartTimes.get(cfg.id) || []).filter((t) => Date.now() - t < 10 * 60 * 1000);
      if (recent.length >= 3) {
        send("app-error", { id: cfg.id, message: "keeps failing its health check — left stopped for you to look at (Ctrl+L for logs)" });
        clearInterval(interval); healthChecks.delete(cfg.id);
        return;
      }
      restartTimes.set(cfg.id, [...recent, Date.now()]);
      send("app-error", { id: cfg.id, message: `not answering for ${Math.round((strikes * HEALTH_EVERY_MS) / 1000)}s — restarting` });
      clearInterval(interval); healthChecks.delete(cfg.id);
      await restartLocal(cfg.id);
    } finally { checking = false; }
  }, HEALTH_EVERY_MS);
  healthChecks.set(cfg.id, interval);
}

// Verify the app at the URL is actually healthy and the correct instance.
// For apps with health endpoints, this catches stale instances or port squatters.+// What one probe found: "ok" (answered, as this app), "wrong" (something
// answered and it is not this app, or not well), or "silent" (refused, reset,+// or no answer inside the timeout -- which a busy app can also be).
async function probeApp(cfg, timeoutMs = 5000) {
  const health = healthConfigFor(cfg);
  if (!health) return "ok"; // no health check defined, assume healthy
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(health.endpoint, cfg.url).toString(), {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    if (!response.ok) return "wrong";
    const data = await response.json().catch(() => null);
    if (!data) return "wrong";
    // If the health config declares a `check` object, every key in it must
    // match the response (subset match). {app:"goblin-brain"} thus verifies
    // the port isn't squatted by some other app; a bare config (Haruspex)
    // just requires valid JSON.
    if (health.check && typeof health.check === "object") {
      return Object.entries(health.check).every(([k, v]) => data[k] === v) ? "ok" : "wrong";
    }
    return "ok";
 } catch {
    return "silent";
 } finally {
    clearTimeout(timer);
  }
}
async function verifyAppHealth(cfg) { return (await probeApp(cfg)) === "ok"; }
// Patient: a busy app answers late and one still booting answers not at all
// for a moment. `tries` probes, `gapMs` apart; the first "ok" wins.
async function probeUntilOk(cfg, tries, gapMs) {
  let last = "silent";
  for (let i = 0; i < tries; i++) {
    last = await probeApp(cfg);
    if (last === "ok") return "ok";
    if (i < tries - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return last;
}

// ----------------------------------------------------------------- views

function partitionFor(cfg) {
  // persist: prefix means the session survives restarts, which is what makes
  // a persona a persona rather than a fresh incognito window every time.
  return `persist:${cfg.persona || "default"}`;
}

// Live reload policy:
//   external            never — it's a website
//   local               off by default — the dev server pushes its own HMR,
//                       and a second reloader fights it. Opt in with
//                       "liveReload": true only if the server has no HMR.
//   static              on by default — nothing else will reload it
// Any app can force it either way with "liveReload": true|false.
function shouldWatch(cfg) {
  if (cfg.kind === "external") return false;
  if (typeof cfg.liveReload === "boolean") return cfg.liveReload;
  return cfg.kind === "static";
}

function watchRoot(cfg) {
  // Prefer the declared root: scanned static apps often keep index.html in
  // public/ or docs/ while the assets it references live at the project
  // root — watching only the html's own subfolder made reloads look flaky.
  if (cfg.root) return path.resolve(ROOT, cfg.root);
  if (cfg.kind === "static" && cfg.path) {
    return path.dirname(path.resolve(ROOT, cfg.path));
  }
  if (cfg.cwd) return path.resolve(ROOT, cfg.cwd);
  return null;
}

// Toggling live-reload OFF has to stick: did-finish-load re-runs startWatch
// on every reload, and for static apps shouldWatch defaults true — without
// this set, the user's explicit "off" silently reverted at the next Ctrl+R.
const watchDisabled = new Set();

function startWatch(cfg, view) {
  if (watchDisabled.has(cfg.id)) return;
  if (!shouldWatch(cfg) || watchers.has(cfg.id)) return;
  const dir = watchRoot(cfg);
  if (!dir) return;

  const w = new Watcher(dir, () => {
    const v = views.get(cfg.id);
    if (!v || v.webContents.isDestroyed()) return;
    // Preserve scroll position across the reload so editing doesn't fling you
    // back to the top on every save.
    v.webContents.executeJavaScript(
      "({x: window.scrollX, y: window.scrollY})", true
    ).then((pos) => {
      v.webContents.once("did-finish-load", () => {
        v.webContents.executeJavaScript(
          `window.scrollTo(${pos?.x || 0}, ${pos?.y || 0})`, true
        ).catch(() => {});
      });
      v.webContents.reload();
    }).catch(() => v.webContents.reload());
    send("app-status", { id: cfg.id, message: "reloaded" });
    setTimeout(() => send("app-status", { id: cfg.id, message: "" }), 1200);
  });

  if (w.start()) {
    watchers.set(cfg.id, w);
    send("app-status", { id: cfg.id, message: "watching for changes" });
    setTimeout(() => send("app-status", { id: cfg.id, message: "" }), 1500);
    // The `active` event already fired before this async start completed, so
    // the toolbar's live indicator is stale. Push the real state now.
    if (cfg.id === activeId) send("watch-state", { id: cfg.id, watching: true });
  }
}

// ---- an app that did not load ---------------------------------------------------
//
// A page that failed to load used to leave its view blank, with Chromium's own
// text in the rail -- and that text ends "loading '<address>'", which for a
// token-gated tile is its key, on screen. Now the view shows
// renderer/offline.html (the app's name and the error code, never the
// address), the shell watches for the app to answer and loads it back in by
// itself, and the rail gets the reason without the address. A static app
// whose index.html is not there yet (apps/ being built) lands here too, with
// a retry, rather than taking the shell down.
const OFFLINE_PAGE = path.join(ROOT, "renderer", "offline.html");
const OFFLINE_URL = pathToFileURL(OFFLINE_PAGE).href.toLowerCase();
const isOfflinePage = (u) => String(u || "").toLowerCase().startsWith(OFFLINE_URL);
const offline = new Map();   // app id -> {timer, wait}: watching for it to answer

// Where an app's view loads. Secrets are resolved at load time; activate()
// says why.
function appTarget(cfg) {
  return cfg.kind === "static"
    ? pathToFileURL(path.resolve(ROOT, cfg.path)).href
    : resolveSecrets(cfg.url);
}

// Chromium's reason, without the address it was loading.
function plainLoadError(err) {
  return String((err && err.message) || err || "did not load")
    .replace(/\s*loading\s+'[^']*'/g, "")
    .replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, "(address)")
    .trim();
}

// Any HTTP answer at all from the app's origin, within a few seconds.
function answers(url, timeout = 2500) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve(false); }
    const mod = u.protocol === "https:" ? require("node:https") : require("node:http");
    const req = mod.request({ host: u.hostname, port: u.port || undefined, path: "/", method: "HEAD", timeout, rejectUnauthorized: false },
      (res) => { res.resume(); resolve(true); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.on("error", () => resolve(false));
    req.end();
  });
}

function stopWatchingOffline(id) {
  const o = offline.get(id);
  if (o) { clearTimeout(o.timer); offline.delete(id); }
}

// The app itself, into its view again. A failure comes back through
// did-fail-load, which shows the notice and starts watching again.
function loadApp(id) {
  const cfg = appById(id), v = views.get(id);
  if (!cfg || !v || v.webContents.isDestroyed()) return;
  stopWatchingOffline(id);
  let target; try { target = appTarget(cfg); } catch { return; }
  v.webContents.loadURL(target).catch(() => {});
}

// The notice, and a watch on the app's address: every 3 s at first, easing to
// every 15 s, until anything answers there -- then the app is loaded back in.
// A file:// app (static) has nothing to watch; its notice only offers a retry.
function showOffline(cfg, code, desc) {
  const v = views.get(cfg.id);
  if (!v || v.webContents.isDestroyed()) return;
  let target = ""; try { target = appTarget(cfg); } catch {}
  const auto = /^https?:/i.test(target);
  const query = {
    app: cfg.name || cfg.id, code: String(code), desc: String(desc || ""),
    kind: cfg.kind || "", auto: auto ? "1" : "",
    n: String(Date.now()),
  };
  // Not from inside the failure's own event: Chromium is still committing its
  // error page there.
  setImmediate(() => { if (!v.webContents.isDestroyed()) v.webContents.loadFile(OFFLINE_PAGE, { query }).catch(() => {}); });
  if (!auto || offline.has(cfg.id)) return;
  const o = { timer: null, wait: 3000 };
  offline.set(cfg.id, o);
  // The watch ends when the view is no longer showing the notice: the app
  // came back some other way (a retry, a hibernated view woken). Not on
  // did-finish-load: Chromium finishes loading its own error page too.
  const tick = async () => {
    if (offline.get(cfg.id) !== o) return;
    const view = views.get(cfg.id);
    if (!view || view.webContents.isDestroyed() || !isOfflinePage(view.webContents.getURL())) { offline.delete(cfg.id); return; }
    const now = appById(cfg.id);
    let t = null; try { t = now && appTarget(now); } catch {}
    if (t && (await answers(t))) { if (offline.get(cfg.id) === o) loadApp(cfg.id); return; }
    if (offline.get(cfg.id) !== o) return;
    o.wait = Math.min(Math.round(o.wait * 1.5), 15000);
    o.timer = setTimeout(tick, o.wait);
  };
  o.timer = setTimeout(tick, o.wait);
}

function createView(cfg) {
  const part = partitionFor(cfg);
  const ses = session.fromPartition(part);
  // session.fromPartition returns the SAME Session object every call, and
  // hibernation re-runs createView — so without this guard the listeners below
  // stack, and after five hibernate/wake cycles one download writes five
  // index lines. It would never reproduce in a fresh-boot test.
  if (!wiredPartitions.has(part)) {
    wiredPartitions.add(part);
    wireSession(part, ses);
  }

  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(ROOT, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      session: ses,
      // Capabilities are read by preload from this argument, so a page cannot
      // grant itself anything by editing its own JS.
      additionalArguments: [
        `--roost-app=${cfg.id}`,
        `--roost-caps=${effectiveCaps(cfg).join(",")}`,
      ],
    },
  });

  // An app on the bus keeps its timers while it is out of sight. A hidden
  // page's timers are slowed to once a second, and after five minutes to
  // once a MINUTE -- which is how the Brain's bridge (a 2.5 s pump in its
  // tile) went quiet whenever another app was in front. Animation frames
  // still stop, so a hidden app draws nothing. An app can still choose
  // throttling with backgroundThrottling: true in the registry.
  if (cfg.backgroundThrottling !== true && effectiveCaps(cfg).includes("bus")) {
    view.webContents.setBackgroundThrottling(false);
  }

  // Links that want a new window land in The Wilds, not in Chrome.
  //
  // This is deliberately NOT gated on the `shell` capability the way the OS
  // hand-off is. `shell` answers "may this app fling a URL at my operating
  // system"; opening a tab in the browser next door is strictly less than
  // that — sandboxed as kind "external", visible, and closable. The old
  // behaviour for an app without `shell` was that the link did nothing at
  // all, which reads as a broken page rather than a policy.
  view.webContents.setWindowOpenHandler(({ url, disposition }) => {
    const bg = disposition === "background-tab";
    if (cfg.roam) roamOpen(url, { background: bg });
    else if (/^https?:/i.test(url)) openWeb(url, { background: bg });
    else if (can(cfg, "shell")) shell.openExternal(url);
    return { action: "deny" };
  });

  // Right-click. There is no menu in the shell at all without this — which
  // also means text fields have had no paste. The clip verbs appear only for
  // apps with the capability, and they are ABSENT rather than greyed: an
  // absent verb is an honest statement that this app isn't a clip source.
  view.webContents.on("context-menu", (_e, params) => {
    const items = [];
    const clippable = can(cfg, "clip");
    const isImage = params.mediaType === "image" && !!params.srcURL;

    if (clippable && isImage) {
      items.push({ label: "Clip image", click: () => clipImage(cfg, params) });
      items.push({ type: "separator" });
    }
    if (clippable && params.linkURL) {
      items.push({ label: "Clip link", click: () => clipLink(cfg, params, _e.sender) });
    }
    if (clippable && params.selectionText) {
      items.push({ label: "Clip selection", click: () => clipSelection(cfg, params) });
    }
    // The return leg of the coding handoff. You chat with a model however you
    // like — in a tab, like a person — and when a reply is worth having, this
    // is what carries it back: the Forge parses it, says per file what would
    // change, and writes nothing until you say so. No part of the chat is
    // automated, which is why this keeps working when a site redesigns itself.
    if (params.selectionText && cartridge.couldBeChangeSet(params.selectionText)) {
      items.push({ type: "separator" });
      items.push({
        label: "Preview through the Forge…",
        click: () => forgePreviewSelection(params.selectionText),
      });
    }
    if (clippable) {
      if (items.length) items.push({ type: "separator" });
      items.push({ label: "Clip this page", click: () => clipPage(cfg, params, "context-menu", _e.sender) });
      items.push({ label: "Clip this page as an image", click: () => clipPageImage(cfg, view) });
      items.push({ type: "separator" });
    }

    if (params.srcURL) items.push({ label: "Copy image address", click: () => clipboard.writeText(params.srcURL) });
    if (params.linkURL) {
      items.push({ label: "Copy link", click: () => clipboard.writeText(params.linkURL) });
      if (/^https?:/i.test(params.linkURL) && roamAvailable()) {
        // In-shell first. The OS browser is still offered, but as the thing
        // you ask for rather than the thing that happens to you.
        items.push({
          label: cfg.roam ? "Open link in a new tab" : "Open link in The Wilds",
          click: () => (cfg.roam ? roamOpen(params.linkURL, { background: true }) : openWeb(params.linkURL)),
        });
      }
      if ((can(cfg, "shell") || cfg.roam) && /^https?:/i.test(params.linkURL)) {
        items.push({ label: "Open link in system browser", click: () => shell.openExternal(params.linkURL) });
      }
    }
    items.push({ label: "Copy page URL", click: () => clipboard.writeText(view.webContents.getURL()) });

    if (params.isEditable) {
      items.push({ type: "separator" });
      items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
    } else if (params.selectionText) {
      items.push({ type: "separator" }, { role: "copy" });
    }

    // No x/y on purpose: params.x/y are in the VIEW's coordinate space and the
    // app view is offset by railW, which changes when the rail folds. Letting
    // popup() use the cursor is correct by construction.
    Menu.buildFromTemplate(items).popup({ window: win });
  });

  // Capabilities ride the WebContents, not the page — a preload re-runs with
  // full caps on every navigation. So a static or local app must never be
  // allowed to navigate in place to a foreign origin: a stray <a href>, a
  // redirect, or a compromised dev dependency would hand window.roost.fs to
  // a remote page. Cross-origin navigations bounce to the real browser
  // instead, same policy as window.open. External apps roam free — their
  // dangerous caps are already stripped by effectiveCaps.
  if (cfg.kind !== "external") {
    const homeOrigin = (() => {
      try {
        return cfg.kind === "static"
          ? "file://"
          : new URL(cfg.url).origin;
      } catch { return null; }
    })();
    view.webContents.on("will-navigate", (e, url) => {
      let ok = false;
      try {
        ok = homeOrigin === "file://" ? url.startsWith("file:") : new URL(url).origin === homeOrigin;
      } catch {}
      if (!ok) {
        e.preventDefault();
        if (/^https?:/i.test(url)) {
          openWeb(url);
          send("app-status", { id: cfg.id, message: "off-origin link opened in The Wilds" });
        } else if (can(cfg, "shell")) {
          // A non-web scheme (mailto:, a protocol handler) is genuinely the
          // OS's job, and handing one over is still what `shell` gates.
          shell.openExternal(url);
          send("app-status", { id: cfg.id, message: "handed to your system" });
        }
      }
    });
  }

  view.webContents.on("did-finish-load", () => {
    send("app-status", { id: cfg.id, message: "" });
    // Re-assert the remembered zoom: Chromium resets the factor per-load.
    const z = uiState.zoom[cfg.id];
    if (z && z !== 1) view.webContents.setZoomFactor(z);
    startWatch(cfg, view);
  });

  // Find-in-page results stream back to the toolbar's find bar ("3/17").
  view.webContents.on("found-in-page", (_e, r) => {
    send("find-result", { id: cfg.id, matches: r.matches, active: r.activeMatchOrdinal });
  });

  // Renderer health. None of this was watched before, so an app whose renderer
  // was OOM-killed simply became a white rectangle and the shell said nothing
  // at all — the single worst thing it could stay quiet about, since it is the
  // one failure it cannot recover from on its own.
  view.webContents.on("did-start-loading", () => { view._gone = false; });
  view.webContents.on("render-process-gone", (_e, d) => {
    if (d.reason === "clean-exit") return;
    view._gone = true;
    busPublish("app.gone", { app: cfg.id, reason: d.reason });
    // Shell-owned static pages (the Sanctum, the Trove) hold their state in
    // roost.store / disk, not unsaved form buffers, so a GPU reset or OOM
    // while minimized can safely bring them back instead of leaving a black
    // window. Bounded to 3 reloads per minute like revive().
    if (cfg.kind === "static") {
      const now = Date.now();
      view._revives = (view._revives || []).filter((t) => now - t < 60000);
      if (view._revives.length < 3) {
        view._revives.push(now);
        try { view.webContents.reload(); return; } catch {}
      }
    }
    send("app-error", { id: cfg.id, message: `renderer gone (${d.reason}) — Ctrl+R to bring it back` });
  });
  // Hung, then recovered. The hang expires unshown if it resolves quickly:
  // reading out a stall that ended a minute ago is worse than silence.
  view.webContents.on("unresponsive", () => busPublish("app.hung", { app: cfg.id }));
  view.webContents.on("responsive", () => mut.glance("happy", 1400));
  view.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    // -3 is ERR_ABORTED, which fires on every ordinary cancelled navigation.
    // Without this filter he flinches whenever you click a link mid-load.
    if (!isMainFrame || code === -3) return;
    busPublish("app.offline", { app: cfg.id, code, desc });
    if (code === ERR_PROXY_CONNECTION_FAILED) proxyFailedApps.add(cfg.id);
    // The notice is a local file and does not fail, but if it did it must not
    // be answered with itself.
    if (!isOfflinePage(url)) showOffline(cfg, code, desc);
  });
  // The notice asks for things by its own #fragment (renderer/offline.html
  // says why).
  view.webContents.on("did-navigate-in-page", (_e, url) => {
    if (!isOfflinePage(url)) return;
    const h = new URL(url).hash;
    if (h.startsWith("#retry")) loadApp(cfg.id);
    else if (h.startsWith("#logs")) send("logs-open", { id: cfg.id });
  });

  // Back/forward state, mostly for external apps — a site with no browser
  // chrome around it is a site you can get stuck inside.
  const pushNav = () => sendNavState(cfg.id);
  view.webContents.on("did-navigate", pushNav);
  view.webContents.on("did-navigate-in-page", pushNav);

  wireHotkeys(view.webContents);
  return view;
}

// The active page for an app id. For an ordinary app that is its view; for
// The Wilds it is whichever tab is in front. Routing every rail control
// through here is what gives the browser back/forward, reload, find, zoom and
// devtools without a second copy of any of them.
function wcFor(id) {
  if (id === ROAM_ID) return roamWc();
  const v = views.get(id);
  return v && !v.webContents.isDestroyed() ? v.webContents : null;
}

// Keys go where the eyes are: the app in front or, for a blank tab in The
// Wilds, its address bar. Called after every switch and when a sheet closes.
// Switching from the rail, the palette or Ctrl+1…9 used to leave the keyboard
// on the page you had left (or on the rail), so the first thing typed after a
// switch went somewhere you could not see. Never while a sheet is up: the
// sheet has the keyboard then, and roost:overlay hands it over as it closes.
function focusActive() {
  if (overlayOpen || !activeId) return;
  try {
    if (activeId === ROAM_ID && roamTabs.get(roamTabActive)?.blank) roamFocusBar(true);
    else wcFor(activeId)?.focus();
  } catch {}
}

function sendNavState(id) {
  if (id !== activeId) return;
  besidePush();   // the panel's "in front" line follows the page
  const wc = wcFor(id);
  if (!wc || wc.isDestroyed()) return;
  const h = wc.navigationHistory;
  send("nav-state", {
    id,
    canBack: h ? h.canGoBack() : wc.canGoBack(),
    canForward: h ? h.canGoForward() : wc.canGoForward(),
    url: wc.getURL() || "",
    zoom: wc.getZoomFactor(),
  });
}

function navigate(id, dir) {
  const wc = wcFor(id);
  if (!wc) return;
  const h = wc.navigationHistory;
  if (dir === "back") { if (h ? h.canGoBack() : wc.canGoBack()) (h ? h.goBack() : wc.goBack()); }
  else if (dir === "forward") { if (h ? h.canGoForward() : wc.canGoForward()) (h ? h.goForward() : wc.goForward()); }
}

// Zoom ladder rather than free multiplication, so repeated in/out lands back
// on the exact factor it started from. Persisted per app.
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
function zoom(id, dir) {
  const wc = wcFor(id);
  if (!wc) return;
  let f = wc.getZoomFactor();
  if (dir === "reset") f = 1;
  else {
    // Nearest rung, then step.
    let i = 0;
    for (let j = 1; j < ZOOMS.length; j++) {
      if (Math.abs(ZOOMS[j] - f) < Math.abs(ZOOMS[i] - f)) i = j;
    }
    i = Math.max(0, Math.min(ZOOMS.length - 1, i + (dir === "in" ? 1 : -1)));
    f = ZOOMS[i];
  }
  wc.setZoomFactor(f);
  uiState.zoom[id] = f;
  saveUiState();
  send("zoom", { id, factor: f });
}

// Hibernate: tear the view down entirely and give Chromium its renderer
// process back. The app's persona (cookies, localStorage) survives — only the
// running page goes away.
function closeView(id) {
  // The browser is a bar plus N tabs rather than one view, so the rail's ✕,
  // middle-click and Ctrl+W all funnel through its own teardown. The session
  // is written on the way out, so reopening lands on the same pages.
  if (id === ROAM_ID) {
    if (!roamBar && !roamTabs.size) return { closed: false, error: "not open" };
    const refused = roamShutdown();
    if (refused?.error) return { closed: false, error: refused.error };
    if (activeId === ROAM_ID) {
      const home = config.defaultApp && appById(config.defaultApp) ? config.defaultApp : config.apps[0]?.id;
      if (home && home !== id) activate(home);
      else activeId = null;
    }
    send("apps-changed", {});
    busPublish("app.hibernated", { app: id });
    return { closed: true };
  }
  const view = views.get(id);
  if (!view) return { closed: false, error: "not open" };
  const w = watchers.get(id);
  if (w) { try { w.stop(); } catch {} watchers.delete(id); }
  try { win.contentView.removeChildView(view); } catch {}
  try { view.webContents.close(); } catch {}
  views.delete(id);
  if (activeId === id) {
    const home = config.defaultApp && appById(config.defaultApp) ? config.defaultApp : config.apps[0]?.id;
    if (home && home !== id) activate(home);
    else activeId = null;
  }
  send("apps-changed", {});
  busPublish("app.hibernated", { app: id });
  return { closed: true };
}

// When a modal is open the rail view is grown to cover the window, because
// its normal width would clip any sheet rendered inside it. Same discipline
// as the old 46px strip, rotated ninety degrees.
let overlayOpen = false;

// Last non-empty content bounds. On Windows, minimizing a BaseWindow fires a
// resize with 0x0 content bounds; laying views out against 0x0 crushes the
// active view to negative/zero width (breaking its DirectComposition surface
// so restoring leaves a black window) and zeroes every open Wilds tab.
let lastContentBounds = { width: 1480, height: 920 };
function contentBounds() {
  if (!win || win.isDestroyed()) return lastContentBounds;
  try {
    const b = win.getContentBounds();
    if (!win.isMinimized() && b && b.width > 0 && b.height > 0) {
      lastContentBounds = { width: b.width, height: b.height };
    }
  } catch {}
  return lastContentBounds;
}

function layout() {
  if (!win || win.isDestroyed()) return;
  // `width` is the app area's right edge: the window less Beside's column when
  // the panel is out. Everything below lays out against it, so the app in
  // front and the herald both end where the panel begins.
  const { width: fullW, height } = contentBounds();
  const besideW = besideWidth(fullW);
  const width = fullW - besideW;
  chromeView.setBounds({
    x: 0,
    y: 0,
    width: overlayOpen ? fullW : railW,
    height,
  });
  // Only the app in front is drawn. The rest are hidden at the size they last
  // had, the way The Wilds' tabs already are (roamLayout): parking them at
  // 0×0 squeezed every background page to nothing and laid it out again on
  // each switch. A hidden view is resized when it next comes to the front,
  // so dragging the window's edge does not lay out every open app at each
  // step.
  for (const [vid, v] of views) {
    if (vid === activeId) { v.setBounds({ x: railW, y: 0, width: Math.max(0, width - railW), height: Math.max(0, height) }); v.setVisible(true); }
    else v.setVisible(false);
  }
  if (heraldView) {
    // Flush with the window's right edge, so a card slides in from the edge of
    // the window rather than from the middle of the page; below The Wilds' bar
    // when the browser is in front, so it never sits on the address field.
    const top = activeId === ROAM_ID ? ROAM_BAR_H : 0;
    const w = Math.min(heraldW > 0 ? heraldW : HERALD_W, Math.max(0, width - railW));
    const h = Math.max(0, Math.min(heraldH, height - top));
    heraldView.setBounds({ x: width - w, y: top, width: w, height: Math.max(1, h) });
    heraldView.setVisible(h > 0 && !overlayOpen);
  }
  besideLayout(width, besideW, height);
  // roamLayout hides the bar and every tab whenever the browser is not the
  // active app, which is what stands in for views' zeroing loop.
  roamLayout();
  besidePush();
}

// A slow dev-server launch must not steal focus back: if the user activates
// something else while ensureLocal is still waiting on a port, the stale
// continuation walks away instead of yanking the window to the old choice.
let activateSeq = 0;
async function activate(id) {
  const cfg = appById(id);
  if (!cfg) return;
  if (cfg.kind === "browser") return activateRoam();

  const token = ++activateSeq;
  if (cfg.kind === "local" && !(await ensureLocal(cfg))) return;
  if (token !== activateSeq) return; // the user moved on while the server booted

  let view = views.get(id);
  if (!view) {
    view = createView(cfg);
    views.set(id, view);
    win.contentView.addChildView(view);
    // Re-adding raises him (and the herald) back above the app view just
    // added — without this a cold-started app lands on top of them.
    raiseFloats();

    // pathToFileURL rather than string concatenation: a Windows absolute path
    // ("C:\McScrapey\…") glued onto "file://" makes the drive letter parse as
    // a hostname. This handles drive letters, backslashes and spaces properly.
    // Secrets are resolved again here, at open time. The registry resolved
    // them once at start-up, and a secret written after that would otherwise
    // stay a literal ${...} in the tile's address until the next restart.
    // A failure also shows the notice in the view (showOffline); the rail
    // gets the reason without the address.
    const target = appTarget(cfg);
    view.webContents.loadURL(target).catch((err) =>
      send("app-error", { id, message: plainLoadError(err) })
    );
  }

  if (activeId && activeId !== id) {
    lastSeen.set(activeId, Date.now());
    mut.glance("surprised", 1100);   // he looks up
  }
  activeId = id;
  layout();
  send("active", {
    id,
    watching: watchers.has(id),
    canWatch: cfg.kind !== "external",
  });
  sendNavState(id);
  send("apps-changed", {}); // open/active states just moved — keep the rail honest now, not at the next poll
  focusActive();
}

const send = (channel, payload) => {
  if (channel === "app-error" || channel === "app-status") mutSees(channel, payload);
  // Müt's own channel has no view to land in any more; the rail does not
  // listen for it either. Everything else goes to the rail.
  if (channel === "mut") return;
  if (chromeView && !chromeView.webContents.isDestroyed()) {
    chromeView.webContents.send(channel, payload);
  }
};

// --------------------------------------------------------------- The Wilds
//
// A browser inside the shell, instead of a hand-off to one outside it.
//
// Every link that left this window used to end up in Chrome, and the moment
// you followed one you were out of the ecosystem: no persona jar, no clip
// verbs, no Müt, no Trove — just a tab in a different program. The Wilds
// closes that hole. It is not a new engine. It is the SAME machinery every
// hosted app already runs on, pointed at an address bar instead of a registry
// entry.
//
// That reuse is the design, not a shortcut. A tab is a WebContentsView built
// by createView() from a synthesized config of kind "external", so:
//
//   * effectiveCaps strips fs, apps and bus from it by the
//     same code path, for the same reason, as any other remote page. There is
//     no second security story to keep in sync — and a browser is precisely
//     where a second, laxer one would be fatal.
//   * the right-click clip verbs, the download-into-the-Trove handler, the
//     permission default-deny, find-in-page, zoom and every hotkey work on
//     arbitrary web pages with no new code at all.
//   * a tab lives in a persona's cookie jar, which is the thing a browser tab
//     cannot give you: logged into a board as `curio` here, signed out as
//     `roam` in the next tab, deliberately, neither able to see the other.
//
// Tabs are NOT in `views`. Same reasoning as Müt's view: everything that
// iterates that map — auto-rest, metrics, activate()'s zeroing, the rail's
// list — means "hosted apps", and a tab is not one.

let besideBar = null, besideView = null;
let besideChat = null;      // the chat the panel's view was built for
let besideShown = false;    // the panel is out; its view outlives a close, so the conversation survives one
let besideShared = null;    // the last page handed over: { url, title, chars, cut, how, at }
let besideNote = null;      // why the last Share did not land, for the bar to say
let roamBar = null;
let roamBarTall = false;
// Whether roamLayout last decided the browser should be on screen. Recorded
// rather than inferred, because it is the one thing that must be recomputed
// on every app switch: a path that changes the active app without reaching
// layout() would leave the browser painted over whatever you switched to.
let roamVisible = false;
// Background tabs kept LIVE: visible to Chromium, so animation frames and
// timers run, but placed just outside the window so nothing is drawn where
// you are looking. A hidden page gets no requestAnimationFrame at all, and
// Gemini's send waits on one: the chat verb lights a tab for the length of
// one exchange. tabId -> count of exchanges holding it lit.
const roamLit = new Map();
function roamLight(id, on) {
  const n = (roamLit.get(id) || 0) + (on ? 1 : -1);
  if (n > 0) roamLit.set(id, n); else roamLit.delete(id);
  // Placement alone was not enough: a view outside the window still reported
  // document.visibilityState "hidden". Electron's background-throttling
  // switch is what keeps a background page's timers, frames and visibility
  // running; it goes back on when the exchange ends.
  const t = roamTabs.get(id);
  try { if (t && !t.view.webContents.isDestroyed()) t.view.webContents.setBackgroundThrottling(!roamLit.has(id)); } catch {}
  roamLayout();
}
const roamTabs = new Map();   // tabId -> { id, view, persona, url, title, loading, failed }
let roamOrder = [];           // tabId[] — the strip's left-to-right order
let roamTabActive = null;
let roamSeq = 0;
const roamClosed = [];        // recently closed, newest last — Ctrl+Shift+T

function roamEntry() {
  return appById(ROAM_ID) || null;
}
// If the registry entry is deleted the browser simply isn't there, and every
// caller falls back to the OS browser rather than throwing. Removing a line
// from apps.config.json should never be able to break link-opening.
function roamAvailable() {
  return !!roamEntry();
}
function roamSearchTemplate() {
  return roamEntry()?.search || roamLib.DEFAULT_SEARCH;
}
function roamHomeUrl() {
  return roamEntry()?.home || null;
}
function roamRecords() {
  return roamEntry()?.history !== false;
}

// Which jars you are allowed to browse in: every persona the registry names,
// plus the ones its pins name.
function roamPersonas() {
  const out = [ROAM_PERSONA];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  for (const a of config.apps) add(a.persona || "default");
  // Pins name jars too, and a pinned jar may belong to no app at all.
  //
  // `curio` was exactly this case: it existed only because four "Boards" app
  // entries declared it, and the moment those became pins the shell stopped
  // recognising the jar its own pins pointed at — so clicking Pinterest would
  // have opened it logged out, silently, which is the one failure that makes
  // pinning a signed-in board pointless.
  for (const p of roamEntry()?.pins || []) add(p.persona);
  for (const p of roam.state.pins || []) add(p.persona);
  return out;
}

// Why a jar was refused.
function roamPersonaRefusal(name) {
  return `no jar called '${name}' — it belongs to no app and no pin`;
}
function roamPersonaOk(name) {
  return roamPersonas().includes(name);
}

// The config a tab is built from. Kind "external" is the load-bearing word
// here: it is what makes effectiveCaps strip everything dangerous. `clip` is
// shell-side only — it grants the page nothing, it tells the SHELL to offer
// clip verbs in its own right-click menu, which is the entire reason browsing
// in here beats browsing out there.
function roamTabCfg(tab) {
  return {
    id: `roam:${tab.id}`,
    name: tab.title || "The Wilds",
    kind: "external",
    url: tab.url || "about:blank",
    persona: tab.persona,
    capabilities: ["clip"],
    roam: tab.id,              // createView keys its browser behaviour on this
  };
}

function roamNewTabUrl() {
  return pathToFileURL(path.join(ROOT, "renderer", "roam", "newtab.html")).href;
}

// The shell's OWN views — the rail, the herald, the browser's bar — are built
// directly rather than through createView, so they never got its window-open
// handler. With none set, Electron's default for window.open or a
// target="_blank" is to spawn a NATIVE WINDOW: the exact thing this whole
// feature exists to stop, reachable from the one surface nobody would think
// to check. None of those pages does it today, which is precisely why it
// would go unnoticed until one did.
function sealView(view) {
  view.webContents.setWindowOpenHandler(({ url, disposition }) => {
    if (/^https?:/i.test(url)) openWeb(url, { background: disposition === "background-tab" });
    return { action: "deny" };
  });
}

function roamEnsureBar() {
  if (roamBar && !roamBar.webContents.isDestroyed()) return roamBar;
  roamBar = new WebContentsView({
    webPreferences: {
      preload: path.join(ROOT, "preload-roam.js"),
      contextIsolation: true,
    },
  });
  // Transparent so the dropdown can grow over the page without painting a
  // slab of background across it — only what the CSS draws is opaque.
  roamBar.setBackgroundColor("#00000000");
  sealView(roamBar);
  win.contentView.addChildView(roamBar);
  roamBar.webContents.loadFile(path.join(ROOT, "renderer", "roam", "index.html"));
  roamBar.webContents.on("did-finish-load", () => {
    if (roamBarTall) { roamBarTall = false; roamLayout(); }
    roamPush();
  });
  // Shell UI, so reloading costs nothing and losing it costs the whole
  // browser — same call as the rail, without the dialog.
  roamBar.webContents.on("render-process-gone", (_e, d) => {
    if (d.reason === "clean-exit") return;
    console.warn(`[roost] The Wilds' bar died (${d.reason}) — reloading`);
    try { roamBar.webContents.reload(); } catch {}
  });
  wireHotkeys(roamBar.webContents);
  return roamBar;
}

// A tab. Everything interesting happens in createView; this adds only the
// reporting the bar needs and the history recording.
function roamNewTab({ url, persona, background = false, index = null, agent = false } = {}) {
  roamEnsureBar();
  const id = `t${++roamSeq}`;
  const tab = {
    id,
    agent,
    persona: agent ? (persona || AGENT_PERSONA)
      : (roamPersonaOk(persona) ? persona : ROAM_PERSONA),
    url: url || roamNewTabUrl(),
    title: "",
    loading: true,
    failed: null,
    blank: !url,
  };
  const view = createView(roamTabCfg(tab));
  tab.view = view;
  roamTabs.set(id, tab);
  roamOrder.splice(index == null ? roamOrder.length : index, 0, id);

  const wc = view.webContents;
  const mark = () => {
    tab.url = wc.getURL() || tab.url;
    tab.title = wc.getTitle() || "";
    tab.blank = tab.url.startsWith("file:") && tab.url.includes("/roam/newtab.html");
    roamPush();
  };
  wc.on("did-start-loading", () => { tab.loading = true; tab.failed = null; roamPush(); });
  wc.on("did-stop-loading", () => { tab.loading = false; mark(); });
  wc.on("page-title-updated", (_e, title) => {
    tab.title = title;
    if (roamRecords()) roam.retitle(tab.url, title);
    roamPush();
  });
  wc.on("did-navigate", (_e, navUrl) => {
    tab.url = navUrl;
    tab.failed = null;
    if (roamRecords()) roam.visit({ url: navUrl, title: wc.getTitle(), persona: tab.persona });
    mark();
    roamRemember();
  });
  wc.on("did-navigate-in-page", (_e, navUrl, isMainFrame) => {
    if (!isMainFrame) return;
    tab.url = navUrl;
    mark();
  });
  wc.on("did-fail-load", (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return;   // -3 is every cancelled navigation
    tab.loading = false;
    tab.failed = { code, desc, url: failedUrl };
    // Kept apart from `failed`, which the error page's own commit clears
    // (did-navigate): retryProxyFailures needs to know after that.
    tab.proxyFailed = code === ERR_PROXY_CONNECTION_FAILED ? failedUrl : null;
    egressTrace("tab did-fail-load", code, desc, failedUrl);
    roamPush();
  });
  wc.on("did-finish-load", () => {
    // createView re-asserts uiState.zoom[cfg.id], and a tab's synthesized id
    // is never in there. The browser's zoom is remembered under "roam", so
    // apply it here or every new tab silently resets to 100%.
    const z = uiState.zoom[ROAM_ID];
    if (z && z !== 1) wc.setZoomFactor(z);
  });

  win.contentView.addChildView(view);
  // Raise the bar back above the page, then the herald above both —
  // addChildView on an already-added view re-stacks it, which is how
  // activate() keeps them on top of a cold-started app.
  if (roamBar) win.contentView.addChildView(roamBar);
  raiseFloats();

  wc.loadURL(tab.url).catch(() => {});
  if (!background || roamTabActive == null) roamTabActive = id;
  roamLayout();
  roamPush();
  return tab;
}

// The single entry point for going somewhere.
//
// `here` is the difference between the two gestures that both end up in this
// function. Typing in the ADDRESS BAR navigates the tab you are looking at —
// anything else would make every typed address spawn a tab, which is the one
// thing a browser must not do. A link from a hosted app, or the palette, gets
// a tab of its own instead; it only takes over the current one when that is
// still blank, so following a link doesn't leave an empty page behind it.
function roamOpen(input, { background = false, persona = null, newTab = false, here = false } = {}) {
  roamEnsure();
  const { url, searched, query } = roamLib.resolve(input, roamSearchTemplate());
  if (!url) return null;

  const current = roamTabs.get(roamTabActive);
  const inPlace = current && !newTab && !background
    && (!persona || persona === current.persona)
    && (here || current.blank);
  if (inPlace) {
    current.loading = true;
    current.blank = false;
    current.view.webContents.loadURL(url).catch(() => {});
    roamPush();
    return { tab: current, searched, query };
  }
  const tab = roamNewTab({ url, persona: persona || current?.persona, background });
  return { tab, searched, query };
}

// What the rest of the shell calls when a link wants to leave a hosted app.
// http(s) goes to The Wilds; anything else (mailto:, a downloaded file, a
// custom scheme) is genuinely the OS's job and still goes there.
function openWeb(url, { background = false } = {}) {
  if (!/^https?:/i.test(url) || !roamAvailable()) {
    try { shell.openExternal(url); } catch {}
    return null;
  }
  const r = roamOpen(url, { background });
  if (!background) activate(ROAM_ID);
  return r;
}

function roamSelect(tabId) {
  if (!roamTabs.has(tabId)) return;
  roamTabActive = tabId;
  // Switching tabs is an unambiguous "I have moved on", and it is the escape
  // valve if a sheet is ever left open: the bar covers the page while it is
  // tall, so it must never be able to strand one.
  roamCollapse();
  roamLayout();
  roamPush();
  roamAnnounce();
  sendNavState(ROAM_ID);
}

function roamCloseTab(tabId) {
  const tab = roamTabs.get(tabId);
  if (!tab) return;
  if (tab.url && /^https?:/i.test(tab.url)) {
    roamClosed.push({ url: tab.url, persona: tab.persona, title: tab.title });
    if (roamClosed.length > 20) roamClosed.shift();
  }
  const i = roamOrder.indexOf(tabId);
  try { win.contentView.removeChildView(tab.view); } catch {}
  try { tab.view.webContents.close(); } catch {}
  roamTabs.delete(tabId);
  roamOrder = roamOrder.filter((x) => x !== tabId);

  if (roamTabActive === tabId) {
    // The neighbour on the right, else the left — what every browser does,
    // and the only order that doesn't fling you across the strip.
    roamTabActive = roamOrder[Math.min(i, roamOrder.length - 1)] || null;
  }
  // Closing the last tab leaves the browser standing with a blank page rather
  // than silently teleporting you to another app mid-gesture.
  if (!roamTabs.size && activeId === ROAM_ID) roamNewTab({});
  roamLayout();
  roamPush();
  roamRemember();
  sendNavState(ROAM_ID);
}

function roamReopen() {
  const last = roamClosed.pop();
  if (!last) return null;
  return roamNewTab({ url: last.url, persona: last.persona });
}

// Changing a tab's persona means changing its cookie jar, and a jar is fixed
// when the view is created. So this is a rebuild at the same address, said out
// loud rather than pretended away: the page reloads, and anything it held in
// memory is gone, because that is what moving jars actually means.
function roamSetPersona(tabId, persona) {
  const tab = roamTabs.get(tabId);
  if (!tab) return { error: "no such tab" };
  if (!roamPersonaOk(persona)) return { error: roamPersonaRefusal(persona) };
  if (tab.persona === persona) return { ok: true };
  const at = roamOrder.indexOf(tabId);
  const url = tab.url;
  const wasActive = roamTabActive === tabId;
  roamCloseTabQuiet(tabId);
  // Carry the agent mark across. Rebuilding the view is an implementation
  // detail of changing jars; "an agent opened this" is a fact about the tab,
  // and losing it would quietly remove the one visible sign that something
  // other than the person is driving.
  const fresh = roamNewTab({ url, persona, index: at, background: !wasActive, agent: tab.agent });
  if (wasActive) roamTabActive = fresh.id;
  roamLayout();
  roamPush();
  return { ok: true, persona };
}

// Teardown without the reopen-stack entry or the last-tab backfill — used by
// persona switching, where a new tab is about to take the old one's place.
function roamCloseTabQuiet(tabId) {
  const tab = roamTabs.get(tabId);
  if (!tab) return;
  try { win.contentView.removeChildView(tab.view); } catch {}
  try { tab.view.webContents.close(); } catch {}
  roamTabs.delete(tabId);
  roamOrder = roamOrder.filter((x) => x !== tabId);
}

function roamMove(tabId, index) {
  if (!roamTabs.has(tabId)) return;
  roamOrder = roamOrder.filter((x) => x !== tabId);
  roamOrder.splice(Math.max(0, Math.min(index, roamOrder.length)), 0, tabId);
  roamPush();
}

// Cycle tabs. In the browser Ctrl+Tab means "next tab" to every finger that
// has ever used a browser, so it means that here too; apps stay on Ctrl+1…9
// and the palette.
function roamCycle(back = false) {
  if (roamOrder.length < 2) return;
  const i = Math.max(0, roamOrder.indexOf(roamTabActive));
  roamSelect(roamOrder[(i + (back ? roamOrder.length - 1 : 1)) % roamOrder.length]);
}

// Pins the registry declares. Seeded once each, so an unpin sticks but a new
// entry still arrives. This is what the four "Boards" app entries became: they
// only ever existed because a registry entry could name a persona and a
// bookmark could not, and now a pin can.
let roamPinsSeeded = false;
function roamSeedPins() {
  if (roamPinsSeeded) return;
  roamPinsSeeded = true;
  const declared = roamEntry()?.pins;
  if (Array.isArray(declared) && declared.length) {
    try { roam.seed(declared); } catch {}
  }
}

function roamEnsure() {
  roamEnsureBar();
  roamSeedPins();
  if (roamTabs.size) return;
  // Reopen last session's tabs, or one blank one. Restoring is deliberate:
  // a browser that forgets everything when the shell restarts is a browser
  // you never leave anything open in.
  const saved = roam.session();
  if (saved.length) {
    for (const s of saved) roamNewTab({ url: s.url, persona: s.persona, background: true });
    roamTabActive = roamOrder[0];
  } else {
    roamNewTab({});
  }
}

let roamRememberTimer = null;
function roamRemember() {
  clearTimeout(roamRememberTimer);
  roamRememberTimer = setTimeout(() => {
    // A pending write must never outlive the browser it describes. Hibernating
    // saves the session and THEN tears the tabs down, so a timer still in
    // flight from the last navigation would fire against an empty roamOrder
    // and replace those pages with nothing — and the loss would only show up
    // on the next launch, as a browser that mysteriously forgot everything.
    if (!roamTabs.size) return;
    roam.remember(roamOrder.map((id) => {
      const t = roamTabs.get(id);
      return t && !t.blank ? { url: t.url, persona: t.persona, title: t.title } : null;
    }).filter(Boolean));
  }, 1500);
}

// The bar's dropdown needs to paint over the page. Grow the view, raise it,
// and put it back when the dropdown closes. Nothing else may be tall.
function roamExpand(open) {
  roamBarTall = !!open;
  roamLayout();
  if (roamBarTall && roamBar) win.contentView.addChildView(roamBar);
  return { tall: roamBarTall };
}

// Shrinking the bar from the MAIN side has to tell the bar, or it goes on
// believing its dropdown is open inside a view that is 76px tall again — and
// an overlay in this shell that outlives its own bounds does not look broken,
// it looks absent. Setting roamBarTall directly and letting the next
// roamLayout() catch up is exactly that bug, so there is one door.
function roamCollapse() {
  if (!roamBarTall) return;
  roamBarTall = false;
  roamLayout();
  if (roamBar && !roamBar.webContents.isDestroyed()) roamBar.webContents.send("roam-collapse", {});
}

function roamLayout() {
  if (!win || !roamBar || roamBar.webContents.isDestroyed()) return;
  const on = activeId === ROAM_ID && !overlayOpen;
  const { width: fullW, height } = contentBounds();
  const width = fullW - besideWidth(fullW);   // the browser ends where Beside begins
  const x = railW;
  const w = Math.max(0, width - railW);
  roamBar.setBounds({ x, y: 0, width: w, height: roamBarTall ? height : ROAM_BAR_H });
  roamBar.setVisible(on);
  roamVisible = on;
  // Background tabs keep the live geometry and just stop being drawn. Zeroing
  // their bounds instead would tell every hidden page it is 0×0 and make it
  // reflow to a phone layout and back every time you switched tabs.
  const page = { x, y: ROAM_BAR_H, width: w, height: Math.max(0, height - ROAM_BAR_H) };
  for (const [id, t] of roamTabs) {
    if (t.view.webContents.isDestroyed()) continue;
    const front = on && id === roamTabActive;
    const lit = !front && roamLit.has(id);
    // A lit tab keeps the page's size (no reflow) but sits left of the
    // window's content, where nothing of it can be seen.
    if (front || lit || !t._sized) {
      t.view.setBounds(lit ? { ...page, x: -page.width - 64 } : page);
      t._sized = true;
    }
    t.view.setVisible(front || lit);
  }
}

// ---- Beside -----------------------------------------------------------------
//
// A chat site in a column down the right of the window, beside whatever is in
// front, so a chatbot can be asked about the page you are on -- the panel a
// browser's own assistant has, for every app in the shell and every tab in The
// Wilds. Opening links in The Wilds instead of Chrome took that panel away;
// this is it back, on this side.
//
// The chat is an ordinary page: built by createView from a config of kind
// "external", the same door every Wilds tab goes through, so it gets a web
// page's stripped capabilities and nothing more. It browses in a jar the
// Wilds would let a tab browse in (`curio` by default, where the signed-in
// chats live).
//
// Share hands the page in front to the chat: read the way Kenoma's wilds_read
// reads it (the distillate -- the page's own content, with anything a person
// cannot see dropped, which is also where a page would hide text aimed at the
// model), pasted into the chat's box with the caret after it. It is never
// sent. You type the question and press Enter yourself, so nothing here is an
// automated send to a site that counts them, and nothing leaves the window
// without a person in the loop.
function besideChats() {
  const own = appById(ROAM_ID)?.beside?.chats;
  return Array.isArray(own) && own.length ? own : BESIDE_CHATS;
}

function besideIsOpen() {
  return besideShown && !!besideView && !besideView.webContents.isDestroyed();
}

// The column's width for a window this wide: what was last chosen, never so
// narrow a chat cannot draw itself, never more than 60% of the app area.
function besideWidth(fullW) {
  if (!besideIsOpen()) return 0;
  const room = Math.max(0, fullW - railW);
  const want = Number(uiState.beside?.width) || BESIDE_W;
  const max = Math.max(200, Math.floor(room * 0.6));
  return Math.min(max, Math.max(BESIDE_MIN, Math.round(want)));
}

function besideLayout(x, w, height) {
  const on = besideIsOpen() && w > 0;
  if (besideBar && !besideBar.webContents.isDestroyed()) {
    besideBar.setBounds({ x, y: 0, width: Math.max(0, w), height: BESIDE_BAR_H });
    besideBar.setVisible(on);
  }
  if (besideView && !besideView.webContents.isDestroyed()) {
    // Closed, the view keeps its size and is only hidden (a page told it is
    // 0x0 lays itself out for a phone and back again on every open).
    if (on) besideView.setBounds({ x, y: BESIDE_BAR_H, width: w, height: Math.max(0, height - BESIDE_BAR_H) });
    besideView.setVisible(on);
  }
}

function besideEnsureBar() {
  if (besideBar && !besideBar.webContents.isDestroyed()) return besideBar;
  besideBar = new WebContentsView({
    webPreferences: { preload: path.join(ROOT, "preload-beside.js"), contextIsolation: true },
  });
  sealView(besideBar);
  win.contentView.addChildView(besideBar);
  besideBar.webContents.loadFile(path.join(ROOT, "renderer", "beside", "index.html"));
  besideBar.webContents.on("did-finish-load", () => besidePush());
  besideBar.webContents.on("render-process-gone", (_e, d) => {
    if (d.reason === "clean-exit") return;
    try { besideBar.webContents.reload(); } catch {}
  });
  wireHotkeys(besideBar.webContents);
  return besideBar;
}

// Build the chat's view, or keep the one there is if it is already this chat.
// Switching chats builds a new view: the old one is closed, not reused, so a
// page from one site never carries on as another.
function besideMount(chat) {
  if (besideView && !besideView.webContents.isDestroyed() && besideChat && besideChat.id === chat.id) return besideView;
  besideUnmount();
  const persona = roamPersonaOk(chat.persona) ? chat.persona : ROAM_PERSONA;
  const cfg = { id: BESIDE_ID, name: `Beside · ${chat.name}`, kind: "external", url: chat.url, persona, capabilities: [] };
  besideView = createView(cfg);
  besideChat = { id: chat.id, name: chat.name, url: chat.url, persona };
  win.contentView.addChildView(besideView);
  besideView.webContents.on("page-title-updated", () => besidePush());
  besideView.webContents.loadURL(chat.url).catch(() => {});
  return besideView;
}

function besideUnmount() {
  if (!besideView) return;
  const v = besideView;
  besideView = null;
  besideChat = null;
  try { win.contentView.removeChildView(v); } catch {}
  try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch {}
}

// Out or in. Closing only hides the column -- reopening finds the same
// conversation -- and gives the keyboard back to the app in front.
function besideSet(on, chatId = null) {
  if (!win) return besideState();
  if (on) {
    // A named chat is switched to; otherwise the one already docked stays,
    // and a first open docks the last one used.
    const chats = besideChats();
    const named = chatId ? chats.find((c) => c.id === chatId) : null;
    besideEnsureBar();
    if (named) besideMount(named);
    else if (!besideView || besideView.webContents.isDestroyed()) besideMount(chats.find((c) => c.id === uiState.beside?.chat) || chats[0]);
    besideShown = true;
  } else {
    const hadKeys = !!besideView && !besideView.webContents.isDestroyed() && besideView.webContents.isFocused();
    besideShown = false;
    if (hadKeys) setImmediate(focusActive);
  }
  uiState.beside = { ...(uiState.beside || {}), open: !!on, chat: besideChat?.id || uiState.beside?.chat || null };
  saveUiState();
  layout();
  return besideState();
}

function besideState() {
  const wc = activeId ? wcFor(activeId) : null;
  const live = wc && !wc.isDestroyed();
  return {
    open: besideIsOpen(),
    chat: besideChat ? { id: besideChat.id, name: besideChat.name } : null,
    // The docked chat is always one of the choices, even one not on the list.
    chats: [...besideChats(), ...(besideChat && !besideChats().some((c) => c.id === besideChat.id) ? [besideChat] : [])].map((c) => ({ id: c.id, name: c.name })),
    front: live ? { app: activeId === ROAM_ID ? "The Wilds" : (appById(activeId)?.name || activeId), title: wc.getTitle() || "", url: wc.getURL() || "" } : null,
    shared: besideShared,
    note: besideNote,
    sharing: !!besideSharing,
  };
}

// The bar is told, not polled: on every layout (which every switch runs) and
// every navigation of the page in front (sendNavState).
let besidePushTimer = null;
function besidePush() {
  if (!besideIsOpen() || !besideBar || besideBar.webContents.isDestroyed()) return;
  clearTimeout(besidePushTimer);
  besidePushTimer = setTimeout(() => {
    if (besideBar && !besideBar.webContents.isDestroyed()) besideBar.webContents.send("beside-state", besideState());
  }, 40);
}

// The page in front, as text a chat can take: the distillate, cut at
// BESIDE_CAP, between two lines that say where it came from and where it ends.
async function besidePageText(wc) {
  const url = wc.getURL() || "";
  const title = wc.getTitle() || url;
  const page = await readPage(wc);
  const text = String(page.text || "").trim();
  const cut = text.length > BESIDE_CAP;
  const body = cut ? text.slice(0, BESIDE_CAP) + `\n\n[cut here: the first ${BESIDE_CAP} of ${text.length} characters]` : text;
  return {
    url, title, chars: text.length, cut,
    text: `[The page I have open, for context]\nTitle: ${title}\nURL: ${url}\n\n${body || "(the page has no readable text)"}\n[End of the page]\n\n`,
  };
}

// Into the chat's box the way the Wilds' chat verb types: the box found by
// shape (lib/chatbox.js), the text pasted through the clipboard (a rich
// composer ignores an assigned value), the clipboard put back. Unlike the
// chat verb it stops there -- the caret is left after the page, for the
// question, and nothing is sent.
async function besideHandOver(text) {
  const wc = besideView.webContents;
  let box = null;
  const t0 = Date.now();
  // A chat draws its box after the page loads (Gemini's comes late), so the
  // first Share after opening waits for it rather than failing.
  while (Date.now() - t0 < 15000) {
    if (!wc.isLoading()) {
      try { box = await roamEval(wc, chatboxJs(), 5000); } catch {}
      if (box && box.composer) break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!box || !box.composer) {
    let host = ""; try { host = new URL(wc.getURL()).hostname; } catch {}
    return { error: `no chat box on ${host || "the chat"} yet: sign in there (or clear whatever it is asking), then Share again` };
  }
  const sel = JSON.stringify(box.composer.selector);
  const inBox = () => roamEval(wc, `(() => { const el = document.querySelector(${sel}); if (!el) return ""; return (el.isContentEditable ? el.textContent : el.value) || ""; })()`).then((v) => String(v || "")).catch(() => "");
  const pageLen = () => roamEval(wc, `(document.body && document.body.innerText || "").length`).catch(() => 0);
  // The caret goes to the END of whatever is already in the box, so a
  // question typed before sharing stays ahead of the page.
  await roamEval(wc, `(() => { const el = document.querySelector(${sel}); if (!el) return 'miss'; el.focus();
    if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    else if (typeof el.setSelectionRange === 'function') { const n = el.value.length; el.setSelectionRange(n, n); }
    return 'ok'; })()`).catch(() => {});
  const beforeBox = await inBox();
  const beforePage = await pageLen();
  const { clipboard } = require("electron");
  const saved = clipboard.readText();
  let how = "miss";
  try {
    clipboard.writeText(text);
    wc.focus();
    wc.sendInputEvent({ type: "keyDown", keyCode: "v", modifiers: ["control"] });
    wc.sendInputEvent({ type: "char", keyCode: "v", modifiers: ["control"] });
    wc.sendInputEvent({ type: "keyUp", keyCode: "v", modifiers: ["control"] });
    await new Promise((r) => setTimeout(r, 500));
    const after = await inBox();
    if (after.includes(text.slice(0, 40))) how = "pasted";
    // A long paste becomes an attachment on some sites (Claude's "pasted
    // text" chip): the box is unchanged but the page grew around it.
    else if (after === beforeBox && (await pageLen()) > beforePage + 20) how = "attached";
  } catch {}
  finally { try { clipboard.writeText(saved); } catch {} }
  if (how === "miss") {
    // A plain field that took no paste: set its value (after what was there).
    const r = await roamEval(wc, typeJs(box.composer.selector, beforeBox + text)).catch(() => "miss");
    if (r !== "ok") return { error: `could not put the page into the chat box (${r})` };
    how = "typed";
  }
  wc.focus();
  return { ok: true, how };
}

// Ctrl+J, the bar's Share, the palette: the page in front into the chat.
let besideSharing = null;
function besideShare() {
  if (besideSharing) return besideSharing;
  besideSharing = (async () => {
    const wc = activeId ? wcFor(activeId) : null;
    if (!wc || wc.isDestroyed()) return { error: "nothing is in front to share" };
    if (!besideIsOpen()) besideSet(true);
    let page;
    try { page = await besidePageText(wc); }
    catch (e) { return { error: `could not read the page: ${String(e.message || e)}` }; }
    const r = await besideHandOver(page.text);
    if (r.ok) besideShared = { url: page.url, title: page.title, chars: page.chars, cut: page.cut, how: r.how, at: Date.now() };
    return r.ok ? { ok: true, how: r.how, shared: besideShared } : r;
  })().then((r) => {
    // Ctrl+J has no reply to show it in, so the bar says how it went.
    besideNote = r.ok ? null : { error: r.error, at: Date.now() };
    besidePush();
    return r;
  }).finally(() => { besideSharing = null; besidePush(); });
  besidePush();   // "reading the page…" while it works
  return besideSharing;
}

// Tell the rail what the front tab is, so it tracks tab changes the way it
// tracks app changes.
function roamAnnounce() {
  send("active", {
    id: ROAM_ID,
    watching: false,
    canWatch: false,
  });
  send("apps-changed", {});
}

function roamWc() {
  const t = roamTabs.get(roamTabActive);
  return t && !t.view.webContents.isDestroyed() ? t.view.webContents : null;
}

// Put the caret in the address bar. The view has to take focus first — a
// renderer cannot focus an input in a view the compositor is not pointing at,
// which is why this is two steps rather than one message.
function roamFocusBar(select = true) {
  if (!roamBar || roamBar.webContents.isDestroyed()) return;
  try { roamBar.webContents.focus(); } catch {}
  roamBar.webContents.send("roam-focus", { select });
}

function roamState() {
  const wc = roamWc();
  const h = wc?.navigationHistory;
  const tab = roamTabs.get(roamTabActive);
  const L = leads.fold();
  return {
    tabs: roamOrder.map((id) => {
      const t = roamTabs.get(id);
      return {
        id,
        title: t.title || (t.blank ? "New tab" : roamLib.prettyHost(t.url)),
        url: t.blank ? "" : t.url,
        host: t.blank ? "" : roamLib.prettyHost(t.url),
        persona: t.persona,
        loading: t.loading,
        blank: t.blank,
        agent: !!t.agent,
        active: id === roamTabActive,
      };
    }),
    active: roamTabActive,
    url: tab?.blank ? "" : tab?.url || "",
    host: tab?.blank ? "" : roamLib.prettyHost(tab?.url || ""),
    title: tab?.title || "",
    loading: !!tab?.loading,
    failed: tab?.failed || null,
    blank: !!tab?.blank,
    persona: tab?.persona || ROAM_PERSONA,
    personas: roamPersonas(),
    canBack: wc ? (h ? h.canGoBack() : wc.canGoBack()) : false,
    canForward: wc ? (h ? h.canGoForward() : wc.canGoForward()) : false,
    pinned: tab && !tab.blank ? roam.isPinned(tab.url) : false,
    pins: roam.state.pins,
    recent: roam.suggest("", 9),
    closed: roamClosed.length,
    // Whether the ADDRESS BAR remembers where you go — the "history" switch on
    // the registry entry. (Named `recording` once; the bar reads historyOn.)
    historyOn: roamRecords(),
    home: roamHomeUrl(),
    // Research leads, for the bar's chip and picker: the one new clips are
    // filed into (if any), and the list to pick from. Folded fresh here — see
    // the `leads` note up top — so a lead switched in the Trove shows in the
    // browser on the very next push, with nothing else to tell it.
    lead: L.active && L.leads.some((x) => x.id === L.active)
      ? { id: L.active, name: L.leads.find((x) => x.id === L.active).name }
      : null,
    leads: L.leads.map((x) => ({ id: x.id, name: x.name, n: x.clips.size })),
  };
}

let roamPushTimer = null;
function roamPush() {
  // Loading fires a burst of events per navigation; the bar only needs the
  // settled answer, and coalescing keeps a heavy page from spamming IPC.
  clearTimeout(roamPushTimer);
  roamPushTimer = setTimeout(() => {
    if (!roamBar || roamBar.webContents.isDestroyed()) return;
    roamBar.webContents.send("roam", roamState());
    if (activeId === ROAM_ID) sendNavState(ROAM_ID);
  }, 30);
}

// Activating the browser is activating an app that has no view of its own —
// its bar and its tabs are the view. Everything else about it (the rail's
// highlight, the palette, Ctrl+1…9) is the ordinary path.
function activateRoam() {
  roamEnsure();
  if (activeId && activeId !== ROAM_ID) {
    lastSeen.set(activeId, Date.now());
    mut.glance("surprised", 1100);
  }
  activeId = ROAM_ID;
  layout();
  roamAnnounce();
  roamPush();
  // A blank tab is a cursor waiting in an address bar, not a blank rectangle.
  // focusActive puts it there, focusing the bar's view first (a bare
  // roam-focus message cannot: see roamFocusBar).
  focusActive();
}

// Hibernate the whole browser: every tab and the bar. The session is written
// first, so reopening lands you back on the same pages.
function roamShutdown() {
  clearTimeout(roamRememberTimer);
  roam.remember(roamOrder.map((id) => {
    const t = roamTabs.get(id);
    return t && !t.blank ? { url: t.url, persona: t.persona, title: t.title } : null;
  }).filter(Boolean));
  roam.flush();
  for (const id of [...roamOrder]) roamCloseTabQuiet(id);
  roamOrder = [];
  roamTabActive = null;
  roamBarTall = false;
  if (roamBar && !roamBar.webContents.isDestroyed()) {
    try { win.contentView.removeChildView(roamBar); } catch {}
    try { roamBar.webContents.close(); } catch {}
  }
  roamBar = null;
}

// Page-side scripts, kept out of the control flow above so the quoting stays
// readable. Each returns the string "ok", or something else the caller treats
// as a miss.
const READ_JS = `(() => {
  const el = document.querySelector('main, article, [role="main"]') || document.body;
  return (el.innerText || '').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
})()`;

// Find by CSS selector, or by the visible text of something clickable. Text
// matching is a plain case-insensitive substring: an agent aiming at a button
// by its label wants the button it can see, not the cleverest fuzzy guess.
function findJs(sel, text) {
  if (sel) return `document.querySelector(${JSON.stringify(sel)})`;
  // An empty needle would match everything, and `.find` would return the first
  // clickable thing on the page — which on a real site is as likely to be
  // "Delete account" as anything else. An agent that asked for no target gets
  // no element, not an arbitrary one.
  if (!String(text).trim()) return "null";
  return `[...document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link]')]
    .find((e) => ((e.innerText || e.value || e.getAttribute('aria-label') || '') + '')
      .trim().toLowerCase().includes(${JSON.stringify(String(text).toLowerCase())}))`;
}

function clickJs(sel, text) {
  return `(() => { const el = ${findJs(sel, text)}; if (!el) return 'miss';
    el.scrollIntoView({ block: 'center' }); el.click(); return 'ok'; })()`;
}

function typeJs(sel, text) {
  const target = sel ? findJs(sel, "") : "document.activeElement";
  return `(() => { const el = ${target}; if (!el) return 'miss';
    // With no selector the target is whatever has focus, which on a freshly
    // loaded page is <body>. Assigning .value to a <body> sets a meaningless
    // expando and reports success — so the agent believes it filled a form
    // that is still empty. Check the thing can actually hold a value.
    const editable = el.isContentEditable ||
      (('value' in el) && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    if (!editable) return 'notfield';
    el.focus();
    if (el.isContentEditable) {
      el.textContent = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    }
    // React and every framework like it listen for the NATIVE value setter,
    // not for \`el.value = x\` — assigning directly types into a box the app
    // never hears about, and the form submits empty.
    const d = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
    if (d && d.set) d.set.call(el, ${JSON.stringify(text)}); else el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok'; })()`;
}

// ------------------------------------------------- the browser, from outside
//
// A control surface for agents, reached over the shell's existing local HTTP
// server (lib/mutsync.js — loopback, bearer-authed) and exposed as MCP by
// wilds-mcp.mjs. Kenoma, Claude Code and anything else that speaks MCP get the
// same doorway.
//
// Why this rather than letting the agent drive its own browser: C:\Forge's
// `browse` tool spawns Playwright, which is not installed and whose install
// would break that project's zero-dependency rule; its `web_fetch` is a bare
// GET with regex tag-stripping, so a single-page app returns an empty shell
// and anything behind a login is invisible; and its `screenshot` captures the
// whole monitor, every other window included. All of that already exists here,
// properly, because Electron IS Chromium. Two browser stacks is one too many.
//
// What an agent gets here that a headless one cannot: a persona jar, a page
// that actually rendered, and the Trove — so what it finds is archived with
// the address it came from rather than pasted into a transcript and lost.

// Wait for a tab to settle, so `open` can answer with a real title rather than
// an empty one. Bounded: a page that never stops loading is common, and is not
// a reason to hang the caller forever.
function roamSettled(tab, ms = 15000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const poll = () => {
      if (!roamTabs.has(tab.id)) return resolve(false);
      const wc = tab.view?.webContents;
      if (!wc || wc.isDestroyed()) return resolve(false);
      // Ask Chromium, not just our own flag. `tab.loading` is maintained from
      // did-start-loading / did-stop-loading, and a navigation that never
      // fires them — about:blank, a page served from cache, a load that was
      // already finished before the listeners attached — leaves it stuck true
      // and blocks the caller for the whole timeout. isLoading() is the
      // authoritative answer; the flag is what the BAR draws.
      if ((!tab.loading && !wc.isLoading()) || Date.now() - t0 > ms) return resolve(true);
      setTimeout(poll, 150);
    };
    poll();
  });
}

// Page scripts run in the page's own world, so a hostile or wedged page must
// not be able to hold the agent open indefinitely.
function roamEval(wc, js, ms = 8000) {
  return Promise.race([
    wc.executeJavaScript(js, true),
    new Promise((_r, rej) => setTimeout(() => rej(new Error("the page did not answer in time")), ms)),
  ]);
}

function wildsTab(id) {
  if (!id) return roamTabs.get(roamTabActive) || null;
  return roamTabs.get(String(id).replace(/^roam:/, "")) || null;
}

const WILDS_TEXT_CAP = 40000;

async function wildsControl(action, p = {}) {
  if (!roamAvailable()) return { error: "The Wilds is not registered in apps.config.json" };

  const needTab = () => {
    const tab = wildsTab(p.tab);
    if (!tab) return { err: { error: p.tab ? `no tab '${p.tab}'` : "no tab is open" } };
    if (tab.view.webContents.isDestroyed()) return { err: { error: "that tab is gone" } };
    return { tab, wc: tab.view.webContents };
  };

  switch (action) {
    case "open": {
      const asked = p.persona ? String(p.persona) : AGENT_PERSONA;
      // Any other jar must be named, and must exist.
      if (asked !== AGENT_PERSONA && !roamPersonaOk(asked)) {
        return { error: `'${asked}' is not a jar an agent may browse in — ${roamPersonaRefusal(asked)}` };
      }
      const { url } = roamLib.resolve(p.url || p.input || "", roamSearchTemplate());
      if (!url) return { error: "no address" };
      roamEnsure();
      // Background by default: an agent must not yank the window away from
      // whatever you were looking at. You still watch the tab appear.
      const tab = roamNewTab({ url, persona: asked, background: p.foreground !== true, agent: true });
      // Fronting the tab inside the browser is not the same as showing the
      // browser. Forge's `preview` asks for foreground precisely so the person
      // looks at the thing — if they are on another app, they never would.
      if (p.foreground === true) activate(ROAM_ID);
      await roamSettled(tab);
      roamPush();
      return { ok: true, tab: tab.id, url: tab.url, title: tab.title, persona: tab.persona };
    }

    case "tabs":
      return {
        ok: true,
        tabs: roamOrder.map((id) => {
          const t = roamTabs.get(id);
          return {
            tab: id, url: t.blank ? "" : t.url, title: t.title, persona: t.persona,
            agent: !!t.agent,
            active: id === roamTabActive,
          };
        }),
      };

    case "read": {
      const r = needTab();
      if (r.err) return r.err;
      const cap = Math.min(Number(p.max) || WILDS_TEXT_CAP, 200000);
      let read;
      try {
        read = await readPage(r.wc, p);
      } catch (e) {
        return { error: String(e.message || e) };
      }
      const truncated = read.text.length > cap;
      return {
        ok: true, url: r.wc.getURL(), title: r.wc.getTitle(),
        mode: read.mode, chars: read.text.length, rawChars: read.rawChars,
        truncated, text: truncated ? read.text.slice(0, cap) : read.text,
      };
    }

    case "shot": {
      const r = needTab();
      if (r.err) return r.err;
      try {
        const img = await r.wc.capturePage();
        return { ok: true, url: r.wc.getURL(), png: img.toPNG().toString("base64") };
      } catch (e) {
        return { error: String(e.message || e) };
      }
    }

    case "act": {
      const r = needTab();
      if (r.err) return r.err;
      const what = String(p.do || "click");
      const sel = p.selector ? String(p.selector) : null;
      const text = p.text == null ? "" : String(p.text);
      let js;
      if (what === "click") {
        if (!sel && !text.trim()) return { error: "click needs a selector or the visible text to aim at" };
        js = clickJs(sel, text);
      } else if (what === "type") {
        if (!text) return { error: "type needs the text to type" };
        js = typeJs(sel, text);
      }
      else if (what === "scroll") js = "(() => { window.scrollBy(0, " + (Number(p.by) || 800) + "); return 'ok'; })()";
      else if (what === "key") {
        // A real key, through Chromium's input pipeline rather than a
        // dispatched KeyboardEvent. Enter is how most things are actually
        // submitted — a chat box, a search field, a login — and a synthetic
        // event carries isTrusted:false, which a fair number of pages check.
        const key = String(p.key || "Enter");
        const wc = r.wc;
        try {
          if (p.selector) {
            const focused = await roamEval(wc, `(() => { const el = document.querySelector(${JSON.stringify(String(p.selector))});
              if (!el) return 'miss'; el.focus(); return 'ok'; })()`);
            if (focused !== "ok") return { error: `nothing matched selector ${p.selector}` };
          }
          wc.focus();
          const mods = [];
          if (p.ctrl) mods.push("control");
          if (p.shift) mods.push("shift");
          if (p.alt) mods.push("alt");
          wc.sendInputEvent({ type: "keyDown", keyCode: key, modifiers: mods });
          if (key.length === 1) wc.sendInputEvent({ type: "char", keyCode: key, modifiers: mods });
          wc.sendInputEvent({ type: "keyUp", keyCode: key, modifiers: mods });
        } catch (e) {
          return { error: String(e.message || e) };
        }
        await new Promise((res) => setTimeout(res, 400));
        return { ok: true, url: wc.getURL() };
      }
      else return { error: "unknown act '" + what + "' (click | type | key | scroll)" };
      try {
        const out = await roamEval(r.wc, js);
        if (out === "notfield") {
          return { error: sel
            ? `${sel} is not something you can type into`
            : "nothing on that page has focus — pass a selector for the field" };
        }
        if (out !== "ok") return { error: "nothing matched " + (sel ? "selector " + sel : 'text "' + text + '"') };
        await new Promise((res) => setTimeout(res, 400));
        return { ok: true, url: r.wc.getURL() };
      } catch (e) {
        return { error: String(e.message || e) };
      }
    }

    case "clip": {
      const r = needTab();
      if (r.err) return r.err;
      if (r.tab.blank) return { error: "nothing to clip" };
      const cfg = roamTabCfg(r.tab);
      if (p.what === "image") { await clipPageImage(cfg, r.tab.view, "wilds-agent"); return { ok: true, kind: "page-image" }; }
      await clipPage(cfg, { pageURL: r.tab.url, titleText: r.tab.title }, "wilds-agent", r.tab.view.webContents);
      return { ok: true, kind: "page" };
    }

    case "close": {
      const r = needTab();
      if (r.err) return r.err;
      roamCloseTab(r.tab.id);
      return { ok: true };
    }

    // Run a script in the page and return its JSON-serialisable result.
    // `act` can already click, type and press keys here, and `read` sees
    // everything the page shows; this is the same reach with a smaller
    // surface for an agent that knows what it wants. Same jar rules, same
    // bearer, same loopback. The result is page data: fenced by the caller.
    case "eval": {
      const r = needTab();
      if (r.err) return r.err;
      const script = String(p.script || "");
      if (!script.trim()) return { error: "eval needs a script" };
      try {
        const out = await roamEval(r.wc, script, Math.min(60000, Math.max(1000, Number(p.ms) || 10000)));
        return { ok: true, url: r.wc.getURL(), result: out === undefined ? null : out };
      } catch (e) { return { error: String(e.message || e) }; }
    }

    // The chat box on the page, found by shape rather than by selector
    // (lib/chatbox.js), and whether the page is answering right now.
    case "chatbox": {
      const r = needTab();
      if (r.err) return r.err;
      try { return { ok: true, ...(await roamEval(r.wc, chatboxJs(), 8000)) }; }
      catch (e) { return { error: String(e.message || e) }; }
    }

    // One exchange with the chat on this tab: type into its box, press
    // Enter (or click its send button), wait for the answer to finish, and
    // return the new text. Done is "the stop button went away and the text
    // stopped growing", read every 700 ms; the reply is what appeared after
    // the send, with the echo of what was sent cut from the front. The reply
    // is the model's words through a site's page, so it comes back fenced
    // as DATA like any other read -- a page can still whisper in it.
    case "chat": {
      const r = needTab();
      if (r.err) return r.err;
      roamLight(r.tab.id, true);
      try {
      const text = String(p.text || "");
      if (!text.trim()) return { error: "chat needs the text to send" };
      const quietMs = Math.max(500, Number(p.quietMs) || 1500);
      const maxMs = Math.min(600000, Math.max(5000, Number(p.maxMs) || 180000));
      const wc = r.wc;
      let box;
      try { box = await roamEval(wc, chatboxJs(), 8000); } catch (e) { return { error: "could not look for the chat box: " + String(e.message || e) }; }
      // A site's anti-automation wall (Google's "unusual traffic" page, a
      // captcha, a Cloudflare challenge) is an answer: it means stop. It is
      // reported as `blocked`, and the callers stand the site down for hours
      // (Kenoma's swarm and router). Nothing here ever tries to get past one
      // -- a person clears it in the tab, or the site is left alone.
      const wall = await roamEval(wc, `(() => { const u = location.href; const t = (document.body && document.body.innerText || "").slice(0, 4000);
        if (/google\\.[a-z.]+\\/sorry\\/|\\/captcha|challenges\\.cloudflare\\.com|\\bcf-chl|recaptcha|hcaptcha|turnstile/i.test(u)) return u;
        if (/unusual traffic|not a robot|verify you are (a )?human|are you a robot|press and hold|complete the security check|checking your browser/i.test(t)) return u + " :: " + (t.match(/unusual traffic|not a robot|verify you are (a )?human|are you a robot|press and hold|complete the security check|checking your browser/i) || [""])[0];
        return null; })()`, 5000).catch(() => null);
      if (wall) return { error: `the site has put up an anti-automation check (${String(wall).slice(0, 160)}); not sending -- clear it by hand in the tab, or leave the site alone for a while`, blocked: true, host: (() => { try { return new URL(wc.getURL()).hostname; } catch { return ""; } })() };
      if (!box || !box.composer) return { error: `no chat box on ${wc.getURL()} (${box ? box.candidates : 0} fields seen)` };
      if (box.generating) return { error: "the page is still answering a previous message; wait and read it first" };
      // The raw text, not the distillate: a chat's bubbles are exactly the
      // kind of repeated, link-light block the distiller may fold, and
      // subtraction removes the furniture anyway.
      const snap = async () => { try { return (await roamEval(wc, READ_JS)) || ""; } catch { return ""; } };
      const before = await snap();
      // Into the box the way a person's paste goes: focus it with a click,
      // put the text on the clipboard, Ctrl+V through Chromium's input
      // pipeline, restore the clipboard. A framework composer (ProseMirror,
      // Gemini's rich textarea, a React textarea watching keystrokes) takes
      // a paste where it ignores an assigned value; the value setter stays
      // as the fallback for a plain field.
      const { clipboard } = require("electron");
      const saved = clipboard.readText();
      let typed = "miss";
      try {
        await roamEval(wc, clickJs(box.composer.selector, ""));
        await new Promise((res) => setTimeout(res, 150));
        clipboard.writeText(text);
        wc.focus();
        wc.sendInputEvent({ type: "keyDown", keyCode: "v", modifiers: ["control"] });
        wc.sendInputEvent({ type: "char", keyCode: "v", modifiers: ["control"] });
        wc.sendInputEvent({ type: "keyUp", keyCode: "v", modifiers: ["control"] });
        await new Promise((res) => setTimeout(res, 400));
        const got = await roamEval(wc, `(() => { const el = document.querySelector(${JSON.stringify(box.composer.selector)}); if (!el) return ""; return (el.isContentEditable ? el.textContent : el.value) || ""; })()`);
        typed = String(got).includes(text.slice(0, 40)) ? "ok" : "miss";
      } catch {}
      finally { try { clipboard.writeText(saved); } catch {} }
      if (typed !== "ok") {
        typed = await roamEval(wc, typeJs(box.composer.selector, text));
        if (typed !== "ok") return { error: `could not type into ${box.composer.selector} (${typed})` };
      }
      await new Promise((res) => setTimeout(res, 250));
      // The send button first when the page has one -- duck.ai's Enter did
      // nothing while its submit button sent -- and Enter through Chromium's
      // input pipeline (isTrusted) when there is no button or the button
      // left the text in the box.
      const boxText = () => roamEval(wc, `(() => { const el = document.querySelector(${JSON.stringify(box.composer.selector)}); if (!el) return ""; return (el.isContentEditable ? el.textContent : el.value) || ""; })()`).then((v) => String(v || "")).catch(() => "");
      const press = (key) => { wc.focus(); wc.sendInputEvent({ type: "keyDown", keyCode: key }); wc.sendInputEvent({ type: "char", keyCode: key }); wc.sendInputEvent({ type: "keyUp", keyCode: key }); };
      // Look for the send button again now that the box has text in it:
      // Gemini draws its send button only once there is something to send,
      // so the first probe, on an empty box, never saw one.
      let send = box.send;
      try { const again = await roamEval(wc, chatboxJs(), 5000); if (again && again.send) send = again.send; } catch {}
      let sentHow = "";
      const still = async () => (await boxText()).trim() === text.trim();
      // A real click first: mouse down and up through Chromium's input
      // pipeline at the button's centre, so the event is trusted. Gemini
      // takes a dispatched .click() and does nothing with it; duck.ai takes
      // either. The dispatched click stays as the second try.
      const realClick = async (sel) => {
        const at = await roamEval(wc, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: "nearest" }); const b = el.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`).catch(() => null);
        if (!at) { steps.push({ at: "real click target", found: false }); return false; }
        steps.push({ at: "real click target", x: at.x, y: at.y });
        wc.focus();
        wc.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y });
        wc.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
        wc.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
        return true;
      };
      // What each step did, returned with a failure so the next fix is a
      // reading, not a guess.
      const steps = [];
      try { steps.push({ at: "start", vis: await roamEval(wc, "document.visibilityState", 3000), box: (await boxText()).slice(0, 40) }); } catch {}
      if (send) {
        const rc = await realClick(send);
        steps.push({ at: "real click", ok: rc });
        if (rc) { sentHow = "click"; await new Promise((res) => setTimeout(res, 1200)); }
        if (!sentHow || await still()) {
          let out = null;
          try { out = await roamEval(wc, clickJs(send, "")); sentHow = sentHow ? sentHow + ", button" : "button"; } catch (e) { out = "threw: " + e.message; }
          steps.push({ at: "script click", out });
          await new Promise((res) => setTimeout(res, 900));
        }
      }
      if (!sentHow || await still()) {
        await roamEval(wc, clickJs(box.composer.selector, "")).catch(() => {});
        press("Enter");
        sentHow = sentHow ? sentHow + ", then enter" : "enter";
        await new Promise((res) => setTimeout(res, 900));
      }
      if (await still()) { press("Return"); sentHow += ", return"; await new Promise((res) => setTimeout(res, 900)); }
      if (await still()) return { error: "the message stayed in the box: neither the send button nor Enter sent it", sentHow, composer: box.composer.selector, send, steps };
      const t0 = Date.now();
      let last = before, lastChange = Date.now(), sawGenerating = false, complete = false, after = before;
      for (;;) {
        await new Promise((res) => setTimeout(res, 700));
        let gen = false;
        try { gen = !!(await roamEval(wc, chatboxJs(), 5000)).generating; } catch {}
        if (gen) sawGenerating = true;
        after = (await snap()) || after;
        if (after !== last) { last = after; lastChange = Date.now(); }
        const quiet = Date.now() - lastChange;
        const grew = after.length > before.length;
        if (!gen && grew && quiet >= quietMs && (sawGenerating || quiet >= quietMs * 2)) { complete = true; break; }
        if (Date.now() - t0 > maxMs) break;
      }
      // What is new: the lines of the page that were not there before the
      // send (the furniture was), from after the echo of what was sent.
      // A line-set subtraction survives a page that re-flows on reply where
      // a prefix comparison does not.
      const had = new Set(before.split("\n").map((l) => l.trim()).filter(Boolean));
      const lines = after.split("\n").map((l) => l.trim());
      let start = lines.findIndex((l) => l && text.trim().startsWith(l.slice(0, 60)) && l.length > 10);
      if (start < 0) start = lines.findIndex((l) => l === text.trim().split("\n")[0].trim());
      const fresh = lines.slice(start >= 0 ? start + 1 : 0).filter((l) => l && !had.has(l) && !text.includes(l));
      let reply = fresh.join("\n").trim();
      const cap = Math.min(Number(p.max) || WILDS_TEXT_CAP, 200000);
      return { ok: true, url: wc.getURL(), title: wc.getTitle(), host: box.host, sentHow, complete, waitedMs: Date.now() - t0, chars: reply.length, truncated: reply.length > cap, reply: reply.slice(0, cap) };
      } finally { roamLight(r.tab.id, false); }
    }

    case "egress-status":
      return {
        ok: true,
        enabled: egressProxyEnabled,
        port: egressProxyPort,
        fallback: egressNet.status(),   // { allowed, why }: may a page go direct with Haruspex down
      };

    case "egress-toggle": {
      const en = typeof p.enabled === "boolean" ? p.enabled : !egressProxyEnabled;
      const pt = Number(p.port) || egressProxyPort;
      updateEgressState(en, pt);
      return { ok: true, enabled: egressProxyEnabled, port: egressProxyPort };
    }

    default:
      return { error: "unknown wilds action '" + action + "'" };
  }
}

// ------------------------------------------------------- the coding handoff
//
// Two gestures, one for each direction:
//
//   out    "Cartridge for <app>" in the palette types the packed context into
//          whatever chat box has your cursor. You press Enter.
//   back   "Preview through the Forge…" on a selected reply.
//
// The chat itself is never automated. That is the point: you are better at
// steering a conversation than a selector is at surviving a redesign, and the
// tedious half — parse, preview, apply, verify, roll back — is the half worth
// giving to a machine.

let lastPreview = null;   // { changeSet, planId, defaultAppId, files } for the sheet's Apply

async function forgePreviewSelection(text) {
  send("app-status", { id: activeId, message: "asking the Forge what this would change…" });
  const r = await cartridge.preview({ changeSet: text });
  if (!r.ok) {
    send("app-error", { id: activeId, message: r.error });
    return;
  }
  // Keep the change-set beside the plan: apply writes exactly what was
  // previewed, and re-deriving it from a selection the person may have since
  // lost would be a different change.
  lastPreview = { changeSet: text, planId: r.planId || null, result: r };
  send("forge-preview", {
    planId: r.planId || null,
    files: r.files || r.plan || [],
    raw: r,
    chars: text.length,
  });
}

async function forgeApplyLast(opts = {}) {
  if (!lastPreview) return { error: "nothing previewed" };
  const r = await cartridge.apply({
    changeSet: lastPreview.changeSet,
    planId: lastPreview.planId,
    verify: opts.verify !== false,
    rollbackOnFail: true,
    goal: opts.goal,
  });
  if (r.ok) {
    busPublish("forge.applied", { files: (r.detail && r.detail.applied) || [], verify: r.detail && r.detail.verify });
    mut.push({ key: "forge", topic: "fanout", priority: 1, state: "happy", text: "The Forge wrote it." });
  }
  send("forge-applied", r);
  return r;
}

async function forgeCorrectionLast() {
  if (!lastPreview) return { error: "nothing previewed" };
  const r = await cartridge.correction({ changeSet: lastPreview.changeSet });
  if (r.ok && r.text) clipboard.writeText(r.text);
  return r;
}

// The outbound leg. Packs, then types it into the chat box your cursor is in —
// and stops there. Pressing Enter stays a person's decision, because the
// moment it does not, this becomes the automation it is trying not to be.
async function forgeCartridgeToChat({ appIds, goal }) {
  if (activeId !== ROAM_ID) return { error: "open the chat in The Wilds first" };
  const tab = roamTabs.get(roamTabActive);
  if (!tab || tab.blank) return { error: "no page in front to type into" };
  send("app-status", { id: ROAM_ID, message: "packing the cartridge…" });
  const packed = await cartridge.pack({ appIds, goal });
  if (!packed.ok) return { error: packed.error };
  const text = packed.deliverable;
  if (!text) return { error: "the Forge packed nothing" };
  const typed = await wildsControl("act", { tab: tab.id, do: "type", text });
  if (typed.error) return { error: typed.error };
  send("app-status", { id: ROAM_ID, message: `cartridge in — ${Math.round(text.length / 1024)} KB. Press Enter when you are ready.` });
  return { ok: true, chars: text.length, sessionId: packed.sessionId };
}

// Memory, for the rail's readout and the perf drawer. A browser with nine
// tabs is usually the heaviest thing in the window, and it would be a lie for
// it to report nothing while the total climbed.
function roamMb() {
  if (!roamTabs.size) return null;
  const { byPid } = appMetrics();
  let total = 0, seen = false;
  for (const t of roamTabs.values()) {
    if (t.view.webContents.isDestroyed()) continue;
    const m = byPid.get(t.view.webContents.getOSProcessId());
    if (m) { total += m.memory.workingSetSize / 1024; seen = true; }
  }
  return seen ? Math.round(total) : null;
}

// ------------------------------------------------------------------- IPC

ipcMain.handle("roost:apps", () => ({
  apps: config.apps.map((a) => ({
    id: a.id,
    name: a.name || a.id,
    group: a.group || null,
    kind: a.kind,
    persona: a.persona || "default",
    capabilities: a.capabilities || [],
    open: a.kind === "browser" ? roamTabs.size > 0 : views.has(a.id),
    running: a.kind === "local" ? spawned.has(a.id) : a.kind === "browser" ? roamTabs.size > 0 : views.has(a.id),
  })),
  activeId,
}));

// Rail width — "full" or "min" (icon-only), persisted. Called with no mode
// it just reports the current state, so the renderer can restore at boot.
ipcMain.handle("roost:rail", (_e, mode) => {
  if (mode === "min" || mode === "full") {
    railW = mode === "min" ? RAIL_MIN : RAIL_FULL;
    uiState.rail = mode;
    saveUiState();
    layout();
  }
  return { width: railW, mode: railW === RAIL_MIN ? "min" : "full" };
});

ipcMain.handle("roost:activate", (_e, id) => activate(id));

// What an agent gets when it reads a tab. The distiller (lib/distill.js)
// strips the page's furniture in the page and returns markdown-shaped text;
// `mode: "text"` asks for the old innerText dump instead. The distiller falls
// back to the dump on its own when it comes back nearly empty against a page
// that plainly has text -- a layout the scorer did not understand should cost
// tokens, not content. The agent is told which one it got.
async function readPage(wc, p = {}) {
  const want = String(p.mode || "distill");
  if (want === "text") {
    const text = await roamEval(wc, READ_JS);
    return { text, mode: "text", rawChars: text.length };
  }
  const d = await roamEval(wc, distillJs({ links: !!p.links }), 12000);
  const text = (d && d.text) || "";
  const raw = Number(d && d.rawChars) || 0;
  if (text.length < 200 && raw > text.length * 4) {
    const plain = await roamEval(wc, READ_JS);
    return { text: plain, mode: "text", rawChars: plain.length, fellBack: true };
  }
  return { text, mode: "distill", rawChars: raw, root: d && d.root };
}

// Capability-gated storage. Scoped per app — one app cannot read another's.
// Gated on the REGISTRY, like every other handler: the caps string the
// preload sends is convenience, not authority, and using the registry's own
// id for the path (an id that must exist in the config to pass `can`) is
// what makes "..\\..\\" traversal ids impossible here.
ipcMain.handle("roost:store", (e, { app: appId, op, key, value }) => {
  const cfg = appById(appId);
  if (!can(cfg, "store")) return { error: "denied" };
  const dir = path.join(DATA, "store", cfg.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "store.json");
  let db = {};
  try {
    db = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  if (op === "get") return { value: db[key] ?? null };
  if (op === "list") return { keys: Object.keys(db) };
  if (op === "set") {
    db[key] = value;
    fs.writeFileSync(file, JSON.stringify(db, null, 2));
    return { ok: true };
  }
  if (op === "delete") {
    delete db[key];
    fs.writeFileSync(file, JSON.stringify(db, null, 2));
    return { ok: true };
  }
  return { error: "unknown op" };
});

// ------------------------------------------------------- filesystem (fs)

// Every call re-checks the capability against the registry rather than
// trusting anything the renderer sends. ScopedFs then confines the path.
ipcMain.handle("roost:fs", async (_e, { app: appId, op, path: rel, data, encoding }) => {
  const cfg = appById(appId);
  const scope = scopeFor(cfg);
  if (!scope) return { error: "denied: app has no fs capability" };
  try {
    switch (op) {
      case "list":   return { entries: await scope.list(rel ?? ".") };
      case "read":   return { data: await scope.read(rel, encoding || "utf8") };
      case "write":  return await scope.write(rel, data);
      case "append": return await scope.append(rel, data);
      case "stat":   return await scope.stat(rel);
      case "remove": return await scope.remove(rel);
      case "root":   return { root: scope.root };
      default:       return { error: `unknown op: ${op}` };
    }
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

// ------------------------------------------------------- launcher (apps)

// The launcher's tile view. Gated on the registry like fs — the renderer's
// word is never trusted, and effectiveCaps strips 'apps' from external apps
// so a remote page can never drive the shell.
ipcMain.handle("roost:apps-list", (_e, { app: appId }) => {
  const caller = appById(appId);
  if (!can(caller, "apps")) return { error: "denied: app lacks the apps capability" };
  // Renderer memory per open view, so the launcher can show what each open
  // app is actually costing — served from the shared 2s metrics cache.
  const mbFor = mbForView;
  return {
    apps: config.apps.map((a) => ({
      id: a.id,
      name: a.name || a.id,
      group: a.group || null,
      kind: a.kind,
      persona: a.persona || "default",
      capabilities: effectiveCaps(a),
      note: a.note || "",
      // Optional tile art, a path relative to the lounge dir (registry `art`).
      art: a.art || null,
      open: views.has(a.id),
      running: a.kind === "local" ? spawned.has(a.id) : views.has(a.id),
      active: a.id === activeId,
      mb: mbFor(a.id),
    })),
    activeId,
  };
});

// Hibernate from the launcher — same rules as the toolbar's version.
ipcMain.handle("roost:apps-close", (_e, { app: appId, id }) => {
  const caller = appById(appId);
  if (!can(caller, "apps")) return { error: "denied: app lacks the apps capability" };
  if (id === appId) return { error: "an app cannot hibernate itself" };
  return closeView(id);
});

ipcMain.handle("roost:apps-open", (_e, { app: appId, id }) => {
  const caller = appById(appId);
  if (!can(caller, "apps")) return { error: "denied: app lacks the apps capability" };
  if (!appById(id)) return { error: `unknown app: ${id}` };
  activate(id);
  return { ok: true };
});

ipcMain.handle("roost:apps-stop", (_e, { app: appId, id }) => {
  const caller = appById(appId);
  if (!can(caller, "apps")) return { error: "denied: app lacks the apps capability" };
  return { stopped: stopLocal(id) };
});

ipcMain.handle("roost:apps-restart", async (_e, { app: appId, id }) => {
  const caller = appById(appId);
  if (!can(caller, "apps")) return { error: "denied: app lacks the apps capability" };
  return restartLocal(id);
});

// QR templates for downloadable apps. The Trove's Apps tab reads apps.json;
// entries with qr.template call this to resolve dynamic placeholders like
// {lan} (the desktop's LAN address), {token} (the phone bridge's token) and
// {port} (where the bridge is actually listening).
ipcMain.handle("roost:app-qr", async (_e, { app: appId, template }) => {
  const caller = appById(appId);
  if (!can(caller, "apps")) return { error: "denied: app lacks the apps capability" };
  if (typeof template !== "string") return { error: "no template" };
  const token = secretOrNull("MUT_SYNC_TOKEN") || "";
  const addrs = mutSync ? mutSync.addresses() : [];
  const lan = addrs.length ? addrs[0] : "";
  let url = template.replace(/\{token\}/g, encodeURIComponent(token));
  url = url.replace(/\{lan\}/g, lan || "<no-lan-address>");
  // The Trove's templates were written with :8793 in them. If the bridge had
  // to walk (lib/mutsync.js), the QR must say where it actually went.
  url = url.replace(/\{port\}/g, String(mutSync.port()));
  if (mutSync.port() !== mutSync.PORT) url = url.replace(new RegExp(`:${mutSync.PORT}(?=[/?#]|$)`, "g"), `:${mutSync.port()}`);
  // Every other address this machine has rides in the fragment, so a phone
  // that cannot reach the first (the laptop moved to the other wifi; the
  // code was printed on the VPN's address) tries the rest and keeps the
  // one that answered. The fragment never reaches a server.
  const alts = addrs.slice(1).map((a) => `${a}:${mutSync.port()}`);
  const frag = [];
  if (alts.length && !url.includes("alt=")) frag.push("alt=" + encodeURIComponent(alts.join(",")));
  if (frag.length) url += (url.includes("#") ? "&" : "#") + frag.join("&");
  // Generate a scannable QR code as an SVG data URI (delegates to qrcode npm).
  let qrUri = "";
  try { qrUri = (await qr.qrDataUri(url, { size: 144, margin: 2 })).dataUri; } catch {}
  return { url, qr: qrUri };
});

// The bus itself. Both directions re-check the registry — the renderer's
// claim about its own capabilities is never trusted.
ipcMain.handle("roost:bus", (_e, { app: appId, topic, payload }) => {
  const caller = appById(appId);
  if (!can(caller, "bus")) return { error: "denied: app lacks the bus capability" };
  if (!topic || typeof topic !== "string") return { error: "topic required" };
  busPublish(topic, payload, appId);
  return { ok: true };
});

// ------------------------------------------------------ project discovery

ipcMain.handle("roost:overlay", (_e, open) => {
  overlayOpen = !!open;
  // Re-adding raises the view to the top of the stack, so the sheet draws over
  // the app rather than behind it.
  if (overlayOpen) win.contentView.addChildView(chromeView);
  layout();
  // The sheet has the keyboard while it is up and hands it back as it goes.
  // Without the second half, Esc on the palette left keys going to the rail
  // until the app was clicked.
  if (overlayOpen) { try { chromeView.webContents.focus(); } catch {} }
  else focusActive();
  return { overlay: overlayOpen };
});

ipcMain.handle("roost:pick-folder", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Choose a folder containing your projects",
    properties: ["openDirectory"],
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  return { dir: r.filePaths[0] };
});

ipcMain.handle("roost:scan", (_e, { dir, persona }) => {
  try {
    mut.push({ key: "scan", topic: "scan", priority: 1, state: "task-map", ttlMs: 20000 });
    const found = scan(dir, { relativeTo: ROOT, persona: persona || "workshop" });
    const existing = new Set(config.apps.map((a) => a.id));
    mut.push({ key: "scan", priority: 1, state: "happy", text: found.length ? `Mapped it — ${found.length} thing${found.length === 1 ? "" : "s"} in there.` : "Mapped it. Nothing in there." });
    return {
      dir,
      found: found.map((f) => ({ ...f, alreadyAdded: existing.has(f.id) })),
    };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

// Writes discovered projects into apps.config.json so the registry is a real
// file you can edit and commit, not hidden state.
ipcMain.handle("roost:add-apps", (_e, entries) => {
  const raw = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  const existing = new Set((raw.apps || []).map((a) => a.id));
  const added = [];
  for (const e of entries) {
    if (existing.has(e.id)) continue;
    existing.add(e.id); // two folders normalizing to one id must not both land
    const { detected, alreadyAdded, ...clean } = e;
    raw.apps.push(clean);
    added.push(e.id);
  }
  fs.writeFileSync(CONFIG, JSON.stringify(raw, null, 2));
  config = loadConfig();
  return { added, total: config.apps.length };
});

// Pick a manifest file. A manifest is a JSON file describing one or more apps
// to import. Paths inside it are relative to the manifest file, so the manifest
// can travel with its projects.
ipcMain.handle("roost:pick-manifest", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Choose an ifreglen-apps.json manifest",
    properties: ["openFile"],
    filters: [{ name: "Ifreglen manifest", extensions: ["json"] }, { name: "All files", extensions: ["*"] }],
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  return { file: r.filePaths[0] };
});

// Import from a manifest file. Existing ids are skipped unless replace is true.
ipcMain.handle("roost:import-manifest", async (_e, { file, replace = false }) => {
  if (!file || typeof file !== "string") return { error: "no manifest file given" };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    const existing = new Set((raw.apps || []).map((a) => a.id));
    const results = manifest.importManifest(file, { existingIds: existing, replace });

    if (!results.added.length && !results.errors.length && !results.scaffolded.length) {
      return { ...results, nothing: true };
    }

    // Merge entries, replacing if requested.
    if (replace) {
      raw.apps = (raw.apps || []).filter((a) => !results.added.some((e) => e.id === a.id));
    }
    for (const e of results.added) raw.apps.push(e);
    fs.writeFileSync(CONFIG, JSON.stringify(raw, null, 2));
    config = loadConfig();
    return { ...results, total: config.apps.length };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

// Absorb a single outside project folder. The folder stays where it is; the
// shell only records a registry entry and writes a manifest/note inside the
// project so it remains self-describing.
ipcMain.handle("roost:absorb", async (_e, { dir, options = {} }) => {
  if (!dir || typeof dir !== "string") return { error: "no folder given" };
  // Serialize absorb calls: each one reads the registry fresh and writes it back,
  // so parallel invocations can't pick the same id and overwrite each other.
  return (absorbLock = absorbLock.then(async () => {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
      const existingIds = new Set((raw.apps || []).map((a) => a.id));
      const result = absorb(dir, { ...options, existingIds });
      if (!options.dryRun) {
        raw.apps.push(result.entry);
        fs.writeFileSync(CONFIG, JSON.stringify(raw, null, 2));
        config = loadConfig();
      }
      return { added: result.entry, info: result.info, total: options.dryRun ? raw.apps.length : config.apps.length };
    } catch (err) {
      return { error: String(err.message || err) };
    }
  }));
});

ipcMain.handle("roost:reload", (_e, id) => {
  wcFor(id)?.reload();
});

// Runtime toggle for live reload, so you don't have to edit the registry to
// silence a chatty watcher. Returns the new state for the toolbar.
ipcMain.handle("roost:toggle-watch", (_e, id) => {
  const cfg = appById(id);
  if (!cfg || cfg.kind === "external" || cfg.kind === "browser") return { watching: false, allowed: false };
  if (watchers.has(id)) {
    watchers.get(id).stop();
    watchers.delete(id);
    watchDisabled.add(id); // survives reloads — see startWatch
    return { watching: false, allowed: true };
  }
  watchDisabled.delete(id);
  const view = views.get(id);
  if (!view) return { watching: false, allowed: true };
  // Force it on regardless of the default policy for this kind.
  const forced = { ...cfg, liveReload: true };
  startWatch(forced, view);
  return { watching: watchers.has(id), allowed: true };
});

ipcMain.handle("roost:devtools", (_e, id) => {
  wcFor(id)?.openDevTools({ mode: "bottom" });
});

// Toolbar-only controls: the chrome view is the shell's own UI, so these are
// not capability-gated the way the app-facing channels are.
ipcMain.handle("roost:stop", (_e, id) => ({ stopped: stopLocal(id) }));
ipcMain.handle("roost:restart", (_e, id) => restartLocal(id));
ipcMain.handle("roost:logs", (_e, id) => ({ lines: logs.get(id) || [] }));
ipcMain.handle("roost:nav", (_e, { id, dir }) => { navigate(id, dir); sendNavState(id); });
ipcMain.handle("roost:zoom", (_e, { id, dir }) => zoom(id, dir));
ipcMain.handle("roost:close-view", (_e, id) => closeView(id));

ipcMain.handle("roost:find", (_e, { id, action, text }) => {
  const wc = wcFor(id);
  if (!wc) return {};
  if (action === "stop") { wc.stopFindInPage("clearSelection"); return {}; }
  if (!text) return {};
  if (action === "find") wc.findInPage(text);
  else wc.findInPage(text, { forward: action !== "prev", findNext: true });
  return {};
});

// The current URL of an app, into the real browser or the clipboard. Toolbar
// only — this is the person driving, not a hosted page.
ipcMain.handle("roost:open-external", (_e, id) => {
  const url = wcFor(id)?.getURL();
  if (url && /^https?:/i.test(url)) { shell.openExternal(url); return { opened: true }; }
  return { error: "no http(s) url to open" };
});
ipcMain.handle("roost:copy-url", (_e, id) => {
  const url = wcFor(id)?.getURL();
  if (!url) return { error: "nothing loaded" };
  clipboard.writeText(url);
  return { copied: true, url };
});

// Per-app renderer cost, from Chromium's own accounting. memory.workingSetSize
// arrives in kilobytes. Dev-server child processes are separate OS process
// trees the shell can't cheaply meter, so this is the view's renderer only —
// which is the number hibernation can actually get back.
ipcMain.handle("roost:metrics", () => {
  const { raw, byPid } = appMetrics();
  const perApp = [];
  for (const [id, v] of views) {
    if (v.webContents.isDestroyed()) continue;
    const m = byPid.get(v.webContents.getOSProcessId());
    perApp.push({
      id,
      name: appById(id)?.name || id,
      mb: m ? Math.round(m.memory.workingSetSize / 1024) : null,
      cpu: m ? Math.round(m.cpu.percentCPUUsage * 10) / 10 : null,
      active: id === activeId,
      serverUp: spawned.has(id),
    });
  }
  // A browser with nine tabs is usually the heaviest thing in the window; it
  // would be a lie for the perf drawer to list nothing while the total climbed.
  if (roamTabs.size) {
    perApp.push({
      id: ROAM_ID,
      name: appById(ROAM_ID)?.name || "The Wilds",
      mb: roamMb(),
      cpu: null,
      active: activeId === ROAM_ID,
      serverUp: false,
    });
  }
  const totalMb = Math.round(raw.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024);
  return { apps: perApp, totalMb, processes: raw.length };
});

// Auto-rest setting: minutes of idleness before a background view is
// hibernated; 0 disables. Toolbar-only, persisted in ui-state.
ipcMain.handle("roost:auto-rest", (_e, mins) => {
  if (mins != null) {
    uiState.autoRest = Math.max(0, Number(mins) || 0);
    saveUiState();
  }
  return { mins: Number(uiState.autoRest) || 0 };
});

// ------------------------------------------------------------------ clip
// Toolbar-facing: the quick-add omnibox and the Trove's own actions. Not
// capability-gated the way app-facing channels are — the rail is the shell's
// own UI. The `clip` capability governs the CONTEXT MENU inside hosted views,
// which is the surface a page could otherwise be near.

// ---------------------------------------------------------------- restart
// The rail's "restart" foot and Auri's update card both end here. A restart is
// refused while something is writing, and it says which. (The hoard-following
// that used to land updates here is gone with the platform it followed; a
// restart is now only ever asked for.)
function shellBusy() {
  if (mutForgeBusy) return "a Forge turn is running";
  return null;
}
// Whether a hosted app is in the middle of something a restart would lose.
// Kenoma (the "forge" entry) lists its sessions with `running` on /sessions;
// any registry entry may name its own endpoint as health.busy. The apps are
// this shell's children, so restarting the shell kills them -- a Kenoma turn
// stopped dead two seconds before a shell restart, which is how this was found.
async function appBusy(cfg) {
  if (!cfg || !cfg.url) return false;
  const ep = (cfg.health && cfg.health.busy) || (cfg.id === "forge" ? "/sessions" : null);
  if (!ep) return false;
  try {
    const r = await fetch(new URL(ep, cfg.url).toString(), { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return !!(j && (j.busy === true || j.running === true || (Array.isArray(j.sessions) && j.sessions.some((s) => s && s.running))));
  } catch { return false; }
}
async function busyApp() {
  for (const id of spawned.keys()) { const cfg = appById(id); if (await appBusy(cfg)) return cfg.name || id; }
  return null;
}
function updateStatus() {
  return { pending: null, deferred: false, busy: shellBusy(), git: false, where: null, last: null };
}
ipcMain.handle("roost:update", async (_e, action) => {
  if (action === "status") return updateStatus();
  if (action === "relaunch") return relaunchShell();
  return { error: "unknown action" };
});
async function relaunchShell() {
  const busy = shellBusy();
  if (busy) return { ok: false, error: `not now: ${busy}` };
  // The hosted apps die with the shell, so a turn in progress goes too.
  const mid = await busyApp();
  if (mid) return { ok: false, error: `not now: ${mid} is in the middle of something` };
  app.relaunch({ args: process.argv.slice(1) });
  app.quit();
  return { ok: true };
}

// The Wilds' bar speaks through one multiplexed channel. It is shell UI, not
// a hosted page, so it is not capability-gated — but note what it still
// cannot do: every action here is scoped to the browser's own tabs, and the
// registry and the filesystem are as far out of its reach as they are out of
// any web page's.
// Beside's own bar and the rail's palette, and nothing else: a hosted page
// asking the shell to read whatever is in front and paste it somewhere is
// exactly what this must not answer.
ipcMain.handle("roost:beside", async (e, action, p = {}) => {
  const fromBar = besideBar && !besideBar.webContents.isDestroyed() && e.sender === besideBar.webContents;
  if (!fromBar && e.sender !== chromeView.webContents) return { error: "denied" };
  if (action === "state") return besideState();
  if (action === "share") return besideShare();
  if (action === "open") return besideSet(true);
  if (action === "close") return besideSet(false);
  if (action === "toggle") return besideSet(!besideIsOpen());
  if (action === "chat") return besideSet(true, String(p.id || ""));
  if (action === "width") {
    const fullW = win.getContentBounds().width;
    const now = besideWidth(fullW) || Number(uiState.beside?.width) || BESIDE_W;
    uiState.beside = { ...(uiState.beside || {}), width: Math.max(BESIDE_MIN, now + (Number(p.delta) || 0)) };
    saveUiState();
    layout();
    return besideState();
  }
  if (action === "reload") { if (besideView && !besideView.webContents.isDestroyed()) besideView.webContents.reload(); return besideState(); }
  return { error: `no such Beside action "${action}"` };
});

ipcMain.handle("roost:roam", (_e, action, payload = {}) => {
  const p = payload || {};
  switch (action) {
    case "state":
      return roamState();

    case "open": {
      const r = roamOpen(p.input, {
        background: !!p.background,
        newTab: !!p.newTab,
        here: !!p.here,
        persona: p.persona || null,
      });
      if (!r) return { error: "nothing to open" };
      return { ok: true, searched: !!r.searched, query: r.query || null, tab: r.tab.id };
    }

    case "newtab":
      roamNewTab({ persona: p.persona });
      roamFocusBar();
      return roamState();

    case "select":
      roamSelect(p.tabId);
      return { ok: true };

    case "close":
      roamCloseTab(p.tabId || roamTabActive);
      return { ok: true };

    case "reopen":
      return { ok: !!roamReopen() };

    case "move":
      roamMove(p.tabId, Number(p.index) || 0);
      return { ok: true };

    case "nav": {
      const wc = roamWc();
      if (!wc) return { error: "no tab" };
      if (p.dir === "reload") wc.reload();
      else if (p.dir === "stop") wc.stop();
      else if (p.dir === "home") {
        const home = roamHomeUrl();
        if (home) wc.loadURL(home).catch(() => {});
        else wc.loadURL(roamNewTabUrl()).catch(() => {});
      } else navigate(ROAM_ID, p.dir);
      roamPush();
      return { ok: true };
    }

    case "persona":
      return roamSetPersona(p.tabId || roamTabActive, p.name);

    case "suggest":
      return { items: roam.suggest(p.query, 8), search: roamSearchTemplate() };

    case "pin": {
      const tab = roamTabs.get(roamTabActive);
      // Record the jar it was browsed in. Pinning a signed-in board and having
      // it reopen signed-out is the one way this feature could be useless.
      roam.pin({
        url: p.url || tab?.url,
        title: p.title || tab?.title,
        persona: p.persona || tab?.persona || null,
      });
      roamPush();
      return { ok: true };
    }

    case "unpin":
      roam.unpin(p.url || roamTabs.get(roamTabActive)?.url);
      roamPush();
      return { ok: true };

    case "forget": {
      const n = roam.forget(p);
      roamPush();
      return { forgotten: n };
    }

    case "expand":
      return roamExpand(p.open);

    case "copy-url": {
      const url = roamWc()?.getURL();
      if (!url) return { error: "nothing loaded" };
      clipboard.writeText(url);
      return { copied: true, url };
    }

    // The deliberate way out. Browsing stays in here by default; handing a
    // page to the real browser is now something you ask for — which is the
    // right way round for the one case it is genuinely needed, signing in to
    // something with a password manager that lives in Chrome.
    case "system": {
      const url = roamWc()?.getURL();
      if (!url || !/^https?:/i.test(url)) return { error: "no http(s) url" };
      shell.openExternal(url);
      return { opened: true };
    }

    case "devtools":
      roamWc()?.openDevTools({ mode: "bottom" });
      return { ok: true };

    case "find": {
      const wc = roamWc();
      if (!wc) return {};
      if (p.action === "stop") { wc.stopFindInPage("clearSelection"); return {}; }
      if (!p.text) return {};
      if (p.action === "find") wc.findInPage(p.text);
      else wc.findInPage(p.text, { forward: p.action !== "prev", findNext: true });
      return {};
    }

    case "zoom":
      zoom(ROAM_ID, p.dir);
      return { ok: true };

    // Clipping from the bar, so the gesture exists without a right-click.
    // Same saveClip path, same Trove, same provenance.
    case "clip": {
      const tab = roamTabs.get(roamTabActive);
      if (!tab || tab.blank) return { error: "nothing to clip" };
      const cfg = roamTabCfg(tab);
      if (p.what === "image") { clipPageImage(cfg, tab.view, "wilds-bar"); return { ok: true, kind: "page-image" }; }
      // A promise from a sync handler is fine for Electron, and it means the
      // reply says "filed" only once the line is actually in the index — the
      // preview capture happens before the reply, not after it.
      return clipPage(cfg, { pageURL: tab.url, titleText: tab.title }, "wilds-bar", tab.view.webContents)
        .then(() => ({ ok: true, kind: "page" }));
    }

    // Research leads, from the bar's picker. The bar never touches the file
    // itself — it has no fs, by design — it asks here, and this appends the
    // same append-only lines the Trove's own page appends through fs. One
    // switch, two doors, one file.
    case "lead": {
      const L = leads.fold();
      if (p.id != null && !L.leads.some((x) => x.id === p.id)) return { error: "no such lead" };
      if (p.id === L.active) return { ok: true, changed: false };
      leads.append({
        v: 1, kind: "lead-active", ref: p.id || null,
        t: Date.now(), at: new Date().toISOString(), agent: "wilds-bar",
      });
      roamPush();
      return { ok: true, changed: true };
    }

    case "lead-new": {
      const name = String(p.name || "").trim().slice(0, 120);
      if (!name) return { error: "a lead needs a name" };
      const L = leads.fold();
      const clash = L.leads.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (clash) return { error: `already a lead called "${clash.name}"`, id: clash.id };
      const id = clipper.leadId();
      leads.append({
        v: 1, kind: "lead", id, name,
        t: Date.now(), at: new Date().toISOString(), agent: "wilds-bar",
      });
      // Creating a lead from the browser is a decision to gather THERE — an
      // empty lead you then have to switch on is a step that serves the
      // machinery, not the research.
      leads.append({
        v: 1, kind: "lead-active", ref: id,
        t: Date.now(), at: new Date().toISOString(), agent: "wilds-bar",
      });
      roamPush();
      return { ok: true, id };
    }

    default:
      return { error: `unknown roam action '${action}'` };
  }
});

// The rail's door to the coding handoff. Toolbar-only, like the clip verbs:
// this is the person driving, not a hosted page.
ipcMain.handle("roost:cartridge", async (_e, action, payload = {}) => {
  const p = payload || {};
  switch (action) {
    case "apps":        return cartridge.apps();
    case "to-chat":     return forgeCartridgeToChat({ appIds: p.appIds, goal: p.goal });
    case "preview":     await forgePreviewSelection(p.text); return { ok: true };
    case "apply":       return forgeApplyLast({ verify: p.verify, goal: p.goal });
    case "correction":  return forgeCorrectionLast();
    case "last":        return { ok: true, has: !!lastPreview, result: lastPreview?.result || null };
    default:            return { error: `unknown cartridge action '${action}'` };
  }
});

// A Kenoma turn on the active app's folder, streamed to Müt's line and to
// Auri's task strip. One entry point: Müt's ring and Auri's drawer both ask
// through here, so retiring one of them never strands the other's ask.
async function forgeAsk(prompt) {
  if (!prompt) return { error: "empty prompt" };

  const app = appById(activeId);
  const workspace = app ? watchRoot(app) : null;

  // Immediate feedback, then live updates as the agent works.
  mutForgeBusy = true;
  mutLastEvent = Date.now();
  mut.stream("forge", "thinking…", "task-glyphs");
  // The same turn, as Auri's strip: what it is doing, and how far along.
  const taskId = heraldForgeTask = `forge:mut:${Date.now().toString(36)}`;
  herald.task({ id: taskId, kind: "code", who: "Kenoma", title: prompt, step: "thinking", progress: null, target: { forge: forge.DEFAULT_SESSION } });
  const ok = await forge.ensureForge();
  if (!ok) {
    herald.task({ id: taskId, state: "failed", summary: "Kenoma didn't start." });
    mut.stream("forge", "✗ Forge backend didn't start", "angry");
    mutForgeBusy = false;
    setTimeout(() => mut.setBase("idle"), 1500);
    return { error: "Forge backend didn't start" };
  }

  (async () => {
    let tail = "";
    let receipt = "";
    // What the turn has mostly been doing decides which finished drawing she
    // holds up: files changed is code, a turn that only looked things up is
    // research, one that only answered in words is writing.
    let changed = 0, looked = false;
    const step = (u) => herald.task({ id: taskId, ...u });
    try {
      for await (const ev of forge.askForge({ prompt, workspace })) {
        if (ev.parent) continue; // a scout's own steps stay inside its card
        if (ev.type === "tool_start") {
          const research = HERALD_RESEARCH.test(ev.name || "");
          if (research) looked = true;
          step({ kind: research ? "research" : "code", step: ev.name });
          mut.stream("forge", `⟳ ${ev.name}`, "task-execute");
        } else if (ev.type === "tool_end") {
          mut.stream("forge", `✓ ${ev.name}`, "happy");
        } else if (ev.type === "text") {
          tail = (tail + ev.text).slice(-90);
          step({ kind: "write", step: tail.split("\n").filter(Boolean).pop() || "writing" });
          mut.stream("forge", tail || "…", "confused");
        } else if (ev.type === "plan" && Array.isArray(ev.items) && ev.items.length) {
          // The agent's own to-do list, as one line: how far along, and what now.
          const done = ev.items.filter((i) => i.status === "done").length;
          const cur = ev.items.find((i) => i.status === "in_progress");
          mut.stream("forge", `plan ${done}/${ev.items.length}${cur ? " · " + String(cur.text).slice(0, 60) : ""}`, "task-execute");
          step({ progress: done / ev.items.length, step: cur ? String(cur.text) : `plan ${done}/${ev.items.length}` });
        } else if (ev.type === "approval" || ev.type === "ask") {
          // Answerable now, over whatever app is in front: Auri's card.
          heraldApproval(ev, forge.DEFAULT_SESSION);
          // He cannot answer from the rail; the cockpit on the `mut` session can.
          mut.stream("forge", ev.type === "ask" ? "Forge has a question — open its window" : "Forge needs your OK — open its window", "confused");
        } else if (ev.type === "retry") {
          mut.stream("forge", "retrying…", "confused");
        } else if (ev.type === "receipt") {
          // One line for the whole turn: what changed, did the tests pass, what it cost.
          const n = Array.isArray(ev.filesChanged) ? ev.filesChanged.length : 0;
          const tests = ev.testsResult ? (ev.testsResult.passed ? ", tests green" : ", tests red") : "";
          const cost = ev.cost && ev.cost.turn ? `, $${ev.cost.turn.toFixed(ev.cost.turn < 0.01 ? 4 : 2)}` : "";
          receipt = `${n ? `changed ${n} file${n === 1 ? "" : "s"}` : "no files changed"}${tests}${cost}`;
          changed = n;
          mut.stream("forge", receipt, ev.testsResult && !ev.testsResult.passed ? "sad" : "happy");
        } else if (ev.type === "error") {
          step({ state: "failed", summary: String(ev.message || "it failed").slice(0, 200) });
          mut.stream("forge", "✗ " + String(ev.message || "").slice(0, 120), "angry");
        } else if (ev.type === "done") {
          if (ev.stopped) step({ state: "stopped" });
          else step({ state: "done", kind: changed ? "code" : looked ? "research" : "write", summary: receipt || tail.trim() || "done" });
          mut.stream("forge", receipt || tail.trim() || "done", ev.stopped ? "confused" : "happy");
        }
        // thinking, tool_delta, terminal, iteration, usage, policy, checkpoint,
        // diff, compaction, job, explore, status: the window's business.
      }
    } catch (e) {
      step({ state: "failed", summary: String(e.message || e).slice(0, 200) });
      mut.stream("forge", "✗ " + String(e.message || e).slice(0, 120), "angry");
    }
    // A stream that ended without a done (Kenoma restarted under it) must
    // not leave a strip working forever.
    if (herald.tasks.has(taskId)) step({ state: "stopped" });
    if (heraldForgeTask === taskId) heraldForgeTask = null;
    // The sticky base face is his, not the agent's — put it back.
    mutForgeBusy = false;
    setTimeout(() => mut.setBase("idle"), 1500);
  })();

  return { ok: true };
}

// ------------------------------------------------------------------ Forge
// The coding agent, driven from Müt. The prompt comes from the rail; the
// active app's directory becomes the workspace, so "fix the Goblin Brain
// build" while looking at Goblin Brain means exactly that — the agent is a
// surface-level tool, not a per-app widget.
ipcMain.handle("roost:forge", async (_e, action, payload) => {
  payload = payload || {};
  if (action === "ask") return forgeAsk(String(payload.prompt || "").trim());
  if (action === "abort") {
    if (heraldForgeTask) herald.task({ id: heraldForgeTask, state: "stopped" });
    await forge.abort("mut");
    mutForgeBusy = false;
    mut.stream("forge", "stopped", "idle");
    setTimeout(() => mut.setBase("idle"), 1500);
    return { ok: true };
  }
  if (action === "restart") {
    const ok = await forge.restartForge();
    if (ok) mut.stream("forge", "restarting…", "task-execute");
    return { ok };
  }
  // Müt voice: phone app sends audio, Forge transcribes, optionally runs a turn.
  if (action === "voice") {
    const audioB64 = String(payload.audio || "");
    if (!audioB64) return { error: "audio data (base64) is required" };
    const audioBuffer = Buffer.from(audioB64, "base64");
    const app = appById(activeId);
    const workspace = app ? watchRoot(app) : null;
    try {
      const result = await forge.voiceForge({ audioBuffer, workspace, runTurn: !!payload.run });
      return { ok: true, text: result.text, runId: result.runId, turn: result.turn };
    } catch (e) {
      return { error: e.message };
    }
  }
  // Müt speaks: read text aloud in Müt's cartoony voice.
  if (action === "speak") {
    const text = String(payload.text || "").trim();
    if (!text) return { error: "text to speak is required" };
    try {
      await forge.speakForge(text);
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  }
  return { error: "unknown action" };
});

ipcMain.handle("roost:clip-peek", async (_e, url) => {
  if (!/^https?:/i.test(String(url || ""))) return {};
  return clipper.pageMeta(url);
});

ipcMain.handle("roost:clip-characters", () => clipper.glamoireCharacters().then((list) => ({ characters: list })));

// One entry point for everything the omnibox and Müt can hand in: a URL, a
// blob of text, pasted image bytes, or a path dropped from Explorer.
ipcMain.handle("roost:clip-add", async (_e, item) => {
  const { source = "omnibox", url, text, dataUrl, filePath, toGlamoire = null, toBrain: wantBrain = false, note } = item || {};
  const cfg = appById(activeId) || { id: "launcher", persona: "workshop" };
  try {
    let line = null;

    if (dataUrl) {
      const b64 = String(dataUrl).split(",")[1] || "";
      const mime = (String(dataUrl).match(/^data:([^;,]+)/) || [])[1] || "image/png";
      const buffer = Buffer.from(b64, "base64");
      line = saveClip({ kind: "image", buffer, mime, srcUrl: null, pageUrl: null,
        filename: "pasted" + clipper.extFor(mime, ""), cfg, agent: source, text: note || null });
    } else if (filePath) {
      const buffer = fs.readFileSync(filePath);
      if (buffer.length > clipper.MAX_BYTES) throw new Error(`too large (cap ${clipper.MAX_BYTES / 1048576}MB)`);
      line = saveClip({ kind: "file", buffer, mime: null, srcUrl: null, pageUrl: null,
        filename: path.basename(filePath), cfg, agent: source, text: note || null });
    } else if (url && /^https?:/i.test(url)) {
      const meta = await clipper.pageMeta(url);
      // A page URL is a link clip; a direct image URL fetches its bytes.
      const looksImage = /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(url);
      if (looksImage) {
        const { buffer, mime } = await clipper.fetchBytes(url, {});
        line = saveClip({ kind: "image", buffer, mime, srcUrl: url, pageUrl: url,
          pageTitle: meta.title, cfg, agent: source, text: note || null });
      } else {
        line = saveClip({ kind: "link", srcUrl: url, pageUrl: url, linkUrl: url,
          pageTitle: meta.title, cfg, agent: source, text: note || null });
      }
    } else if (text) {
      line = saveClip({ kind: "selection", text, cfg, agent: source });
    } else {
      return { error: "nothing to clip" };
    }

    if (toGlamoire && line.object) {
      const buffer = fs.readFileSync(path.join(TROVE_DIR, line.object));
      const name = path.basename(line.object);
      const r = await clipper.toGlamoire({ characterId: toGlamoire, filename: name, buffer, mime: line.mime });
      noteFanout(line, { to: "glamoire", character: toGlamoire, ...r, at: Date.now() });
    }
    if (wantBrain) {
      const r = await clipper.toBrain({
        rite: "research",
        subject: line.src?.pageTitle || line.text || line.src?.url || "a clip",
        context: [line.src?.url, line.text].filter(Boolean),
        meta: { clip: line.id, sha256: line.sha256 },
      });
      noteFanout(line, { to: "brain", ...r, at: Date.now() });
    }
    return { ok: true, id: line.id, kind: line.kind };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

// Re-hash every object against the index. This is what makes "we hash
// everything" checkable rather than merely asserted.
ipcMain.handle("roost:clip-verify", () => {
  const lines = trove.read().filter((l) => l.object && l.sha256);
  let ok = 0; const bad = [];
  for (const l of lines) {
    try {
      const buf = fs.readFileSync(path.join(TROVE_DIR, l.object));
      if (clipper.sha256(buf) === l.sha256) ok++;
      else bad.push({ id: l.id, object: l.object, reason: "hash mismatch" });
    } catch {
      bad.push({ id: l.id, object: l.object, reason: "missing" });
    }
  }
  return { checked: lines.length, ok, bad };
});

// ---------------------------------------------------------------- herald
// Auri's cards. lib/herald.js has the rules; renderer/herald draws them.
//
// What reaches her: Kenoma's approvals and questions from EVERY session (not
// only the one Müt started — a turn the phone asked for needs your OK just as
// much), a turn started from Müt as a task strip, a dev server falling over,
// an update waiting on a restart, and whatever a process on this machine
// files at POST /herald/notify or /herald/task (lib/mutsync.js). Müt still
// narrates all of it in his corner; she is where you answer it.
// `rest`: with Müt retired she keeps a face in the corner even when she has
// nothing to say (renderer/herald, the pip), so there is always something to
// see and to click.
function heraldSend(s) {
  if (heraldView && !heraldView.webContents.isDestroyed()) heraldView.webContents.send("herald", { ...s, phone: heraldPhone(), rest: mutRetired() });
}
const herald = new Herald({
  emit: (s) => heraldSend(s),
  isQuiet: () => !!mut.quiet,
  handlers: {
    allow: (c) => heraldAnswer(c, { decision: "approve" }),
    always: (c) => heraldAnswer(c, { decision: "approve", remember: "always" }),
    deny: (c) => heraldAnswer(c, { decision: "deny" }),
    answer: (c, p) => heraldAnswer(c, { answer: String(p.text || "") }),
    choose: (c, p) => heraldAnswer(c, { answer: (c.choices || [])[p.index] ?? null }),
    open: (c) => heraldOpen(c),
    retry: async (c) => {
      const r = await restartLocal(c.target && c.target.app);
      return r.error ? { ok: false, error: r.error } : r.restarted ? { ok: true } : { ok: false, error: "it would not come back up" };
    },
    logs: async (c) => {
      if (!c.target || !appById(c.target.app)) return { ok: false, error: "no app to read" };
      await activate(c.target.app);
      send("logs-open", { id: c.target.app });
      return { ok: true };
    },
    stop: async (c) => ({ ok: await forge.abort((c.meta && c.meta.session) || forge.DEFAULT_SESSION) }),
    restart: () => relaunchShell(),
    reply: (c, p) => commsReply(c, String(p.text || "")),
  },
});

// ---------------------------------------------------------------- comms
// The phone's notifications (lib/comms.js has the rules, Auri's phone app the
// NotificationListenerService). What arrives is triaged into her cards; what
// you clear on the phone settles here; a reply goes back through the phone's
// own Reply action. Nothing of it reaches the bus, a model or the disk.
const comms = createComms({
  onPost: () => { try { herald._changed(); } catch {} },
  onEvent: (ev) => {
    if (ev.type === "arrived") {
      const card = commsTriage(ev.item, { people: commsPeople(), away: commsAway() });
      if (card) herald.notify(card, { internal: true });
    } else if (ev.type === "removed") {
      const card = commsTriage(ev.item, {});
      if (card) herald.settle(card.key, { face: "wink", tag: "READ ON PHONE", body: "" });
    }
  },
});

// "Your people": names whose messages are band 3 even when they would not be.
// ui-state, so it survives a restart and never enters git.
function commsPeople() {
  const p = uiState.comms && uiState.comms.people;
  return Array.isArray(p) ? p : [];
}

// Nobody at the laptop: the phone in their pocket already told them, so the
// laptop keeps it in the drawer for when they are back. Five idle minutes, or
// a locked screen.
function commsAway() {
  try {
    return powerMonitor.getSystemIdleTime() >= 300 || powerMonitor.getSystemIdleState(300) === "locked";
  } catch { return false; }
}

async function commsReply(card, text) {
  if (!card.meta || !card.meta.comms) return { ok: false, error: "this card has nobody to reply to" };
  const r = await comms.reply(card.meta.comms, text);
  if (!r.ok) return r;
  return r.queued
    ? { ok: true, resolved: { face: "delivered", tag: "QUEUED", body: `\u21b3 ${text} (the phone sends it when it next checks in)` } }
    : { ok: true };
}

// Is the phone in reach, as Auri's drawer says it: when its page last polled
// (open, on the Wi-Fi), when its notification listener last posted (works
// with the app closed), and what the bridge holds right now.
function heraldPhone() {
  let c = { live: 0, phoneSeen: 0, dropped: 0, outbox: 0 };
  try { c = comms.status(); } catch {}
  const page = (mutSync.phoneSeen && mutSync.phoneSeen()) || 0;
  return { page, listener: c.phoneSeen || 0, showing: c.live, outbox: c.outbox };
}

// The drawer's own verbs. "ask" is Kenoma; "noop" exists so the page's bridge
// to main can be exercised without an outside effect (heraldtest.js).
async function heraldVerb(verb, p) {
  if (verb === "ask") {
    const prompt = String(p.prompt || "").trim();
    if (!prompt) return { ok: false, error: "nothing to ask" };
    return forgeAsk(prompt);
  }
  if (verb === "noop") return { ok: true };
  return { ok: false, error: `no such verb "${verb}"` };
}

function heraldAnswer(card, body) {
  if (!card.meta || !card.meta.approval) return { ok: false, error: "nobody is waiting on this" };
  return forge.answer(card.meta.approval, body);
}

async function heraldOpen(card) {
  const t = card.target || {};
  if (t.forge && appById("forge")) await activate("forge");      // Kenoma's cockpit holds the session
  else if (t.app && appById(t.app)) await activate(t.app);
  else if (t.url) openWeb(t.url);
  else return { ok: false, error: "nowhere to open" };
  // An approval stays until it is answered; opening only shows where it came from.
  return { ok: true, keep: !!(card.meta && card.meta.approval) };
}

// One Kenoma approval or question, from its event stream or from the poll.
// `once` makes the two sources one card rather than a card with x2 on it.
function heraldApproval(p, session) {
  if (!p || !p.id) return;
  const kind = p.kind || p.type;
  const where = { key: `forge:${p.id}`, once: true, band: 3, who: "Kenoma", chan: `Forge · ${session}`,
    target: { forge: session }, meta: { approval: p.id, session } };
  if (kind === "ask") {
    herald.notify({ ...where, kind: "question",
      body: p.question || "Kenoma has a question.",
      choices: Array.isArray(p.options) ? p.options.map((o) => (o && typeof o === "object" ? o.label || o.value : o)) : null,
      acts: p.allowFreeText === false ? ["open", "dismiss"] : ["answer", "open", "dismiss"],
    }, { internal: true });
  } else {
    const a = p.args || {};
    herald.notify({ ...where, kind: "approval",
      body: p.reason || `Wants to run ${p.tool || "a tool"}.`,
      cmd: p.command || [p.tool, a.path || a.url || a.file].filter(Boolean).join(" ") || null,
      acts: p.canRemember ? ["allow", "always", "deny", "open"] : ["allow", "deny", "open"],
    }, { internal: true });
  }
}

// Every session's approvals, every four seconds. A card answered in the
// cockpit or on the phone leaves on its own: whatever is no longer pending
// settles.
let heraldPolling = false;
async function heraldPollForge() {
  if (heraldPolling) return;
  heraldPolling = true;
  try {
    const list = await forge.pending();
    const seen = new Set();
    for (const p of list) { seen.add(`forge:${p.id}`); heraldApproval(p, p.sessionId); }
    for (const key of herald.keys("forge:")) {
      if (!seen.has(key)) herald.settle(key, { face: "wink", tag: "SETTLED", body: "Answered somewhere else, or no longer needed." });
    }
  } catch {} finally { heraldPolling = false; }
}

// The bus, as she hears it. Apps may file cards (herald.notify / herald.task)
// but are held to band 2 with harmless buttons; only the shell's own events
// raise anything with teeth. Same rule as mutHears, same reason.
function heraldHears(topic, payload, from) {
  const trusted = from === "shell";
  if (topic === "herald.notify") { herald.notify(payload || {}, { trusted }); return; }
  if (topic === "herald.task") { herald.task(payload || {}, { trusted }); return; }
  if (!trusted || !payload) return;
  if (topic === "app.exited" && payload.code) {
    const cfg = appById(payload.app);
    herald.notify({ kind: "error", band: 2, life: 20000, key: `crash:${payload.app}`,
      who: (cfg && cfg.name) || payload.app, chan: "dev server", body: `Fell over (exit code ${payload.code}).`,
      acts: cfg && cfg.kind === "local" ? ["retry", "logs", "dismiss"] : ["logs", "dismiss"],
      target: { app: payload.app } }, { internal: true });
  } else if (topic === "app.started") {
    herald.settle(`crash:${payload.app}`, { face: "joy", tag: "BACK UP", body: "Running again." });
  } else if (topic === "forge.applied") {
    const n = Array.isArray(payload.files) ? payload.files.length : 0;
    herald.notify({ kind: "done", band: 2, who: "The Forge", chan: "apply",
      body: `Wrote ${n} file${n === 1 ? "" : "s"}${payload.verify && payload.verify.ok === false ? ", and the check failed" : ""}.` }, { internal: true });
  }
}

// ---------------------------------------------------------------- briefs
// What the work apps file for the phone (lib/briefs.js). Lookout, Credentials
// and Onboarding call POST /briefs (loopback, bearer) or publish `briefs.file`
// on the bus; Professional Goat polls GET /briefs. A brief is also one of
// Auri's cards, band 2 with open/dismiss only, unless its level is "quiet".
// Only main.js may raise an approval, and a brief never is one.
function briefFile(spec) {
  const r = briefs.file(spec);
  if (r.error) return r;
  const b = r.brief;
  if (b.level !== "quiet") {
    herald.notify({
      kind: b.level === "urgent" ? "look" : "message", band: 2, key: `brief:${b.id}`,
      who: b.source, chan: "brief", body: b.title + (b.body ? ` — ${b.body}` : ""),
      acts: b.url ? ["open", "dismiss"] : ["dismiss"], target: b.url ? { url: b.url } : undefined,
    }, { internal: true });
  }
  return { ok: true, id: b.id };
}

// A note from the phone (POST /notes): appended to data/notes.jsonl and raised
// as a card, open/dismiss only.
function noteFile(spec) {
  const r = briefs.note(spec);
  if (r.error) return r;
  herald.notify({
    kind: "message", band: 2, key: `note:${r.note.id}`, who: "Professional Goat", chan: "note",
    body: r.note.text, acts: ["open", "dismiss"], target: { app: "launcher" },
  }, { internal: true });
  return { ok: true, id: r.note.id };
}

// Where her view really is, from main's side. "I don't see her" on the real
// machine, with every test green, was not answerable without it: the page can
// be drawing her perfectly into a view that is zero wide, hidden, or under
// something. Loopback only (POST /herald/state).
const heraldErrors = [];
function heraldViewReport() {
  if (!heraldView || !win) return { exists: false };
  let content = null, minimized = null;
  try { content = win.getContentBounds(); minimized = win.isMinimized(); } catch {}
  return {
    exists: true, bounds: heraldView.getBounds(), visible: heraldView.getVisible(),
    h: heraldH, w: heraldW, overlayOpen, rest: mutRetired(), content, minimized,
    url: heraldView.webContents.getURL().replace(/^.*\/renderer\//, "renderer/"),
    crashed: heraldView.webContents.isCrashed(), errors: heraldErrors.slice(-6),
  };
}

function heraldControl(action, payload) {
  if (action === "notify") { const id = herald.notify(payload || {}, { trusted: true }); return { ok: true, id }; }
  if (action === "task") { herald.task(payload || {}, { trusted: true }); return { ok: true }; }
  if (action === "reload") { if (heraldView && !heraldView.webContents.isDestroyed()) heraldView.webContents.reload(); return { ok: true }; }
  if (action === "state") return { ...herald.state(), phone: heraldPhone(), comms: comms.status(), view: heraldViewReport() };
  return { error: `no such herald action "${action}"` };
}

// The herald floats over every app view. addChildView on a view that is
// already in the tree re-stacks it on top, so each new view is followed by
// this.
function raiseFloats() {
  if (heraldView) win.contentView.addChildView(heraldView);
}

// Ctrl+` hands her the keyboard; again (or Esc on an empty corner) hands it
// back. With nothing on screen she opens her drawer, so the keys always land
// on something.
function heraldSummon() {
  if (!heraldView || heraldView.webContents.isDestroyed()) return;
  const wc = heraldView.webContents;
  if (wc.isFocused()) { focusActive(); return; }
  const empty = !herald.state().cards.some((c) => !c.resolved);
  wc.send("herald-focus", { drawer: empty });
  wc.focus();
  // A hidden view takes focus badly; it is visible once the page has grown
  // to fit the drawer, so ask again a beat later.
  setTimeout(() => { if (!wc.isDestroyed() && !wc.isFocused()) wc.focus(); }, 150);
}

ipcMain.handle("roost:herald", async (e, action, p) => {
  // Her page only. Nothing else has a preload that reaches this channel, but
  // a card's buttons answer Kenoma's approvals, so it is checked anyway.
  if (e && e.sender && heraldView && e.sender !== heraldView.webContents) return { error: "not yours" };
  p = p || {};
  if (action === "ready") return { ...herald.state(), phone: heraldPhone(), rest: mutRetired() };
  if (action === "act") return herald.act(p.id, String(p.action || ""), p.payload || {});
  if (action === "bounds") {
    const h = Math.max(0, Math.min(2400, Math.round(Number(p.h) || 0)));
    const w = Math.max(0, Math.min(HERALD_W, Math.round(Number(p.w) || 0)));
    if (h !== heraldH || w !== heraldW) { heraldH = h; heraldW = w; layout(); }
    return { ok: true };
  }
  if (action === "release") { focusActive(); return { ok: true }; }
  if (action === "verb") return heraldVerb(String(p.verb || ""), p.payload || {});
  return { error: "unknown action" };
});

// ---------------------------------------------------------------- hotkeys
// before-input-event fires no matter which view has focus, which is what a
// shell-level shortcut needs — globalShortcut would grab the keys system-wide
// even when Ifreglen is in the background, which is rude.
// The full map (also listed in the palette's help entry):
//   Ctrl+K            command palette
//   Ctrl+`            Auri: answer her cards (again, or Esc, gives the keys back)
//   Ctrl+1…9          jump to the nth registered app
//   Ctrl+Tab / +Shift cycle through apps in tab order
//   Ctrl+F            find in page
//   Ctrl+L            log drawer for the active app
//   Ctrl+R / F5       reload the active app
//   Ctrl+= / - / 0    zoom in / out / reset (remembered per app)
//   Alt+← / Alt+→     back / forward (external sites mostly)
//   F12               devtools for the active app
function wireHotkeys(wc) {
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const k = (input.key || "").toLowerCase();

    // Bare function keys.
    if (!input.control && !input.alt && !input.meta && !input.shift) {
      if (k === "f5") { e.preventDefault(); wcFor(activeId)?.reload(); return; }
      if (k === "f12") { e.preventDefault(); wcFor(activeId)?.openDevTools({ mode: "bottom" }); return; }
      return;
    }

    // Alt+arrows: history. Alt alone, no Ctrl/Meta.
    if (input.alt && !input.control && !input.meta) {
      if (k === "arrowleft") { e.preventDefault(); navigate(activeId, "back"); sendNavState(activeId); }
      else if (k === "arrowright") { e.preventDefault(); navigate(activeId, "forward"); sendNavState(activeId); }
      return;
    }

    if (!input.control || input.alt || input.meta) return;

    // Ctrl+` is Auri. By code as well as key, for layouts where the key under
    // Esc types something else.
    if ((k === "`" || input.code === "Backquote") && !input.shift) { e.preventDefault(); heraldSummon(); return; }

    // Shift variants belong to the page: Ctrl+Shift+K/F/L/R are devtools and
    // app shortcuts in half the tools this shell hosts.
    if (k === "k" && !input.shift) { e.preventDefault(); send("palette", {}); return; }
    if (k === "f" && !input.shift) { e.preventDefault(); send("find-open", {}); return; }
    if (k === "l" && !input.shift) {
      e.preventDefault();
      // In a browser Ctrl+L is the address bar; there are no server logs for a
      // web page, so nothing is lost and the muscle memory is right.
      if (activeId === ROAM_ID) roamFocusBar();
      else send("logs-open", { id: activeId });
      return;
    }
    // Ctrl+J: ask a chat about the page in front -- Beside opens if it is
    // closed and the page goes into its box, ready for the question.
    if (k === "j" && !input.shift) { e.preventDefault(); besideShare(); return; }
    // Ctrl+D is "bookmark" everywhere else, which is exactly what quick-add is.
    if (k === "d" && !input.shift) { e.preventDefault(); send("clip-open", {}); return; }
    if (k === "r" && !input.shift) { e.preventDefault(); wcFor(activeId)?.reload(); return; }
    // Ctrl+M summons Müt. Bare Ctrl rather than a Shift variant because those
    // belong to the page, and M is the one letter nobody else in this shell
    // wants. This is also the escape hatch if he is ever off-screen.
    // While Müt is retired, Ctrl+M is Auri's: the same hand-me-the-familiar key.
    if (k === "m" && !input.shift) { e.preventDefault(); heraldSummon(); return; }
    // Browser muscle memory: Ctrl+W "closes the tab" — here that means
    // hibernate the active app and land home. On the launcher it's a no-op.
    if (k === "w" && !input.shift) {
      e.preventDefault();
      if (activeId === ROAM_ID) roamCloseTab(roamTabActive);
      else if (activeId && activeId !== "launcher") closeView(activeId);
      return;
    }

    // Ctrl+T from anywhere in the shell opens a fresh page in The Wilds — the
    // shortest path from "I want to look something up" to a cursor in an
    // address bar, without leaving the window. Ctrl+Shift+T brings back the
    // last tab you closed.
    if (k === "t" && roamAvailable()) {
      e.preventDefault();
      roamEnsure();
      if (input.shift) { if (!roamReopen()) return; }
      else roamNewTab({});
      activate(ROAM_ID);
      if (!input.shift) roamFocusBar();
      return;
    }

    if (k === "tab") {
      e.preventDefault();
      if (activeId === ROAM_ID && roamOrder.length > 1) { roamCycle(input.shift); return; }
      const order = config.apps.map((a) => a.id);
      if (!order.length) return;
      const i = Math.max(0, order.indexOf(activeId));
      const next = order[(i + (input.shift ? order.length - 1 : 1)) % order.length];
      activate(next);
      return;
    }

    if (k === "=" || k === "+") { e.preventDefault(); zoom(activeId, "in"); return; } // "+" IS shift+=
    if (k === "-" && !input.shift) { e.preventDefault(); zoom(activeId, "out"); return; }
    if (k === "0" && !input.shift) { e.preventDefault(); zoom(activeId, "reset"); return; }

    if (input.shift) return; // Ctrl+Shift+digit etc. belong to the page
    const n = Number(k);
    if (n >= 1 && n <= 9) {
      const a = config.apps[n - 1];
      if (a) {
        e.preventDefault();
        activate(a.id);
      }
    }
  });
}

// ----------------------------------------------------------------- boot

// Windows groups taskbar buttons and resolves the icon by AppUserModelID.
// Without this, Electron reports itself as "electron.app.Electron" and you get
// the default Electron icon in the taskbar no matter what you set on the
// window — the single most common reason a custom icon "doesn't work".
// Must be called before any window is created.
if (process.platform === "win32") {
  app.setAppUserModelId("com.ifreglen.shell");
}

// A parallel profile: `electron . --user-data-dir=D:\some\dir` runs a second,
// fully separate shell (own personas, own lock). Useful for testing changes
// while the real one stays up.
const udOverride = process.argv.find((a) => a.startsWith("--user-data-dir="));
if (udOverride) {
  app.setPath("userData", path.resolve(udOverride.split("=").slice(1).join("=")));
}

// `electron . --app=<id>` boots straight into one app instead of the Sanctum.
// This is what the per-app desktop launchers pass, so each shortcut behaves
// like its own program while still being the one shell underneath.
function appArg(argv) {
  const a = (argv || []).find((x) => x.startsWith("--app="));
  return a ? a.split("=").slice(1).join("=") : null;
}

// One shell, ever. Two instances share the persist: partitions and fight over
// the profile on disk (cookie jars, cache) — which quietly corrupts the
// persona isolation the whole design leans on. A second launch just fronts
// the window that already exists.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    // The lock means a second launcher click never starts a new process, so
    // without this a Lookout shortcut pressed while the shell is already up
    // would just front whatever was on screen. Honour its --app= instead.
    const requested = appArg(argv);
    if (requested && appById(requested)) activate(requested);
  });
}

app.whenReady().then(async () => {
  config = loadConfig();
  // Before any session is wired: route through Haruspex only where it exists.
  egressProxyEnabled = egressHere();
  if (!egressProxyEnabled) console.log(`[egress] browsing direct: ${process.argv.includes("--no-egress") ? "--no-egress" : "no Haruspex in the registry for this platform"}`);
  fs.mkdirSync(DATA, { recursive: true });
  // The Trove exists from boot, not from the first clip — its app declares
  // data/trove as an fs root, and a root that doesn't exist yet makes the
  // archive look broken rather than empty.
  try { trove.ensure(); } catch {}
  // The Trove's Apps tab reads data/trove/apps.json. Seed it once with the
  // phone's two cards (install, pair) so a fresh data dir shows them; a file
  // the person has edited is left alone.
  try {
    const appsJson = path.join(TROVE_DIR, "apps.json");
    if (!fs.existsSync(appsJson)) fs.writeFileSync(appsJson, JSON.stringify(PHONE_CARDS, null, 2) + "\n", "utf8");
  } catch {}
  // Every static app the registry declares a root for gets that folder from
  // boot, so the first write through roost.fs is not the first mkdir.
  for (const a of config.apps) {
    if (a && a.kind === "static" && a.root && (a.capabilities || []).includes("fs")) {
      try { fs.mkdirSync(path.resolve(ROOT, a.root), { recursive: true }); } catch {}
    }
  }

  const winOpts = {
    width: 1360,
    height: 900,
    backgroundColor: "#0C1118",
    title: "Ifreglen",
  };
  // Reopen where it was closed — but only if that spot still exists. A saved
  // position on an unplugged monitor must not open the window into the void.
  const saved = uiState.window;
  if (saved?.bounds && saved.bounds.width >= 400 && saved.bounds.height >= 300) {
    const d = screen.getDisplayMatching(saved.bounds).workArea;
    const b = saved.bounds;
    const visible =
      b.x < d.x + d.width - 60 && b.x + b.width > d.x + 60 &&
      b.y < d.y + d.height - 60 && b.y >= d.y - 20;
    if (visible) Object.assign(winOpts, { x: b.x, y: b.y, width: b.width, height: b.height });
  }
  // macOS takes its icon from the app bundle, not the window; setting it here
  // is ignored there and can log a warning, so only pass it elsewhere.
  if (process.platform !== "darwin" && fs.existsSync(ICON)) winOpts.icon = ICON;
  if (process.platform === "darwin" && app.dock && fs.existsSync(ICON)) {
    try { app.dock.setIcon(ICON); } catch {}
  }

  win = new BaseWindow(winOpts);
  if (saved?.maximized) win.maximize();

  // Remember bounds as they change rather than at quit — a crash then costs
  // nothing. getNormalBounds so a maximized close restores to the un-maximized
  // size, with maximized recorded separately. Skip while minimized: on Windows
  // WM_SIZE(SIZE_MINIMIZED) reports isMaximized() === false and 0x0 bounds.
  const noteBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const bounds = win.getNormalBounds();
    if (!bounds || bounds.width < 400 || bounds.height < 300) return;
    uiState.window = { bounds, maximized: win.isMaximized() };
    saveUiState();
  };
  win.on("resize", noteBounds);
  win.on("move", noteBounds);

  // Bring a SHELL-OWNED view back when its renderer dies.
  //
  // This was missing, and the way it failed is worth writing down because the
  // shell gave no clue at all. A GPU fault took out every renderer in the
  // window at once. The app views have handled this since they were written —
  // but only by REPORTING it: they send an "app-error" to the rail saying
  // "Ctrl+R to bring it back". The rail had died in the same instant. So the
  // message was posted to a dead renderer, nothing repainted, and what was
  // left was a window with its title bar and menu and a completely black
  // interior. No error, no log line, process still running.
  //
  // Worse, it could not be escaped. main.js:2387 takes a single-instance lock
  // and a second launch silently app.quit()s, so double-clicking the shortcut
  // did nothing whatsoever — second-instance just re-focused the same dead
  // window. From outside it looks exactly like "the shell won't launch", and
  // the only way out is Task Manager.
  //
  // Reloading is safe HERE in a way it is not for an app view. The rail and
  // the herald are the shell's own UI: their state is derived from main and
  // re-sent on load, so a reload costs nothing. An app view can hold a half-typed form
  // or an unsaved buffer, which is why those still report rather than reload,
  // and that asymmetry is deliberate.
  //
  // Bounded, because a renderer that crashes on load would otherwise spin
  // forever and cook the machine. If the rail cannot be brought back, say so
  // in the one surface that does not depend on a live renderer — a native
  // dialog — rather than leaving a black rectangle and no explanation.
  const revive = (getView, name, { limit = 3, windowMs = 60000, onLost } = {}) => {
    let attempts = [];
    const wire = () => {
      const view = getView();
      if (!view || view.webContents.isDestroyed()) return;
      view.webContents.on("render-process-gone", (_e, d) => {
        // A clean exit is the window closing, not a fault.
        if (d.reason === "clean-exit") return;
        const now = Date.now();
        attempts = attempts.filter((t) => now - t < windowMs);
        if (attempts.length >= limit) {
          console.error(`[roost] ${name} renderer died ${attempts.length + 1}x — giving up`);
          onLost?.(d.reason);
          return;
        }
        attempts.push(now);
        console.warn(`[roost] ${name} renderer gone (${d.reason}) — reloading`);
        try {
          view.webContents.reload();
        } catch (err) {
          console.error(`[roost] ${name} would not reload:`, err.message);
          onLost?.(d.reason);
        }
      });
    };
    wire();
  };

  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(ROOT, "preload-chrome.js"),
      contextIsolation: true,
    },
  });
  chromeView.setBackgroundColor("#00000000");
  sealView(chromeView);
  win.contentView.addChildView(chromeView);
  chromeView.webContents.loadFile(path.join(ROOT, "renderer", "chrome.html"));
  chromeView.webContents.on("did-finish-load", () => {
    if (overlayOpen) { overlayOpen = false; layout(); }
  });
  revive(() => chromeView, "chrome rail", {
    onLost: (reason) => {
      // The rail is the shell's entire interface. Without it there is nothing
      // left to show a message IN, so this is the one place a modal is the
      // right answer rather than a lazy one.
      dialog.showErrorBox(
        "Ifreglen lost its interface",
        `The rail's renderer kept crashing (${reason}).

`
        + "Quit and start it again. If it keeps happening, launch with "
        + "--disable-gpu — a failing graphics driver is the usual cause, and "
        + "that flag proves it in one run."
      );
    },
  });

  // Auri, over the app area's top-right corner: a transparent view, sized by
  // its own page (roost:herald "bounds"), hidden at zero, and raised above
  // each new app view by raiseFloats().
  heraldView = new WebContentsView({
    webPreferences: {
      preload: path.join(ROOT, "preload-herald.js"),
      contextIsolation: true,
    },
  });
  heraldView.setBackgroundColor("#00000000");
  sealView(heraldView);
  win.contentView.addChildView(heraldView);
  heraldView.setBounds({ x: 0, y: 0, width: HERALD_W, height: 1 });
  heraldView.setVisible(false);
  heraldView.webContents.loadFile(path.join(ROOT, "renderer", "herald", "index.html"));
  revive(() => heraldView, "the herald", {
    onLost: () => console.error("[roost] the herald could not be revived; carrying on without her"),
  });
  wireHotkeys(heraldView.webContents);       // Ctrl+K and Ctrl+` still work while she has the keys
  // Her page cannot be trusted to hear its own blur: focus moving to a sibling
  // view does not always fire one, and a page that thinks it still has the
  // keys keeps its pip and legend up over the app. So main says, both ways.
  heraldView.webContents.on("focus", () => heraldView.webContents.send("herald-focus", { on: true }));
  heraldView.webContents.on("blur", () => heraldView.webContents.send("herald-focus", { on: false }));
  // Her page's errors, kept for heraldViewReport(): nothing else captures a
  // shell started from a shortcut, which has no console to print to.
  // (Recent Electron puts level and message on the event; older passed them
  // as arguments.)
  heraldView.webContents.on("console-message", (e, lvl, msg) => {
    const l = e && e.level != null ? e.level : lvl;
    const level = l === "error" || l === 3 ? "error" : l === "warning" || l === 2 ? "warning" : null;
    const text = e && e.message != null ? e.message : msg;
    if (level) { heraldErrors.push(`${level}: ${String(text || "").slice(0, 300)}`); if (heraldErrors.length > 20) heraldErrors.shift(); }
  });
  heraldView.webContents.on("render-process-gone", (_e, d) => heraldErrors.push(`renderer gone: ${d && d.reason}`));
  setInterval(() => herald.tick(), 250);
  setInterval(() => {
    try { if (win && !win.isDestroyed() && win.isMinimized()) return; } catch {}
    heraldPollForge();
  }, 4000);
  // Beside comes back the way it was left.
  if (uiState.beside?.open) besideSet(true);

  wireHotkeys(chromeView.webContents);
  win.on("resize", () => {
    if (win && !win.isDestroyed() && win.isMinimized()) return;
    layout();
  });

  // When a BaseWindow with child WebContentsViews is minimized on Windows, DWM
  // and Chromium's DelegatedFrameHost can evict the child compositor surfaces
  // and restore to the window's bare #0C1118 background unless the visible
  // views are re-laid-out and invalidated after unminimizing (or after a GPU
  // process reset).
  const restoreViews = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    layout();
    const visible = [chromeView];
    if (activeId === ROAM_ID) {
      if (roamBar) visible.push(roamBar);
      const tab = roamTabs.get(roamTabActive);
      if (tab?.view) visible.push(tab.view);
    } else if (activeId && views.has(activeId)) {
      visible.push(views.get(activeId));
    }
    if (besideIsOpen()) {
      if (besideBar) visible.push(besideBar);
      if (besideView) visible.push(besideView);
    }
    if (heraldView && heraldH > 0 && !overlayOpen) visible.push(heraldView);
    for (const v of visible) {
      if (!v || !v.webContents || v.webContents.isDestroyed()) continue;
      try {
        if (v._gone || v.webContents.isCrashed()) {
          v._gone = false;
          v.webContents.reload();
          continue;
        }
        v.setVisible(false);
        v.setVisible(true);
        v.webContents.invalidate();
      } catch {}
    }
    if (activeId === ROAM_ID && roamBar) win.contentView.addChildView(roamBar);
    raiseFloats();
    if (overlayOpen && chromeView) win.contentView.addChildView(chromeView);
  };
  const onRestore = () => {
    restoreViews();
    setTimeout(restoreViews, 32);
    setTimeout(layout, 120);
  };
  win.on("restore", onRestore);
  win.on("show", onRestore);
  win.on("maximize", layout);
  win.on("unmaximize", layout);
  app.on("child-process-gone", (_e, d) => {
    if (d && d.type === "GPU") setTimeout(onRestore, 100);
  });

  // The phone bridge (lib/mutsync.js). This is the only thing in the shell
  // that opens a port, so every route is bearer-authed; the token is minted
  // on first boot and kept in secrets.json. See lib/mutsync.js for why it is
  // a LAN listener rather than a cloud service.
  try {
    const syncToken = () => {
      const t = resolveSecrets("${MUT_SYNC_TOKEN}");
      return t && !t.includes("${") ? t : null;
    };
    // If no MUT_SYNC_TOKEN is set, generate one now and save it so the QR
    // always carries a working token. The phone needs this to authenticate.
    // A 32-byte random hex string, kept in secrets.json.
    if (!syncToken()) {
      const tok = require("node:crypto").randomBytes(32).toString("hex");
      writeSecret("MUT_SYNC_TOKEN", tok);
      console.log("[roost] Generated a new MUT_SYNC_TOKEN — the QR now carries it.");
    }
    // Start the server regardless of whether a token is configured: the
    // authed routes return 503 when the token is absent, and /ping and the
    // install page work either way so the QR always loads.
    mutSync.start({
      root: DATA,
      token: syncToken,
      // The browser's doorway for agents. Same server, same bearer token,
      // same loopback — one open port stays one open port.
      wilds: wildsControl,
      // Auri's door: POST /herald/notify and /herald/task (heraldControl).
      herald: heraldControl,
      // The phone's notifications in, replies out (lib/comms.js).
      comms,
      // Briefs for the phone and notes from it (lib/briefs.js, briefFile above).
      briefs: { file: briefFile, list: (since) => briefs.list(since), ack: (ids) => briefs.ack(ids), note: noteFile, notes: () => briefs.notes() },
      // The morning brief (lib/morning.js): POST /morning files it now; GET/POST /morning/schedule reads or sets the time.
      morning: { run: () => morning.runNow(), schedule: (o) => morning.configure(o || {}) },
      // The bus, heard from outside: GET /bus/stream (lib/busstream.js).
      stream: busStream,
      // GET /compute used to publish the paired GPU nodes; there are none
      // here, so the roster is honestly empty rather than absent (Kenoma's
      // router reads it and falls through to its own lanes).
      compute: async () => ({ t: Date.now(), nodes: [] }),
      // Once it is actually up -- on 8793, or wherever it had to walk to.
      // Everything that prints the address waits for this rather than
      // assuming the number.
      onListening: (port) => {
        // Printed in the form the phone's settings sheet asks for, so it can
        // be typed straight in rather than worked out.
        const where = mutSync.addresses().map((a) => `${a}:${port}`);
        console.log(`[roost] phone bridge listening on :${port}`
          + (where.length ? ` — on the phone, enter ${where.join(" or ")}`
                          : " — but this machine has no LAN address right now"));
        // And everything that talks to it is told the same: the apps this
        // shell starts inherit IFREGLEN_PORT (and XIXOXIS_PORT, which Kenoma
        // and Haruspex still read), and the rest (the MCP bridge) read
        // data/services.json. lib/services.js says why.
        process.env.IFREGLEN_PORT = String(port);
        morning.start();
        process.env.XIXOXIS_PORT = String(port);
        const st = syncToken();
        services.publish(DATA, { mutSync: { port, token: st || undefined } });
        // Poke a hole in Windows Firewall so the phone can reach us. The rule is
        // named so it's idempotent: running it again just updates the existing one.
        if (process.platform === "win32") {
          execFile("netsh", ["advfirewall", "firewall", "add", "rule",
            "name=Ifreglen phone bridge", "dir=in", "action=allow",
            "protocol=TCP", `localport=${port}`, "profile=any"],
            { windowsHide: true }, (err) => {
              if (err) console.warn("[roost] Could not add firewall rule for the phone bridge:", err.message);
            });
        }
      },
    });
  } catch (err) {
    console.warn("[roost] the phone bridge did not start:", err.message);
  }

  // Before the apps: until it has answered, the direct fallback is off.
  egressNet.start();
  // Haruspex at once, not after the startWithShell delay below: every page
  // asked for before it listens fails (and off a VPN stays failed until
  // retryProxyFailures). The loop below finds it started and moves on.
  const hx = egressProxyEnabled && appById("haruspex");
  if (hx && hx.startWithShell) ensureLocal(hx).catch(() => {});

  // Apps that start with the shell: a local app whose registry entry says
  // "startWithShell": true. Its server is started, nothing is opened -- the
  // rail simply finds it running. A few seconds in and one at a time, so they
  // do not compete with the window for its first paint; one already running
  // is adopted, as when its tile is opened (doEnsureLocal).
  setTimeout(async () => {
    for (const cfg of config.apps.filter((a) => a && a.kind === "local" && a.startWithShell === true)) {
      try {
        if (!(await ensureLocal(cfg))) console.warn(`[roost] ${cfg.id} did not start with the shell`);
      } catch (e) { console.warn(`[roost] ${cfg.id} did not start with the shell: ${e.message}`); }
    }
  }, 4000);

  // Say it at boot: a static app whose page is not on disk yet (the apps/
  // folder is built in this repo and may lag the registry) shows the offline
  // notice when opened rather than taking the shell down, but a line here
  // says why before anyone clicks.
  for (const a of config.apps) {
    if (a && a.kind === "static" && a.path && !fs.existsSync(path.resolve(ROOT, a.path))) {
      console.warn(`[roost] ${a.id}: its page is not there yet (${a.path}); the tile will show an error until it is`);
    }
  }

  chromeView.webContents.once("did-finish-load", () => {
    layout();
    const requested = appArg(process.argv);
    const first = requested && appById(requested)
      ? requested
      : config.defaultApp && appById(config.defaultApp)
        ? config.defaultApp
        : config.apps[0]?.id;
    if (first) activate(first);

    // He has never greeted anyone on a cold start. His greet lines existed but
    // fired only from the rail's toggle, so opening the shell — the one moment
    // you are certainly looking at him — was silent. How long you were gone is
    // the difference between "you're back" and nothing worth saying: under ten
    // minutes he stays quiet, because you only went for coffee.
    const gone = Date.now() - (Number(mutMemory.lastSeen) || 0);
    if (mutMemory.lastSeen && gone > 10 * 60 * 1000) {
      setTimeout(() => mut.push({ key: "greet", topic: "greet", priority: 0, state: "happy" }), 2500);
    }
  });

  if (process.argv.includes("--devtools")) {
    chromeView.webContents.openDevTools({ mode: "detach" });
  }
});

app.on("window-all-closed", () => app.quit());

// Electron does not await an async before-quit handler — it fires the event
// and keeps quitting, so the first `await` used to hand control back and the
// capture flush / server teardown raced the process dying. Intercept the
// quit once, finish the teardown for real, then exit deliberately.
let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  egressNet.stop();
  flushMutMemory();   // debounced everywhere else; this is the guarantee
  (async () => {
    for (const id of [...spawned.keys()]) {
      try { stopLocal(id); } catch {} // taskkill /T — child.kill() would orphan the dev server
    }
    for (const w of watchers.values()) {
      try { w.stop(); } catch {}
    }
    // Debounced everywhere else; this is the guarantee that the tabs you had
    // open are the tabs you get back.
    try {
      roam.remember(roamOrder.map((id) => {
        const t = roamTabs.get(id);
        return t && !t.blank ? { url: t.url, persona: t.persona, title: t.title } : null;
      }).filter(Boolean));
      roam.flush();
    } catch {}
  })().finally(() => app.exit());
});

// For shell/test.js only — playwright._electron drives the real app, and its
// main-process evaluate() has no lexical require, so pure functions are
// reached through a global stash. No runtime consumer.
// Test seam.
globalThis.__testables = {
  effectiveCaps, mutHears, MUT_EVENTS, mut,
  // The herald: the queue, the summon, and the view's real geometry — the
  // narrow-view rule is only enforceable if a test can read the bounds.
  herald, heraldSummon, heraldControl, comms,
  heraldVerb,
  // The phone bridge's briefs and notes, by the same path the routes take.
  briefFile, noteFile, briefs, morning,
  heraldGeometry: () => ({ h: heraldH, w: heraldW, bounds: heraldView ? heraldView.getBounds() : null, visible: heraldView ? heraldView.getVisible() : false,
    focused: heraldView ? heraldView.webContents.isFocused() : false }),
  // The Wilds. openWeb is the seam that matters: it is what every link
  // leaving a hosted app now goes through, and the only way to assert "this
  // did not open Chrome" is to call it and look at where the tab landed.
  openWeb, roamOpen, roamState, roamPersonas, roamTabCfg, roamSetPersona, wildsControl,
  // Beside. besideMount takes any chat config, which is how a test docks a
  // local fake chat instead of a real site.
  besideSet, besideShare, besideState, besideMount,
  activate, activeId: () => activeId,
  besideGeometry: () => ({
    open: besideIsOpen(),
    bar: besideBar && !besideBar.webContents.isDestroyed() ? { bounds: besideBar.getBounds(), visible: besideBar.getVisible() } : null,
    view: besideView && !besideView.webContents.isDestroyed() ? { bounds: besideView.getBounds(), visible: besideView.getVisible(), url: besideView.webContents.getURL() } : null,
    herald: heraldView ? heraldView.getBounds() : null,
    tab: (() => { const t = roamTabs.get(roamTabActive); return t && !t.view.webContents.isDestroyed() ? t.view.getBounds() : null; })(),
    app: views.get(activeId) ? views.get(activeId).getBounds() : null,
    window: win.getContentBounds(),
  }),
  // The overlay rule is the bug this shell keeps re-growing: a sheet drawn
  // taller than its view is invisible, not broken-looking. Exposing the bar's
  // real geometry is what lets a test assert it instead of a person noticing.
  roamOverlay: async () => {
    const live = roamBar && !roamBar.webContents.isDestroyed();
    return {
      tall: roamBarTall,
      visible: roamVisible,
      tabs: roamTabs.size,
      bar: live ? roamBar.getBounds() : null,
      // The view's height and its document's must agree. If they drift, a
      // sheet paints into a viewport that is not the size the compositor is
      // showing — which is invisible rather than obviously wrong.
      vh: live ? await roamBar.webContents.executeJavaScript("innerHeight").catch(() => null) : null,
    };
  },
  mutSettings,
};
