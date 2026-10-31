// The rail (renderer/chrome.html), part 2 of 11: the coding handoff: the Forge's dry run and apply.
// Plain script, one global scope with the other parts, loaded in the order
// chrome.html lists them. See the note there before moving code between parts.

// ------------------------------------------------- the coding handoff
// The return leg. A model's reply, selected in a Wilds tab and right-clicked,
// arrives here as a dry run: per file, what would change and what did not
// match. Nothing is written until Apply.
let forgeLast = null;

function forgeRows(files) {
  if (!files || !files.length) {
    return `<p class="none">The Forge found no edits it could place. If the reply is a change-set,
            "Copy correction…" builds the request that asks the model to fix what did not match.</p>`;
  }
  return files.map((f) => {
    const okEdits = f.applied ?? f.matched ?? f.hunks ?? 0;
    const bad = f.failed ?? f.unmatched ?? 0;
    const state = bad ? "bad" : "good";
    return `<div class="proj">
      <span class="pname">${esc(f.path || f.file || "(unnamed)")}</span>
      <span class="pkind ${state}">${bad ? `${bad} did not match` : `${okEdits} edit${okEdits === 1 ? "" : "s"}`}</span>
      <span class="pcmd">${esc(f.app || "")}</span>
    </div>`;
  }).join("");
}

async function openForge() {
  hideSurfaces();
  await roostChrome.overlay(true);          // grow FIRST — the rail-width rule
  document.body.classList.add("overlay");
  $("forge").hidden = false;
}
async function closeForge() { $("forge").hidden = true; await syncOverlay(); }
$("forgeClose").onclick = closeForge;

roostChrome.on("forge-preview", (p) => {
  forgeLast = p;
  const files = p.files || [];
  const bad = files.filter((f) => (f.failed ?? f.unmatched ?? 0) > 0).length;
  $("forgeWhat").textContent = files.length
    ? `${files.length} file${files.length === 1 ? "" : "s"}${bad ? `, ${bad} with misses` : ""} — nothing written yet`
    : "nothing the Forge could place";
  $("forgeBody").innerHTML = forgeRows(files);
  $("forgeApply").disabled = !files.length;
  openForge();
});

roostChrome.on("forge-applied", (r) => {
  if (r && r.ok) {
    const n = (r.detail && r.detail.applied || []).length;
    $("msg").className = "msg";
    $("msg").textContent = `the Forge wrote ${n} file${n === 1 ? "" : "s"}`;
    closeForge();
  } else {
    $("msg").className = "msg err";
    $("msg").textContent = (r && r.error) || "the Forge could not apply it";
  }
});

$("forgeApply").onclick = async () => {
  $("forgeApply").disabled = true;
  $("forgeWhat").textContent = "writing, snapshot first…";
  await roostChrome.cartridge("apply", { verify: $("forgeVerify").checked });
};
$("forgeCorrection").onclick = async () => {
  const r = await roostChrome.cartridge("correction", {});
  $("forgeWhat").textContent = r && r.ok
    ? "correction copied — paste it into the same chat"
    : (r && r.error) || "no correction to build";
};

roostChrome.on("app-status", ({ message }) => {
  $("msg").className = "msg"; $("msg").textContent = message || "";
});
roostChrome.on("app-error", ({ id, message }) => {
  $("msg").className = "msg err"; $("msg").textContent = message;
  $("msg").dataset.logId = id || activeId || "";
});
// An error message is a door, not a dead end: click it for the logs.
$("msg").addEventListener("click", () => {
  if ($("msg").classList.contains("err")) openLogs($("msg").dataset.logId || activeId);
});
roostChrome.on("apps-changed", () => refreshApps());
roostChrome.on("find-open", () => openFind());
roostChrome.on("logs-open", ({ id }) => openLogs(id || activeId));
