// The rail (renderer/chrome.html), part 6 of 11: the log drawer.
// Plain script, one global scope with the other parts, loaded in the order
// chrome.html lists them. See the note there before moving code between parts.

// ------------------------------------------------------------- log drawer
let logShownId = null;
let logLines = [];

// Dev servers speak in ANSI colour; render it instead of letting the escape
// codes fall on the floor as garbage. SGR colour/weight becomes spans mapped
// to the shell palette; every other escape (cursor moves, erases) vanishes.
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b./g, "");
function ansiHtml(raw) {
  let out = "", open = 0;
  const parts = esc(raw).split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) { out += parts[i]; continue; }
    while (open) { out += "</span>"; open--; }
    const cls = [];
    for (const c of parts[i].split(";").filter(Boolean).map(Number)) {
      if (c === 1) cls.push("a-b");
      else if (c === 2) cls.push("a-2");
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) cls.push("a" + c);
    }
    if (cls.length) { out += `<span class="${cls.join(" ")}">`; open++; }
  }
  while (open) { out += "</span>"; open--; }
  return out.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b./g, "");
}

function logMatches(line, f) {
  return stripAnsi(line).toLowerCase().includes(f);
}

function logRender() {
  const f = $("logFilter").value.trim().toLowerCase();
  const shown = f ? logLines.filter((l) => logMatches(l, f)) : logLines;
  $("logBody").innerHTML = shown.map(ansiHtml).join("") ||
    esc(f ? "(nothing matches the filter)" : "(no output yet — local servers log here once started)");
  $("logBody").scrollTop = $("logBody").scrollHeight;
}

async function openLogs(id) {
  hideSurfaces();
  await roostChrome.overlay(true);
  document.body.classList.add("overlay");
  logShownId = id;
  const a = apps.find((x) => x.id === id);
  $("logWho").textContent = a ? `${a.name} — live` : id;
  const r = await roostChrome.logs(id);
  logLines = r.lines || [];
  $("logsheet").hidden = false;
  logRender();
}

async function closeLogs() {
  $("logsheet").hidden = true;
  logShownId = null;
  await syncOverlay();
}

$("logsBtn").onclick = () => openLogs(activeId);
$("logClose").onclick = closeLogs;
$("logFilter").addEventListener("input", logRender);
$("logCopy").onclick = () => {
  const f = $("logFilter").value.trim().toLowerCase();
  const shown = f ? logLines.filter((l) => logMatches(l, f)) : logLines;
  navigator.clipboard.writeText(shown.map(stripAnsi).join(""));
  $("msg").className = "msg"; $("msg").textContent = "logs copied";
};
roostChrome.on("app-log", ({ id, line }) => {
  if ($("logsheet").hidden || id !== logShownId) return;
  logLines.push(line);
  const f = $("logFilter").value.trim().toLowerCase();
  if (f && !logMatches(line, f)) return;
  const el = $("logBody");
  const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.insertAdjacentHTML("beforeend", ansiHtml(line));
  if (pinned) el.scrollTop = el.scrollHeight;
});

// A cheap reuse: the shortcut list renders in the log drawer's pre.
async function openKeys() {
  hideSurfaces();
  await roostChrome.overlay(true);
  document.body.classList.add("overlay");
  logShownId = null;
  $("logWho").textContent = "keyboard shortcuts";
  logLines = KEYMAP.map(([k, what]) => `  ${k.padEnd(22)}${what}\n`);
  $("logsheet").hidden = false;
  logRender();
}
