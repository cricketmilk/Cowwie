// The rail (renderer/chrome.html), part 11 of 11: the polls, and start-up.
// Plain script, one global scope with the other parts, loaded in the order
// chrome.html lists them. See the note there before moving code between parts.

// ------------------------------------------------------------------ polls
async function refreshApps() {
  const r = await roostChrome.apps();
  apps = r.apps;
  if (r.activeId) activeId = r.activeId;
  render();
}

// Passive metrics tick: keeps the rail's MB readouts honest without the
// perf drawer open. One IPC round-trip every 5s — cheap. A figure that moved
// is patched in place (paintMb); the rail itself is not rebuilt for it.
let lastMbSig = "";
let autoRestMins = 0;
async function pollMetrics() {
  try {
    const m = await roostChrome.metrics();
    noteHist(m.apps);
    openMb = new Map((m.apps || []).map((a) => [a.id, a.mb]));
    const mine = (m.apps || []).find((a) => a.id === activeId);
    activeMb = mine?.mb ?? null;
    totalMb = m.totalMb ?? null;
    const sig = JSON.stringify([...openMb]);
    if (sig !== lastMbSig) { lastMbSig = sig; paintMb(); }
    renderCount();
  } catch {}
}

(async () => {
  // Restore the remembered rail width before first paint of the app list.
  try {
    const rs = await roostChrome.rail();
    railMode = rs.mode || "full";
    document.body.classList.toggle("min", railMode === "min");
    autoRestMins = (await roostChrome.autoRest()).mins || 0;
  } catch {}
  await refreshApps();
  pollMetrics();
  // Server starts/stops push "apps-changed"; this poll is the backstop for
  // anything that changes without an event.
  setInterval(() => { if (!document.hidden) refreshApps(); }, 15000);
  setInterval(() => { if (!document.hidden) pollMetrics(); }, 5000);
})();
