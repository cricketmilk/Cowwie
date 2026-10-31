// Lookout — a read-only monitoring and research bot for a healthcare HR desk.
//
// Watches public pages (regulators, boards, newsrooms), distills them to text,
// diffs each visit against the last, scores the change, and files a brief to
// the Ifreglen shell when a change looks like it matters. Zero dependencies:
// Node 22 built-ins only. Everything stays on this machine; nothing here ever
// calls a model or sends page content anywhere but the shell's own loopback.
//
// Run:  node server.js        (LOOKOUT_PORT overrides 8812)
// The shell sniffs the port from the first stdout line, so that line is
// printed before anything else and is exactly the URL.

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const HERE = __dirname;
const PORT = Number(process.env.LOOKOUT_PORT) || 8812;
const DATA = path.join(HERE, "data");
const SNAPS = path.join(DATA, "snapshots");
const WATCHES_FILE = path.join(DATA, "watches.json");
const FINDINGS_FILE = path.join(DATA, "findings.jsonl");

// Never fetch any single source more often than this, whatever "every" says.
// These are public regulator sites; being a polite reader is the whole point.
const MIN_INTERVAL_MS = 60 * 60 * 1000;
const EVERY_MS = {
  hourly: MIN_INTERVAL_MS,
  daily: 24 * MIN_INTERVAL_MS,
  weekly: 7 * 24 * MIN_INTERVAL_MS,
};
const DEFAULT_THRESHOLD = 40;
const USER_AGENT = "Ifreglen-Lookout/1.0 (read-only page monitor; local desktop)";

fs.mkdirSync(SNAPS, { recursive: true });

// ---------------------------------------------------------------- storage

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
// Write via a temp file and rename so a crash mid-write cannot leave a
// half-written watches.json that then loses every watch on next start.
function writeJson(file, value) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

let watches = readJson(WATCHES_FILE, []);
const saveWatches = () => writeJson(WATCHES_FILE, watches);

function readFindings() {
  let text = "";
  try { text = fs.readFileSync(FINDINGS_FILE, "utf8"); } catch { return []; }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}
// Findings are append-only history; acks are recorded as their own lines and
// folded in on read, so a line is never rewritten.
function appendFinding(obj) {
  fs.appendFileSync(FINDINGS_FILE, JSON.stringify(obj) + "\n");
}
function findingsFolded() {
  const byId = new Map();
  for (const row of readFindings()) {
    if (row.ack && byId.has(row.id)) { byId.get(row.id).acked = row.when; continue; }
    if (!row.ack) byId.set(row.id, { ...row, acked: null });
  }
  return [...byId.values()].sort((a, b) => (a.when < b.when ? 1 : -1));
}

const id = () => crypto.randomBytes(6).toString("hex");
const now = () => new Date().toISOString();
const stamp = () => now().replace(/[:.]/g, "-");

function snapshotDir(watchId) {
  const d = path.join(SNAPS, watchId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function latestSnapshot(watchId) {
  const d = snapshotDir(watchId);
  const files = fs.readdirSync(d).filter((f) => f.endsWith(".md")).sort();
  if (!files.length) return null;
  return fs.readFileSync(path.join(d, files[files.length - 1]), "utf8");
}
function writeSnapshot(watchId, text) {
  fs.writeFileSync(path.join(snapshotDir(watchId), stamp() + ".md"), text);
}

// --------------------------------------------------------- the shell's door

// secrets.json lives two levels up (desktop/secrets.json), same shape as the
// Xixoxis shell's. It is read per call, not cached: the shell may rotate it or
// come up after Lookout did.
function syncToken() {
  if (process.env.MUT_SYNC_TOKEN) return process.env.MUT_SYNC_TOKEN;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "secrets.json"), "utf8"));
    return s.MUT_SYNC_TOKEN ? String(s.MUT_SYNC_TOKEN) : "";
  } catch { return ""; }
}

