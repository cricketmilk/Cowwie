// Unit tests for lib/absorb.js — no Electron required.
// Run: cd shell && node lib/absorb-test.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

const { absorb, nativeCaps, validateId } = require("./absorb");

let passed = 0;
let failed = 0;

function ok(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ifreglen-absorb-test-"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function mkdir(p) {
  fs.mkdirSync(p, { recursive: true });
}

(function detectStatic() {
  const root = tmpDir();
  const appDir = path.join(root, "webby");
  mkdir(appDir);
  fs.writeFileSync(path.join(appDir, "index.html"), "<h1>hi</h1>", "utf8");
  const r = absorb(appDir, { existingIds: new Set() });
  ok("static kind detected", r.entry.kind === "static");
  ok("static id from folder", r.entry.id === "webby");
  ok("static name title-cased", r.entry.name === "Webby");
  ok("static path resolves", path.resolve(__dirname, "..", r.entry.path) === path.join(appDir, "index.html"));
  ok("static root resolves", path.resolve(__dirname, "..", r.entry.root) === appDir);
  ok("static gets fs cap", r.entry.capabilities.includes("fs"));
  ok("static manifest written", r.manifestWritten === true && fs.existsSync(r.manifestPath));
  ok("static note written", r.noteWritten === true && fs.existsSync(r.notePath));
})();

(function detectNode() {
  const root = tmpDir();
  const appDir = path.join(root, "app-node");
  mkdir(appDir);
  writeJson(path.join(appDir, "package.json"), { name: "app-node", scripts: { dev: "vite" } });
  const r = absorb(appDir, { existingIds: new Set() });
  ok("node kind detected", r.entry.kind === "local");
  ok("node command set", r.entry.command === "npm run dev");
  ok("node cwd and root resolve", path.resolve(__dirname, "..", r.entry.cwd) === appDir && r.entry.cwd === r.entry.root);
  ok("node detected tag", /node/.test(r.entry.detected));
  const manifest = JSON.parse(fs.readFileSync(r.manifestPath, "utf8"));
  ok("node manifest cwd is project root", manifest.apps[0].cwd === "." && manifest.apps[0].command === "npm run dev");
})();

(function detectMkDocs() {
  const root = tmpDir();
  const appDir = path.join(root, "docs-site");
  mkdir(appDir);
  fs.writeFileSync(path.join(appDir, "mkdocs.yml"), "site_name: Docs\n", "utf8");
  const r = absorb(appDir, { existingIds: new Set() });
  ok("mkdocs kind detected", r.entry.kind === "local");
  ok("mkdocs command set", r.entry.command === "mkdocs serve");
  ok("mkdocs detected tag", /mkdocs/.test(r.entry.detected));
})();

(function detectPythonFlask() {
  const root = tmpDir();
  const appDir = path.join(root, "pyapp");
  mkdir(appDir);
  fs.writeFileSync(path.join(appDir, "app.py"), "from flask import Flask\n", "utf8");
  const r = absorb(appDir, { existingIds: new Set() });
  ok("python kind detected", r.entry.kind === "local");
  ok("flask command set", r.entry.command === "python app.py");
  ok("flask detected tag", /flask/.test(r.entry.detected));
})();

(function rejectInsidePlatform() {
  let err = null;
  try {
    absorb(__dirname, { existingIds: new Set(), dryRun: true });
  } catch (e) {
    err = e;
  }
  ok("platform folder rejected", err && /platform tree/.test(err.message));
})();

(function dryRunNoWrites() {
  const root = tmpDir();
  const appDir = path.join(root, "dry");
  mkdir(appDir);
  fs.writeFileSync(path.join(appDir, "index.html"), "", "utf8");
  const r = absorb(appDir, { existingIds: new Set(), dryRun: true });
  ok("dry run returns entry", r.entry.id === "dry");
  ok("dry run skips manifest", r.manifestWritten === false && !fs.existsSync(path.join(appDir, "ifreglen-apps.json")));
  ok("dry run skips note", r.noteWritten === false && !fs.existsSync(path.join(appDir, "ROOST.md")));
})();

(function idCollision() {
  const root = tmpDir();
  const appDir = path.join(root, "demo");
  mkdir(appDir);
  fs.writeFileSync(path.join(appDir, "index.html"), "", "utf8");
  const r1 = absorb(appDir, { existingIds: new Set(["demo"]) });
  ok("first collision suffix", r1.entry.id === "demo-2");
  const r2 = absorb(appDir, { existingIds: new Set(["demo", "demo-2"]) });
  ok("second collision suffix", r2.entry.id === "demo-3");
})();

