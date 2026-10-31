// The rail (renderer/chrome.html), part 10 of 11: adding projects: discovery, absorb and manifests.
// Plain script, one global scope with the other parts, loaded in the order
// chrome.html lists them. See the note there before moving code between parts.

// ------------------------------------------------------------- discovery
let found = [];

async function openSheet() {
  hideSurfaces();
  await roostChrome.overlay(true);
  document.body.classList.add("overlay");
  $("sheet").hidden = false;
}

async function closeSheet() {
  $("sheet").hidden = true;
  await syncOverlay();
}

$("add").onclick = openSheet;
$("sheetClose").onclick = closeSheet;
$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("pal").hidden) closePalette();
    else if (!$("findbar").hidden) closeFind();
    else if (!$("clip").hidden) closeClip();
    else if (!$("perf").hidden) closePerf();
    else if (!$("logsheet").hidden) closeLogs();
    else if (!$("manif").hidden) closeManif();
    else if (!$("absorb").hidden) closeAbsorb();
    else if (!$("sheet").hidden) closeSheet();
    else if (!$("forge").hidden) closeForge();
    else if (!$("wire").hidden) closeWire();
    else if (!$("nodeSheet").hidden) closeNodeSheet();
  }
  // Ctrl+K / Ctrl+F / Ctrl+D also work while the rail itself has focus.
  if (e.key.toLowerCase() === "k" && e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    openPalette();
  }
  if (e.key.toLowerCase() === "f" && e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    openFind();
  }
  if (e.key.toLowerCase() === "d" && e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    openClip();
  }
});

$("browse").onclick = async () => {
  const picked = await roostChrome.pickFolder();
  if (picked.canceled) return;
  $("sheetDir").textContent = picked.dir;
  $("found").innerHTML = '<p class="dim pad">Scanning…</p>';
  const r = await roostChrome.scan(picked.dir);
  if (r.error) { $("found").innerHTML = `<p class="pad" style="color:var(--signal)">${esc(r.error)}</p>`; return; }
  found = r.found;
  renderFound();
};

function renderFound() {
  if (!found.length) {
    $("found").innerHTML = '<p class="dim pad">No projects detected. The scanner looks for package.json, manage.py, app.py, or index.html one or two levels down.</p>';
    return;
  }
  $("found").innerHTML = found.map((f, i) => `
    <label class="proj ${f.alreadyAdded ? "dup" : ""}">
      <input type="checkbox" data-i="${i}" ${f.alreadyAdded ? "disabled" : "checked"}>
      <span class="pname">${esc(f.name)}</span>
      <span class="pkind">${f.alreadyAdded ? "added" : esc(f.kind)}</span>
      <span class="pcmd">${esc(f.detected)}${f.command ? " · " + esc(f.command) : ""}</span>
    </label>`).join("");
  for (const cb of document.querySelectorAll(".proj input")) cb.onchange = updateAddBtn;
  updateAddBtn();
}

function selected() {
  return [...document.querySelectorAll(".proj input:checked:not(:disabled)")]
    .map((cb) => found[Number(cb.dataset.i)]);
}
function updateAddBtn() {
  const n = selected().length;
  $("addSel").disabled = n === 0;
  $("addSel").textContent = n ? `Add ${n}` : "Add selected";
}

$("addSel").onclick = async () => {
  const r = await roostChrome.addApps(selected());
  await closeSheet();
  await refreshApps();
  $("msg").className = "msg";
  $("msg").textContent = `added ${r.added.length} project${r.added.length === 1 ? "" : "s"}`;
};

$("importManifest").onclick = openManif;
$("absorbBtn").onclick = openAbsorb;

// --------------------------------------------------------------- absorb
let absorbDir = null;
let absorbInfo = null;
const CAPS = ["store", "bus", "shell", "fs"];

async function openAbsorb() {
  hideSurfaces();
  await roostChrome.overlay(true);
  document.body.classList.add("overlay");
  $("absorb").hidden = false;
  absorbDir = null;
  absorbInfo = null;
  $("absorbDir").textContent = "no folder chosen";
  $("absorbId").value = "";
  $("absorbName").value = "";
  $("absorbBody").querySelector("p").innerHTML = 'Pick a single project folder outside <code>ifreglen/</code>. It stays where it is; the shell only records a registry entry and writes a <code>ifreglen-apps.json</code> manifest inside it.';
  renderAbsorbCaps([]);
  $("absorbRun").disabled = true;
}

async function closeAbsorb() {
  $("absorb").hidden = true;
  await syncOverlay();
}

$("absorbClose").onclick = closeAbsorb;
$("absorb").addEventListener("click", (e) => { if (e.target === $("absorb")) closeAbsorb(); });

function renderAbsorbCaps(selectedCaps) {
  $("absorbCaps").innerHTML = '<label>capabilities</label><div class="absorb-caps">' +
    CAPS.map((c) => `<label><input type="checkbox" value="${c}" ${selectedCaps.includes(c) ? "checked" : ""}> ${c}</label>`).join("") +
    "</div>";
}

function selectedAbsorbCaps() {
  return [...$("absorbCaps").querySelectorAll("input:checked")].map((cb) => cb.value);
}

