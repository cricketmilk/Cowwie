// The rail (renderer/chrome.html), part 7 of 11: the performance drawer.
// Plain script, one global scope with the other parts, loaded in the order
// chrome.html lists them. See the note there before moving code between parts.

// ------------------------------------------------------ performance drawer

// A short memory-history per app feeds the drawer's sparklines. Fed by both
// the passive 5s tick and the drawer's own 2s refresh; forty points is a few
// minutes of shape, which is what "is this thing leaking" actually needs.
const mbHist = new Map(); // appId -> [mb, ...]
function noteHist(apps) {
  for (const a of apps || []) {
    if (a.mb == null) continue;
    const h = mbHist.get(a.id) || [];
    h.push(a.mb);
    if (h.length > 40) h.shift();
    mbHist.set(a.id, h);
  }
}
function spark(id) {
  const h = mbHist.get(id) || [];
  if (h.length < 2) return "";
  const max = Math.max(...h), min = Math.min(...h);
  const pts = h.map((v, i) => {
    const x = (i / (h.length - 1)) * 58 + 1;
    const norm = max === min ? 0.5 : (v - min) / (max - min);
    return `${x.toFixed(1)},${(16.5 - norm * 14).toFixed(1)}`;
  }).join(" ");
  return `<svg class="spk" width="60" height="18" viewBox="0 0 60 18" aria-hidden="true"
    ><polyline points="${pts}" fill="none" stroke="var(--occult)" stroke-width="1.5"/></svg>`;
}

async function paintPerf() {
  const m = await roostChrome.metrics();
  noteHist(m.apps);
  const rows = (m.apps || []).sort((a, b) => (b.mb || 0) - (a.mb || 0));
  const max = Math.max(1, ...rows.map((r) => r.mb || 0));
  $("perfRows").innerHTML = rows.length ? rows.map((r) => `
    <div class="prow">
      <span class="pname">${esc(r.name)}
        <span class="state ${r.active ? "here" : ""}">${r.active ? "active" : r.serverUp ? "server up" : "open"}</span>
      </span>
      <span class="track"><span class="fill" style="display:block;width:${Math.round((r.mb || 0) / max * 100)}%"></span></span>
      ${spark(r.id)}
      <span class="num"><b>${fmtMb(r.mb) || "–"}</b></span>
      <span class="num">${r.cpu != null ? r.cpu + "% cpu" : ""}</span>
      ${r.id !== "launcher" ? `<button class="obtn" data-rest="${esc(r.id)}">hibernate</button>` : "<span style='width:86px'></span>"}
    </div>`).join("")
    : '<div class="none">Nothing open. The shell at rest.</div>';
  $("perfTotal").textContent = fmtMb(m.totalMb) || "–";
  $("perfProcs").textContent = `${m.processes} processes`;
}

async function openPerf() {
  hideSurfaces();
  await roostChrome.overlay(true);
  document.body.classList.add("overlay");
  $("perf").hidden = false;
  await paintPerf();
  clearInterval(perfTimer);
  perfTimer = setInterval(paintPerf, 2000);
}

async function closePerf() {
  clearInterval(perfTimer);
  perfTimer = null;
  $("perf").hidden = true;
  await syncOverlay();
}

$("count").onclick = () => openPerf();
$("perfClose").onclick = closePerf;
$("perfRows").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-rest]");
  if (!b) return;
  await roostChrome.closeView(b.dataset.rest);
  refreshApps();
  paintPerf();
});
$("restAll").onclick = async () => {
  const m = await roostChrome.metrics();
  for (const r of m.apps || []) {
    if (!r.active && r.id !== "launcher") await roostChrome.closeView(r.id);
  }
  refreshApps();
  paintPerf();
};
