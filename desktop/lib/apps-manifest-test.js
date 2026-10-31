// Unit tests for apps-manifest.js — no Electron required.
// Run: cd shell && node lib/apps-manifest-test.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

const { importManifest, _internals } = require("./apps-manifest");
const { resolveEntry, toRegistryEntry, isInsidePlatform } = _internals;

let passed = 0;
let failed = 0;

function ok(name, cond) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ifreglen-manifest-test-"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

(function detectStatic() {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, "webby"));
  fs.writeFileSync(path.join(root, "webby", "index.html"), "<h1>hi</h1>", "utf8");
  writeJson(path.join(root, "ifreglen-apps.json"), {
    apps: [{ id: "webby", name: "Webby", kind: "static", path: "webby/index.html" }],
  });
  const r = importManifest(path.join(root, "ifreglen-apps.json"), { existingIds: new Set() });
  ok("static entry imported", r.added.length === 1 && r.added[0].id === "webby");
  const resolved = path.resolve(__dirname, "..", r.added[0].path);
  ok("static path resolves to index.html", resolved === path.join(root, "webby", "index.html"));
})();

(function detectNode() {
  const root = tmpDir();
  const appDir = path.join(root, "app-node");
  fs.mkdirSync(appDir);
  writeJson(path.join(appDir, "package.json"), { name: "app-node", scripts: { dev: "vite" } });
  writeJson(path.join(root, "ifreglen-apps.json"), {
    apps: [{ id: "app-node", cwd: "app-node", autoDetect: true }],
  });
  const r = importManifest(path.join(root, "ifreglen-apps.json"), { existingIds: new Set() });
  ok("node entry auto-detected", r.added.length === 1 && r.added[0].kind === "local");
  ok("node command set", r.added[0].command === "npm run dev");
})();

(function detectPython() {
  const root = tmpDir();
  const appDir = path.join(root, "pyapp");
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, "app.py"), "from flask import Flask\n", "utf8");
  writeJson(path.join(root, "ifreglen-apps.json"), {
    apps: [{ id: "pyapp", root: "pyapp", autoDetect: true }],
  });
  const r = importManifest(path.join(root, "ifreglen-apps.json"), { existingIds: new Set() });
  ok("python flask detected", r.added.length === 1 && r.added[0].kind === "local" && r.added[0].command === "python app.py");
})();

(function skipExisting() {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, "old"));
  fs.writeFileSync(path.join(root, "old", "index.html"), "", "utf8");
  writeJson(path.join(root, "ifreglen-apps.json"), {
    apps: [{ id: "old", kind: "static", path: "old/index.html" }],
  });
  const r = importManifest(path.join(root, "ifreglen-apps.json"), { existingIds: new Set(["old"]) });
  ok("existing id skipped", r.added.length === 0 && r.skipped.length === 1);
})();

(function scaffoldStatic() {
  const root = tmpDir();
  const appDir = path.join(root, "fresh");
  writeJson(path.join(root, "ifreglen-apps.json"), {
    apps: [{ id: "fresh", kind: "static", path: "fresh/index.html" }],
  });
  const r = importManifest(path.join(root, "ifreglen-apps.json"), { existingIds: new Set() });
  ok("static scaffolded", r.scaffolded.length === 1 && fs.existsSync(path.join(appDir, "index.html")));
})();

(function rejectPlatformPath() {
  const root = tmpDir();
  writeJson(path.join(root, "ifreglen-apps.json"), {
    apps: [{ id: "bad", kind: "static", path: __dirname + "/foo" }],
  });
  const r = importManifest(path.join(root, "ifreglen-apps.json"), { existingIds: new Set() });
  ok("platform path rejected", r.errors.length === 1 && /platform tree/.test(r.errors[0].error));
})();

(function invalidId() {
  const root = tmpDir();
  writeJson(path.join(root, "ifreglen-apps.json"), {
    apps: [{ id: "Bad ID", kind: "external", url: "https://example.com" }],
  });
  const r = importManifest(path.join(root, "ifreglen-apps.json"), { existingIds: new Set() });
  ok("invalid id rejected", r.errors.length === 1);
})();

(function resolveExternal() {
  const root = tmpDir();
  writeJson(path.join(root, "ifreglen-apps.json"), {
    apps: [{ id: "site", name: "Site", kind: "external", url: "https://example.com", capabilities: ["shell"] }],
  });
  const r = importManifest(path.join(root, "ifreglen-apps.json"), { existingIds: new Set() });
  ok("external entry imported", r.added.length === 1 && r.added[0].kind === "external");
  ok("external url preserved", r.added[0].url === "https://example.com");
  ok("external no root", !("root" in r.added[0]));
})();

(function isInsidePlatformSelf() {
  ok("shell folder is inside platform", isInsidePlatform(__dirname));
  ok("parent outside tmp is outside platform", !isInsidePlatform(os.tmpdir()));
})();

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