$("absorbBrowse").onclick = async () => {
  const picked = await roostChrome.pickFolder();
  if (picked.canceled) return;
  absorbDir = picked.dir;
  $("absorbDir").textContent = absorbDir;
  $("absorbBody").querySelector("p").textContent = "Detecting…";
  try {
    const r = await roostChrome.absorb(absorbDir, { dryRun: true });
    if (r.error) {
      $("absorbBody").querySelector("p").innerHTML = `<span style="color:var(--signal)">${esc(r.error)}</span>`;
      absorbInfo = null;
      $("absorbRun").disabled = true;
      return;
    }
    absorbInfo = r.added;
    $("absorbId").value = r.added.id;
    $("absorbName").value = r.added.name;
    renderAbsorbCaps(r.added.capabilities);
    $("absorbBody").querySelector("p").innerHTML = `Detected <b>${esc(r.added.kind)}</b> · ${esc(r.info.detected)}${r.info.command ? " · " + esc(r.info.command) : ""}`;
    $("absorbRun").disabled = false;
  } catch (err) {
    $("absorbBody").querySelector("p").innerHTML = `<span style="color:var(--signal)">${esc(err.message || err)}</span>`;
    absorbInfo = null;
    $("absorbRun").disabled = true;
  }
};

$("absorbRun").onclick = async () => {
  if (!absorbDir) return;
  const options = {
    id: $("absorbId").value.trim() || undefined,
    name: $("absorbName").value.trim() || undefined,
    capabilities: selectedAbsorbCaps(),
  };
  const r = await roostChrome.absorb(absorbDir, options);
  if (r.error) {
    $("absorbBody").querySelector("p").innerHTML = `<span style="color:var(--signal)">${esc(r.error)}</span>`;
    return;
  }
  await closeAbsorb();
  await refreshApps();
  $("msg").className = "msg";
  $("msg").textContent = `absorbed ${r.added.name}`;
};

// --------------------------------------------------------------- manifest
let manifFile = null;
let manifResults = null;

async function openManif() {
  hideSurfaces();
  await roostChrome.overlay(true);
  document.body.classList.add("overlay");
  $("manif").hidden = false;
  manifFile = null;
  manifResults = null;
  $("manifFile").textContent = "no file chosen";
  $("manifBody").innerHTML = '<p class="dim pad">Choose a <code>ifreglen-apps.json</code> file. Paths inside it are relative to the file itself.</p>';
  $("manifRun").disabled = true;
  $("manifReplace").checked = false;
}

async function closeManif() {
  $("manif").hidden = true;
  await syncOverlay();
}

$("manifClose").onclick = closeManif;
$("manif").addEventListener("click", (e) => { if (e.target === $("manif")) closeManif(); });

$("manifPick").onclick = async () => {
  const r = await roostChrome.pickManifest();
  if (r.canceled) return;
  manifFile = r.file;
  $("manifFile").textContent = manifFile;
  $("manifBody").innerHTML = '<p class="dim pad">Previewing…</p>';
  $("manifRun").disabled = true;
  try {
    const res = await roostChrome.importManifest(manifFile, false);
    if (res.error) {
      $("manifBody").innerHTML = `<p class="pad" style="color:var(--signal)">${esc(res.error)}</p>`;
      return;
    }
    manifResults = res;
    renderManif(res, false);
  } catch (err) {
    $("manifBody").innerHTML = `<p class="pad" style="color:var(--signal)">${esc(err.message || err)}</p>`;
  }
};

function renderManif(res, confirmed) {
  const rows = [];
  for (const a of res.added || []) {
    rows.push(`<div class="proj"><span class="pname">${esc(a.name)}</span><span class="pkind">${esc(a.kind)}</span><span class="pcmd">${esc(a.id)}</span></div>`);
  }
  for (const s of res.skipped || []) {
    rows.push(`<div class="proj dup"><span class="pname">${esc(s.id)}</span><span class="pkind">skipped</span><span class="pcmd">${esc(s.reason)}</span></div>`);
  }
  for (const sc of res.scaffolded || []) {
    rows.push(`<div class="proj dup"><span class="pname">${esc(sc.id)}</span><span class="pkind">scaffold</span><span class="pcmd">${esc(sc.file || sc.folder || "folder")}</span></div>`);
  }
  for (const e of res.errors || []) {
    rows.push(`<div class="proj dup"><span class="pname">${esc(e.id)}</span><span class="pkind">error</span><span class="pcmd">${esc(e.error)}</span></div>`);
  }
  const summary = confirmed
    ? `Imported ${(res.added || []).length} app${(res.added || []).length === 1 ? "" : "s"}.`
    : `${(res.added || []).length} to add · ${(res.skipped || []).length} skipped · ${(res.scaffolded || []).length} scaffolded · ${(res.errors || []).length} errors.`;
  $("manifBody").innerHTML = `<p class="dim pad">${esc(summary)}</p>` + (rows.length ? rows.join("") : "");
  $("manifRun").disabled = (res.added || []).length === 0 || confirmed;
}

$("manifRun").onclick = async () => {
  if (!manifFile || !manifResults) return;
  const replace = $("manifReplace").checked;
  const res = await roostChrome.importManifest(manifFile, replace);
  if (res.error) {
    $("manifBody").innerHTML = `<p class="pad" style="color:var(--signal)">${esc(res.error)}</p>`;
    return;
  }
  renderManif(res, true);
  await refreshApps();
  $("msg").className = "msg";
  $("msg").textContent = `imported ${(res.added || []).length} app${(res.added || []).length === 1 ? "" : "s"}`;
};

$("home").onclick = () => {
  const home = apps.find((a) => a.id === "launcher") || apps[0];
  if (home) roostChrome.activate(home.id);
};
$("palHint").onclick = openPalette;