(function invalidPreferredId() {
  const root = tmpDir();
  const appDir = path.join(root, "my-project");
  mkdir(appDir);
  fs.writeFileSync(path.join(appDir, "index.html"), "", "utf8");
  const r = absorb(appDir, { existingIds: new Set(), id: "Bad ID" });
  ok("invalid id falls back to folder", r.entry.id === "my-project");
})();

(function longFolderNameTruncated() {
  const root = tmpDir();
  const longName = "a".repeat(80);
  const appDir = path.join(root, longName);
  mkdir(appDir);
  fs.writeFileSync(path.join(appDir, "index.html"), "", "utf8");
  const r = absorb(appDir, { existingIds: new Set() });
  ok("long name id passes validateId", validateId(r.entry.id));
  ok("long name id fits 64 chars", r.entry.id.length <= 64);
})();

(function longNameCollisionTruncated() {
  const root = tmpDir();
  const longName = "b".repeat(80);
  const appDir = path.join(root, longName);
  mkdir(appDir);
  fs.writeFileSync(path.join(appDir, "index.html"), "", "utf8");
  const r = absorb(appDir, { existingIds: new Set(["b".repeat(64)]) });
  ok("collision with long base passes validateId", validateId(r.entry.id));
  ok("collision suffix appended", /-2$/.test(r.entry.id));
  ok("collision id fits 64 chars", r.entry.id.length <= 64);
})();

(function customCapsAndPersona() {
  const root = tmpDir();
  const appDir = path.join(root, "custom");
  mkdir(appDir);
  fs.writeFileSync(path.join(appDir, "index.html"), "", "utf8");
  const caps = ["store", "shell"];
  const r = absorb(appDir, { existingIds: new Set(), capabilities: caps, persona: "demo" });
  ok("custom capabilities used", JSON.stringify(r.entry.capabilities) === JSON.stringify(caps));
  ok("custom persona used", r.entry.persona === "demo");
  const manifest = JSON.parse(fs.readFileSync(r.manifestPath, "utf8"));
  ok("manifest mirrors custom caps", JSON.stringify(manifest.apps[0].capabilities) === JSON.stringify(caps));
})();

(function existingManifestPreserved() {
  const root = tmpDir();
  const appDir = path.join(root, "kept");
  mkdir(appDir);
  fs.writeFileSync(path.join(appDir, "index.html"), "", "utf8");
  const oldManifest = { apps: [{ id: "kept", name: "Kept", kind: "static", path: "index.html" }] };
  writeJson(path.join(appDir, "ifreglen-apps.json"), oldManifest);
  fs.writeFileSync(path.join(appDir, "ROOST.md"), "old note", "utf8");
  const r = absorb(appDir, { existingIds: new Set() });
  ok("existing manifest not overwritten", r.manifestWritten === false);
  ok("existing note not overwritten", r.noteWritten === false);
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, "ifreglen-apps.json"), "utf8"));
  ok("manifest content preserved", manifest.apps[0].name === "Kept");
  ok("note content preserved", fs.readFileSync(path.join(appDir, "ROOST.md"), "utf8") === "old note");
})();

(function noteListsCapabilities() {
  const root = tmpDir();
  const appDir = path.join(root, "noted");
  mkdir(appDir);
  fs.writeFileSync(path.join(appDir, "index.html"), "", "utf8");
  const r = absorb(appDir, { existingIds: new Set(), capabilities: ["store", "bus"] });
  const note = fs.readFileSync(r.notePath, "utf8");
  ok("note mentions id", note.includes(r.entry.id));
  ok("note lists store cap", note.includes("store"));
  ok("note lists bus cap", note.includes("bus"));
})();

(function validateIdCases() {
  ok("valid id", validateId("abc-123"));
  ok("uppercase rejected", !validateId("ABC"));
  ok("empty rejected", !validateId(""));
  ok("too long rejected", !validateId("a".repeat(65)));
  ok("spaces rejected", !validateId("bad id"));
  ok("underscore rejected", !validateId("bad_id"));
})();

(function nativeCapsCases() {
  const local = nativeCaps("local");
  const stat = nativeCaps("static");
  const ext = nativeCaps("external");
  ok("local has store bus shell fs", local.includes("store") && local.includes("bus") && local.includes("shell") && local.includes("fs"));
  ok("static has fs", stat.includes("fs"));
  ok("external lacks fs", !ext.includes("fs"));
})();

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