// The sync server starts at 8793 and may walk upward if something else holds
// it. An env override wins; otherwise probe /ping (unauthenticated, answers
// {who:"mut-sync"} or {who:"ifreglen"}). The found port is remembered only briefly, because the
// shell restarting onto another port is exactly the case probing exists for.
let syncPortCache = { port: 0, at: 0 };
async function syncPort() {
  const env = Number(process.env.IFREGLEN_SYNC_PORT || process.env.MUT_SYNC_PORT);
  if (Number.isInteger(env) && env > 0) return env;
  if (syncPortCache.port && Date.now() - syncPortCache.at < 5 * 60 * 1000) return syncPortCache.port;
  for (let p = 8793; p <= 8810; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/ping`, { signal: AbortSignal.timeout(700) });
      if (!r.ok) continue;
      const j = await r.json().catch(() => ({}));
      if (j && (j.who === "mut-sync" || j.who === "ifreglen")) { syncPortCache = { port: p, at: Date.now() }; return p; }
    } catch {}
  }
  return 0;
}

async function shellPost(pathname, body) {
  const port = await syncPort();
  const token = syncToken();
  if (!port || !token) return { error: port ? "no sync token" : "shell not up" };
  try {
    const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) || `shell answered ${r.status}` }; }
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// POST /briefs {source, title, body, level?, url?, when?} → phone + herald.
// Briefs that cannot be delivered are kept in-app (the finding is still on
// disk) so nothing is lost when the shell is down; they are just not pushed.
async function fileBrief(brief) {
  const r = await shellPost("/briefs", { source: "lookout", ...brief });
  return !r.error;
}

// ---------------------------------------------------------------- fetching

// Strip to readable text. This is the fallback when the shell's Wilds is not
// available: good enough for the server-rendered government pages Lookout is
// built for, blind to single-page apps (the Wilds path covers those).
function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  // <head> goes entirely: a <title> is not page content and would otherwise
  // show up as a diff line when a site renames its tab.
  s = s.replace(/<head\b[\s\S]*?<\/head>/gi, "");
  s = s.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, "\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|dd|dt|blockquote|pre)>/gi, "\n");
  s = s.replace(/<h([1-6])[^>]*>/gi, (_, n) => "\n" + "#".repeat(Number(n)) + " ");
  s = s.replace(/<li[^>]*>/gi, "- ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  // Collapse whitespace per line, drop empties: line-level diffs want one
  // stable line per visible chunk, not per source newline.
  const lines = s.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  return lines.join("\n");
}

async function fetchDirect(url) {
  if (url.startsWith("file://")) {
    // Local test fixtures only; handy for exercising the diff without the net.
    const p = decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
    return { text: htmlToText(fs.readFileSync(p, "utf8")), via: "file" };
  }
  const r = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
    redirect: "follow",
    signal: AbortSignal.timeout(45000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  const body = await r.text();
  return { text: /html|xml/i.test(ct) ? htmlToText(body) : body.trim(), via: "direct" };
}

// Through the shell: open an agent tab in The Wilds (the "agent" jar has no
// logins, so this can never see a logged-in view), read the distilled markdown,
// close the tab. Falls through to a direct fetch on any failure.
async function fetchViaWilds(url) {
  const opened = await shellPost("/wilds/open", { url, persona: "agent", foreground: false });
  if (opened.error || !opened.tab) return null;
  try {
    const read = await shellPost("/wilds/read", { tab: opened.tab, mode: "distill", max: 120000 });
    if (read.error || typeof read.text !== "string") return null;
    const lines = read.text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
    return { text: lines.join("\n"), via: "wilds", title: read.title };
  } finally {
    shellPost("/wilds/close", { tab: opened.tab }).catch(() => {});
  }
}

async function fetchDistilled(url) {
  if (!/^(https?|file):/i.test(url)) throw new Error("only http(s) and file: URLs are read");
  if (/^https?:/i.test(url)) {
    const w = await fetchViaWilds(url).catch(() => null);
    if (w) return w;
  }
  return fetchDirect(url);
}

// -------------------------------------------------------------------- diff

// Line-level LCS diff. Pages are a few thousand lines at most, so an O(n*m)
// table is fine; the table is capped so a pathological page cannot eat memory
// (beyond the cap we fall back to a set-difference, which loses order only).
function diffLines(oldText, newText) {
  const a = oldText ? oldText.split("\n") : [];
  const b = newText ? newText.split("\n") : [];
  if (a.length * b.length > 4_000_000) {
    const sa = new Set(a), sb = new Set(b);
    return { added: b.filter((l) => !sa.has(l)), removed: a.filter((l) => !sb.has(l)) };
  }
  const n = a.length, m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  const added = [], removed = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  while (i < n) removed.push(a[i++]);
  while (j < m) added.push(b[j++]);
  return { added, removed };
}

// ------------------------------------------------------------------- score

const DEADLINE_WORDS = /\b(effective|expires?|expiration|deadline|required?|must|final rule|compliance date|due|no later than|revised|updated|new requirement|enforcement|penalt(y|ies)|exclu(ded|sion)|revoked|suspended)\b/i;
const DATE_RE = /\b(20\d\d-\d\d-\d\d|\d{1,2}\/\d{1,2}\/20\d\d|(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2},? 20\d\d)\b/i;

function scoreChange(watch, diff, newText) {
  const changed = diff.added.length + diff.removed.length;
  if (!changed) return { score: 0, reasons: [] };
  const total = Math.max(1, newText.split("\n").length);
  const reasons = [];
  // Size: up to 40 points, saturating at ~15% of the page changing.
  const sizePts = Math.min(40, Math.round((changed / total) * 40 / 0.15));
  reasons.push(`${changed} line${changed === 1 ? "" : "s"} changed (${sizePts} pts)`);
  let score = sizePts;
  const addedText = diff.added.join("\n");
  // Tag keywords: each watch tag found among added lines is worth 10.
  const tagHits = (watch.tags || []).filter((t) => t && new RegExp(`\\b${t.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&").replace(/-/g, "[- ]")}\\b`, "i").test(addedText));
  if (tagHits.length) { score += Math.min(30, tagHits.length * 10); reasons.push(`tags: ${tagHits.join(", ")}`); }
  // Deadline language and dates in the new material.
  const dl = addedText.match(new RegExp(DEADLINE_WORDS.source, "gi")) || [];
  if (dl.length) { score += Math.min(20, 5 * new Set(dl.map((w) => w.toLowerCase())).size); reasons.push(`deadline words: ${[...new Set(dl.map((w) => w.toLowerCase()))].slice(0, 5).join(", ")}`); }
  if (DATE_RE.test(addedText)) { score += 10; reasons.push("dates present"); }
  // A watch's own selectorHint is a phrase the user cares about on that page.
  if (watch.selectorHint && addedText.toLowerCase().includes(String(watch.selectorHint).toLowerCase())) {
    score += 15; reasons.push("matches hint");
  }
  return { score: Math.min(100, score), reasons };
}

function summarize(watch, diff, scored) {
  const first = diff.added.find((l) => l.length > 20) || diff.added[0] || diff.removed[0] || "";
  const head = `${diff.added.length} added, ${diff.removed.length} removed on ${watch.name}`;
  return first ? `${head} — "${first.slice(0, 160)}"` : head;
}

// ------------------------------------------------------------------ checks

// Exactly one fetch at a time, across the scheduler and manual checks. Each
// check is queued and awaited; the chain never rejects so one bad URL cannot
// jam the queue.
let chain = Promise.resolve();
function runCheck(watch, { force = false } = {}) {
  const job = chain.then(() => checkOne(watch, force));
  chain = job.catch(() => {});
  return job;
}

async function checkOne(watch, force) {
  const sinceLast = watch.lastChecked ? Date.now() - Date.parse(watch.lastChecked) : Infinity;
  if (!force && sinceLast < MIN_INTERVAL_MS) return { skipped: "too soon" };
  watch.status = "checking";
  let fetched;
  try {
    fetched = await fetchDistilled(watch.url);
  } catch (e) {
    watch.status = "error";
    watch.lastError = String(e.message || e);
    watch.lastChecked = now();
    saveWatches();
    return { error: watch.lastError };
  }
  const prev = latestSnapshot(watch.id);
  const text = fetched.text || "";
  watch.lastChecked = now();
  watch.lastError = null;
  watch.via = fetched.via;
  if (prev === null) {
    // First visit establishes the baseline. No finding: there is nothing to
    // compare against, and a "whole page added" finding would only be noise.
    writeSnapshot(watch.id, text);
    watch.status = "baseline";
    saveWatches();
    return { baseline: true, lines: text.split("\n").length };
  }
  if (prev === text) { watch.status = "steady"; saveWatches(); return { changed: false }; }
  const diff = diffLines(prev, text);
  writeSnapshot(watch.id, text);
  const scored = scoreChange(watch, diff, text);
  const finding = {
    id: id(), watchId: watch.id, watch: watch.name, when: now(), score: scored.score,
    reasons: scored.reasons, summary: summarize(watch, diff, scored),
    added: diff.added.slice(0, 400), removed: diff.removed.slice(0, 400), url: watch.url,
    briefed: false,
  };
  const threshold = Number.isFinite(watch.threshold) ? watch.threshold : DEFAULT_THRESHOLD;
  if (finding.score >= threshold) {
    finding.briefed = await fileBrief({
      title: `${watch.name}: change scored ${finding.score}`,
      body: finding.summary,
      level: finding.score >= 70 ? "urgent" : "normal",
      url: watch.url,
      when: finding.when,
    });
  }
  appendFinding(finding);
  watch.lastChanged = finding.when;
  watch.status = "changed";
  saveWatches();
  return { changed: true, finding };
}

// Scheduler: every two minutes look for due watches; the jitter keeps a dozen
// daily watches from all firing at the same minute each day.
function dueWatches() {
  const t = Date.now();
  return watches.filter((w) => {
    if (w.paused) return false;
    const every = EVERY_MS[w.every] || EVERY_MS.daily;
    if (!w.lastChecked) return true;
    const jitter = (parseInt(w.id.slice(0, 4), 16) % 600) * 1000; // 0–10 min, stable per watch
    return t - Date.parse(w.lastChecked) >= every + jitter;
  });
}
setInterval(() => { for (const w of dueWatches()) runCheck(w); }, 2 * 60 * 1000).unref();
// First pass shortly after boot, so a freshly added preset gets its baseline
// without waiting two minutes.
setTimeout(() => { for (const w of dueWatches()) runCheck(w); }, 5000).unref();

// ----------------------------------------------------------------- reports

function fmtDate(iso) { return iso ? iso.replace("T", " ").slice(0, 16) + "Z" : "never"; }

function reportMarkdown(sinceIso) {
  const since = sinceIso ? Date.parse(sinceIso) : Date.now() - 7 * 24 * 3600 * 1000;
  const rows = findingsFolded().filter((f) => Date.parse(f.when) >= since);
  const out = [`# Lookout report`, ``, `Since ${new Date(since).toISOString().slice(0, 10)} · ${rows.length} finding${rows.length === 1 ? "" : "s"} across ${watches.length} watch${watches.length === 1 ? "" : "es"}`, ``];
  if (!rows.length) out.push(`_No changes recorded in this window._`, ``);
  for (const f of rows) {
    out.push(`## ${f.watch} — score ${f.score}${f.acked ? " (acknowledged)" : ""}`, ``, `${fmtDate(f.when)} · <${f.url}>`, ``, f.summary, ``);
    if (f.reasons && f.reasons.length) out.push(`_Why:_ ${f.reasons.join("; ")}`, ``);
    if (f.added.length) out.push(`**Added**`, ``, ...f.added.slice(0, 25).map((l) => `+ ${l}`), f.added.length > 25 ? `+ … ${f.added.length - 25} more` : "", ``);
    if (f.removed.length) out.push(`**Removed**`, ``, ...f.removed.slice(0, 25).map((l) => `- ${l}`), f.removed.length > 25 ? `- … ${f.removed.length - 25} more` : "", ``);
  }
  return out.filter((l) => l !== undefined).join("\n");
}

function exportMarkdown() {
  const out = [`# Lookout dossier`, ``, `Exported ${now()}`, ``, `## Watches`, ``, `| Name | Kind | Every | Status | Last checked | Last changed | Tags | URL |`, `|---|---|---|---|---|---|---|---|`];
  for (const w of watches) out.push(`| ${w.name} | ${w.kind} | ${w.every} | ${w.status || "new"} | ${fmtDate(w.lastChecked)} | ${fmtDate(w.lastChanged)} | ${(w.tags || []).join(", ")} | <${w.url}> |`);
  out.push(``, `## Findings (last 30 days)`, ``);
  out.push(reportMarkdown(new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()).split("\n").slice(4).join("\n"));
  return out.join("\n");
}

function scorecard() {
  // Changes per watch per ISO week, last 8 weeks. The UI draws the bars.
  const weekOf = (iso) => { const d = new Date(iso); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); };
  const weeks = [];
  for (let i = 7; i >= 0; i--) weeks.push(weekOf(new Date(Date.now() - i * 7 * 24 * 3600 * 1000).toISOString()));
  const rows = watches.map((w) => ({ id: w.id, name: w.name, counts: Object.fromEntries(weeks.map((wk) => [wk, 0])), maxScore: 0 }));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const f of findingsFolded()) {
    const r = byId.get(f.watchId); if (!r) continue;
    const wk = weekOf(f.when); if (wk in r.counts) r.counts[wk]++;
    r.maxScore = Math.max(r.maxScore, f.score);
  }
  return { weeks, rows };
}

