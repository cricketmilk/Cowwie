// The rail (renderer/chrome.html), part 1 of 11: shared state, the rail itself, and the shell's events.
// Plain script, one global scope with the other parts, loaded in the order
// chrome.html lists them. See the note there before moving code between parts.

const $ = (id) => document.getElementById(id);
let apps = [], activeId = null;
let navState = { canBack: false, canForward: false, zoom: 1 };
let activeMb = null;   // renderer MB of the active app, from the passive poll
let totalMb = null;    // whole-shell working set
let openMb = new Map();// appId -> MB for the rail's per-item readouts

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// --------------------------------------------------------------- the rail
function fmtMb(mb) {
  if (mb == null) return "";
  return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : mb + " MB";
}

function itemHtml(a, i, grouped) {
  const state = [
    grouped ? "grp" : "",
    a.id === activeId ? "active" : "",
    a.running ? "running" : a.open ? "open" : "",
    a.open ? "open" : "",
  ].join(" ");
  const restable = a.open && a.id !== activeId && a.id !== "launcher";
  const acc = window.roostSigils ? roostSigils.accent(a.id, a.group) : "";
  const sig = window.roostSigils
    ? roostSigils.sigil(a.id, { name: a.name, group: a.group, size: 21 })
    : esc(a.name.slice(0, 2).toUpperCase());
  return `
    <div class="item ${state}" data-id="${esc(a.id)}" ${acc ? `style="--acc:${acc}"` : ""}
         title="${esc(a.name)} — ${esc(a.persona)}${i < 9 ? ` (Ctrl+${i + 1})` : ""} — middle-click hibernates">
      <span class="glyph">${sig}<i></i></span>
      <span class="meta">
        <span class="iname">${esc(a.name)}</span>
        <span class="ipersona">${esc(a.persona)}</span>
      </span>
      <span class="imb" data-mb="${esc(a.id)}"></span>
      ${restable ? `<button class="rest" data-rest="${esc(a.id)}" title="Hibernate — frees its memory, keeps its logins">✕</button>` : ""}
    </div>`;
}

// Sections: home first, then locals as Instruments, statics as Pages,
// ungrouped externals as Sites, then each named group as its own section.
const KIND_LABEL = { local: "Instruments", static: "Pages", external: "Sites" };
let lastNavHtml = "";

// The codebases the Forge can write to. Fetched once, lazily: the Brain may
// not be running, and the palette must open either way.
let forgeApps = [];
(async () => {
  try {
    const r = await roostChrome.cartridge("apps", {});
    if (r && r.ok && Array.isArray(r.apps)) forgeApps = r.apps.filter((a) => !a.blocked);
  } catch {}
})();

function render() {
  const idx = new Map(apps.map((a, i) => [a.id, i]));
  const home = apps.find((a) => a.id === "launcher");
  // The browser sits directly under the Sanctum rather than inside a kind
  // section. Home is where you are; The Wilds is the way out. Both are
  // fixtures of the shell rather than things you registered, and a section
  // heading over a list of one reads as a mistake.
  const wilds = apps.find((a) => a.kind === "browser");
  const groups = new Map();
  const byKind = { local: [], static: [], external: [] };
  for (const a of apps) {
    if (a === home || a === wilds) continue;
    if (a.group) {
      if (!groups.has(a.group)) groups.set(a.group, []);
      groups.get(a.group).push(a);
    } else if (byKind[a.kind]) byKind[a.kind].push(a);
  }

  let html = "";
  if (home) html += itemHtml(home, idx.get(home.id), false);
  if (wilds) html += itemHtml(wilds, idx.get(wilds.id), false);
  for (const kind of ["local", "static", "external"]) {
    if (!byKind[kind].length) continue;
    html += `<div class="sect"><span>${KIND_LABEL[kind]}</span></div>`;
    html += byKind[kind].map((a) => itemHtml(a, idx.get(a.id), false)).join("");
  }
  for (const [g, list] of groups) {
    html += `<div class="sect"><span>${esc(g)}</span></div>`;
    html += list.map((a) => itemHtml(a, idx.get(a.id), true)).join("");
  }

  if (html !== lastNavHtml) {
    $("navlist").innerHTML = html;
    lastNavHtml = html;
  }
  paintMb();
  renderCount();
  renderNav();
}

// The MB readouts are filled in where they stand. They used to be part of
// each item's HTML, so a figure that moved -- one does, nearly every 5 s
// poll -- rebuilt the whole rail: the hover ✕ flickered, tooltips reset and
// a click that landed across the rebuild was lost.
function paintMb() {
  for (const el of $("navlist").querySelectorAll(".imb[data-mb]")) {
    const mb = openMb.get(el.dataset.mb);
    const t = mb != null ? fmtMb(mb) : "";
    if (el.textContent !== t) el.textContent = t;
  }
}

function renderCount() {
  const bits = [];
  if (activeMb != null) bits.push(fmtMb(activeMb));
  if (totalMb != null) bits.push("Σ " + fmtMb(totalMb));
  $("count").textContent = bits.join(" · ");
}

function renderNav() {
  $("back").disabled = !navState.canBack;
  $("fwd").disabled = !navState.canForward;
  const z = Math.round((navState.zoom || 1) * 100);
  $("zoomChip").hidden = z === 100;
  $("zoomChip").textContent = `${z}%`;
}

// Delegated: click activates, middle-click hibernates, ✕ hibernates.
$("navlist").addEventListener("click", (e) => {
  const r = e.target.closest("[data-rest]");
  if (r) { e.stopPropagation(); roostChrome.closeView(r.dataset.rest).then(refreshApps); return; }
  const t = e.target.closest(".item");
  if (t) roostChrome.activate(t.dataset.id);
});
$("navlist").addEventListener("auxclick", (e) => {
  if (e.button !== 1) return;
  const t = e.target.closest(".item");
  if (t) roostChrome.closeView(t.dataset.id).then(refreshApps);
});

$("back").onclick = () => roostChrome.nav(activeId, "back");
$("fwd").onclick = () => roostChrome.nav(activeId, "forward");
$("zoomChip").onclick = () => roostChrome.zoom(activeId, "reset");
$("reload").onclick = () => roostChrome.reload(activeId);
$("findBtn").onclick = () => openFind();
$("devtools").onclick = () => roostChrome.devtools(activeId);
$("live").onclick = async () => {
  const r = await roostChrome.toggleWatch(activeId);
  $("live").classList.toggle("on", r.watching);
};

// Fold / unfold the rail. The main process resizes the view; the body class
// swaps the CSS to the icon-only layout.
let railMode = "full";
async function setRail(mode) {
  railMode = mode;
  document.body.classList.toggle("min", mode === "min");
  await roostChrome.rail(mode);
}
$("fold").onclick = () => setRail("min");
$("unfold").onclick = () => setRail("full");

// ----------------------------------------------------------------- events
roostChrome.on("active", ({ id, watching, canWatch }) => {
  if (!$("findbar").hidden) closeFind(); // a find belongs to the page it was typed on
  activeId = id;
  activeMb = null; // stale until the next metrics tick
  $("live").disabled = !canWatch;
  $("live").classList.toggle("on", !!watching);
  render();
  pollMetrics();
});
roostChrome.on("watch-state", ({ id, watching }) => {
  if (id === activeId) $("live").classList.toggle("on", !!watching);
});
roostChrome.on("nav-state", (s) => {
  if (s.id !== activeId) return;
  navState = s;
  renderNav();
});
roostChrome.on("zoom", ({ id, factor }) => {
  if (id !== activeId) return;
  navState.zoom = factor;
  renderNav();
});
