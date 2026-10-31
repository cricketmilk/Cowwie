// Unit tests for lib/roots.js — no Electron required.
// Run: cd shell && node lib/roots-test.js
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let pass = 0, fail = 0;
function ok(label, cond, got) {
  if (cond) { pass++; console.log("  ok  ", label); }
  else { fail++; console.log("  FAIL", label, got === undefined ? "" : `-> ${JSON.stringify(got)}`); }
}

const roots = require("./roots");
const REAL = roots.ROOTS_FILE;
const BACKUP = REAL + ".test-backup";
const had = fs.existsSync(REAL);
if (had) fs.renameSync(REAL, BACKUP);

function withRoots(obj, fn) {
  if (obj === null) { try { fs.rmSync(REAL, { force: true }); } catch {} }
  else fs.writeFileSync(REAL, JSON.stringify(obj, null, 2));
  roots._reset();
  try { fn(); } finally { try { fs.rmSync(REAL, { force: true }); } catch {} roots._reset(); }
}

try {
  // A path with no placeholder is the same string back. This is the whole
  // backward-compatibility story: the registry's absolute entries are untouched.
  const lit = "C:\Ment Jelly";
  ok("a literal path is returned identically", roots.resolveRoots(lit) === lit, roots.resolveRoots(lit));
  ok("null and undefined pass through", roots.resolveRoots(null) === null && roots.resolveRoots(undefined) === undefined);

  withRoots(null, () => {
    const d = roots.roots();
    ok("ROOST has a default with no file", typeof d.ROOST === "string" && d.ROOST.length > 0, d.ROOST);
    ok("SHELL points at the shell folder", d.SHELL === path.resolve(__dirname, ".."), d.SHELL);
    ok("HOME is the home directory", d.HOME === os.homedir());
    if (process.platform === "win32") ok("ROOST defaults to C: on Windows", d.ROOST === "C:", d.ROOST);
    else ok("ROOST defaults under home elsewhere", d.ROOST.startsWith(os.homedir()), d.ROOST);
  });

  withRoots({ ROOST: "D:/dev" }, () => {
    ok("${ROOST} comes from roots.json", roots.resolveRoots("${ROOST}/Glamoire") === "D:/dev/Glamoire", roots.resolveRoots("${ROOST}/Glamoire"));
    ok("a resolved path is what path.resolve wants",
       path.resolve(roots.resolveRoots("${ROOST}/Glamoire")) === path.resolve("D:/dev/Glamoire"));
  });

  withRoots({ $comment: "prose, not a root", ROOST: "D:/dev" }, () => {
    ok("$-prefixed keys are prose, not roots", roots.roots().$comment === undefined);
  });

  withRoots({ ROOST: "D:/dev" }, () => {
    process.env.XIXOXIS_ROOST = "E:/elsewhere";
    roots._reset();
    ok("the environment beats the file", roots.resolveRoots("${ROOST}/x") === "E:/elsewhere/x", roots.resolveRoots("${ROOST}/x"));
    delete process.env.XIXOXIS_ROOST;
    roots._reset();
  });

  withRoots({ ROOST: "D:/dev" }, () => {
    // Unknown names stay literal rather than collapsing to "" and pointing the
    // shell at its own folder — the same rule resolveSecrets uses, for the same
    // reason: a missing thing must look missing.
    const warned = [];
    const real = console.warn; console.warn = (m) => warned.push(String(m));
    const out = roots.resolveRoots("${NOPE}/x");
    console.warn = real;
    ok("an unknown root stays literal", out === "${NOPE}/x", out);
    ok("and says so once", warned.length === 1 && /NOPE/.test(warned[0]), warned);
  });

  withRoots({ ROOST: "D:/dev" }, () => {
    ok("several placeholders in one string", roots.resolveRoots("${ROOST}/a/${ROOST}/b") === "D:/dev/a/D:/dev/b");
  });

  // A malformed file must not take the shell down with it; the defaults stand.
  fs.writeFileSync(REAL, "{ this is not json");
  roots._reset();
  ok("a broken roots.json falls back to the defaults", roots.roots().ROOST === roots.DEFAULT_ROOTS.ROOST);
  fs.rmSync(REAL, { force: true });
  roots._reset();
} finally {
  try { fs.rmSync(REAL, { force: true }); } catch {}
  if (had) fs.renameSync(BACKUP, REAL);
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