// ------------------------------------------------------------------ server

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

function send(res, code, body, type) {
  if (type === undefined) { type = "application/json; charset=utf-8"; body = JSON.stringify(body); }
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error("body must be JSON"), { status: 400 }); }
}

function cleanWatch(input, existing) {
  const w = existing ? { ...existing } : { id: id(), createdAt: now(), status: "new", lastChecked: null, lastChanged: null };
  if (input.name !== undefined) w.name = String(input.name).slice(0, 120).trim();
  if (input.url !== undefined) w.url = String(input.url).trim();
  if (input.kind !== undefined) w.kind = input.kind === "list" ? "list" : "page";
  if (input.every !== undefined) w.every = EVERY_MS[input.every] ? input.every : "daily";
  if (input.tags !== undefined) w.tags = (Array.isArray(input.tags) ? input.tags : String(input.tags).split(",")).map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 12);
  if (input.selectorHint !== undefined) w.selectorHint = input.selectorHint ? String(input.selectorHint).slice(0, 200) : null;
  if (input.threshold !== undefined) w.threshold = Math.max(0, Math.min(100, Number(input.threshold) || DEFAULT_THRESHOLD));
  if (input.paused !== undefined) w.paused = !!input.paused;
  w.kind = w.kind || "page"; w.every = w.every || "daily"; w.tags = w.tags || [];
  if (w.threshold === undefined) w.threshold = DEFAULT_THRESHOLD;
  if (!w.name) throw Object.assign(new Error("name required"), { status: 400 });
  if (!/^(https?|file):\/\//i.test(w.url || "")) throw Object.assign(new Error("url must be http(s):// or file://"), { status: 400 });
  return w;
}

