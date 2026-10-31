// The rail (renderer/chrome.html), part 3 of 11: overlay plumbing (which sheets grow the rail) and find in page.
// Plain script, one global scope with the other parts, loaded in the order
// chrome.html lists them. See the note there before moving code between parts.

// -------------------------------------------------------- overlay plumbing
// One rule, four surfaces (palette, logs, performance, discovery): the host
// view is only grown to the full window while at least one is showing.
// Forgetting the grow clips a surface to the rail; forgetting the shrink
// leaves an invisible wall over the app.
async function syncOverlay() {
  const open = !$("sheet").hidden || !$("pal").hidden || !$("logsheet").hidden
            || !$("perf").hidden || !$("clip").hidden || !$("manif").hidden
            || !$("absorb").hidden || !$("forge").hidden;
  document.body.classList.toggle("overlay", open);
  await roostChrome.overlay(open);
}

let perfTimer = null;
function hideSurfaces() {
  $("sheet").hidden = true; $("pal").hidden = true;
  $("logsheet").hidden = true; $("perf").hidden = true; $("clip").hidden = true; $("manif").hidden = true; $("absorb").hidden = true;
  $("forge").hidden = true;
  clearInterval(perfTimer); // the drawer's refresh must not outlive it
  perfTimer = null;
}

$("backdrop").addEventListener("click", () => {
  hideSurfaces();
  syncOverlay();
});

// ----------------------------------------------------------- find in page
let findTimer = null;

async function openFind() {
  if (railMode === "min") await setRail("full"); // the bar needs the width
  $("findbar").hidden = false;
  $("findIn").focus();
  $("findIn").select();
}

function closeFind() {
  $("findbar").hidden = true;
  $("findTally").textContent = "";
  roostChrome.find(activeId, "stop");
}

$("findIn").addEventListener("input", () => {
  clearTimeout(findTimer);
  const text = $("findIn").value;
  if (!text) { $("findTally").textContent = ""; roostChrome.find(activeId, "stop"); return; }
  findTimer = setTimeout(() => roostChrome.find(activeId, "find", text), 160);
});
$("findIn").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    roostChrome.find(activeId, e.shiftKey ? "prev" : "next", $("findIn").value);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeFind();
  }
});
$("findNext").onclick = () => roostChrome.find(activeId, "next", $("findIn").value);
$("findPrev").onclick = () => roostChrome.find(activeId, "prev", $("findIn").value);
$("findClose").onclick = closeFind;
roostChrome.on("find-result", ({ id, matches, active }) => {
  if (id !== activeId || $("findbar").hidden) return;
  $("findTally").textContent = matches ? `${active}/${matches}` : "0";
});