async function api(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
  const m = req.method;
  const seg = parts[1], arg = parts[2], verb = parts[3];

  if (seg === "status" && m === "GET") {
    const port = await syncPort();
    return send(res, 200, { ok: true, port: PORT, shell: port ? { port, token: !!syncToken() } : null, watches: watches.length, pending: findingsFolded().filter((f) => !f.acked).length });
  }

  if (seg === "watches") {
    if (m === "GET" && !arg) return send(res, 200, watches);
    if (m === "POST" && !arg) {
      const body = await readJsonBody(req);
      const w = cleanWatch(body);
      watches.push(w); saveWatches();
      return send(res, 201, w);
    }
    const w = watches.find((x) => x.id === arg);
    if (!w) return send(res, 404, { error: "no such watch" });
    if (m === "GET") return send(res, 200, { ...w, snapshot: latestSnapshot(w.id) });
    if (m === "PATCH" || m === "PUT") {
      const body = await readJsonBody(req);
      Object.assign(w, cleanWatch(body, w)); saveWatches();
      return send(res, 200, w);
    }
    if (m === "DELETE") {
      watches = watches.filter((x) => x.id !== arg); saveWatches();
      // Snapshots stay on disk: evidence of what the page said is cheap to
      // keep and painful to want later.
      return send(res, 200, { ok: true });
    }
  }

  if (seg === "check" && m === "POST" && arg) {
    const w = watches.find((x) => x.id === arg);
    if (!w) return send(res, 404, { error: "no such watch" });
    const r = await runCheck(w, { force: true });
    return send(res, r.error ? 502 : 200, { watch: w, result: r });
  }

  if (seg === "findings") {
    if (m === "GET") {
      const since = url.searchParams.get("since");
      let rows = findingsFolded();
      if (since) rows = rows.filter((f) => f.when >= since);
      if (url.searchParams.get("watch")) rows = rows.filter((f) => f.watchId === url.searchParams.get("watch"));
      return send(res, 200, rows);
    }
    if (m === "POST" && verb === "ack") {
      appendFinding({ id: arg, ack: true, when: now() });
      return send(res, 200, { ok: true });
    }
  }

  if (seg === "report" && m === "GET") return send(res, 200, reportMarkdown(url.searchParams.get("since")), "text/markdown; charset=utf-8");
  if (seg === "export" && m === "GET") return send(res, 200, exportMarkdown(), "text/markdown; charset=utf-8");
  if (seg === "scorecard" && m === "GET") return send(res, 200, scorecard());

  if (seg === "research" && m === "POST") {
    // A dossier, not an answer: the question rides along so whoever reads it
    // (the person, or Kenoma if they paste it there) knows what to look for.
    // No model is called here and the pages are read through the same
    // read-only path as watches. Research is a one-off, so the per-source
    // hourly rule applies as a courtesy cap of 8 URLs per request instead.
    const body = await readJsonBody(req);
    const question = String(body.question || "").slice(0, 2000);
    const urls = (Array.isArray(body.urls) ? body.urls : String(body.urls || "").split(/\s+/)).map((u) => String(u).trim()).filter(Boolean).slice(0, 8);
    const sources = [];
    for (const u of urls) {
      try {
        const f = await (chain = chain.then(() => fetchDistilled(u)).catch((e) => ({ error: String(e.message || e) })));
        sources.push(f.error ? { url: u, error: f.error } : { url: u, via: f.via, title: f.title || null, chars: f.text.length, text: f.text.slice(0, 60000) });
      } catch (e) { sources.push({ url: u, error: String(e.message || e) }); }
    }
    const md = [`# Research dossier`, ``, `**Question:** ${question || "(none given)"}`, ``, `Prepared ${now()} · ${sources.length} source${sources.length === 1 ? "" : "s"} · read-only, no model involved`, ``];
    for (const s of sources) {
      md.push(`## ${s.title || s.url}`, ``, `<${s.url}>`, ``);
      md.push(s.error ? `_Could not read: ${s.error}_` : s.text, ``);
    }
    return send(res, 200, { question, when: now(), sources, markdown: md.join("\n") });
  }

  return send(res, 404, { error: "no such route" });
}

// The shared UI kit (apps/_shared) is served under /_ifreglen/, so the page
// looks like the rest of Ifreglen without a copy of the stylesheet here.
const SHARED = path.join(HERE, "..", "_shared");
function serveStatic(req, res, url) {
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  const shared = p.startsWith("/_ifreglen/");
  if (shared) p = p.slice("/_ifreglen".length);
  p = path.normalize(p).replace(/^(\.\.[/\\])+/, "");
  const base = shared ? SHARED : HERE;
  const file = path.join(base, p);
  if (!file.startsWith(base) || file.startsWith(DATA)) return send(res, 404, { error: "not found" });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: "not found" });
    send(res, 200, buf, MIME[path.extname(file)] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) await api(req, res, url);
    else if (req.method === "GET") serveStatic(req, res, url);
    else send(res, 405, { error: "method not allowed" });
  } catch (e) {
    send(res, e.status || 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // The shell sniffs this line for the port; keep it first and exact.
  console.log(`http://127.0.0.1:${PORT}`);
  console.log(`lookout · ${watches.length} watch(es) · data in ${DATA}`);
});
