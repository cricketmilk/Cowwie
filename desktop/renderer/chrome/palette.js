// The rail (renderer/chrome.html), part 4 of 11: the command palette and its keyboard.
// Plain script, one global scope with the other parts, loaded in the order
// chrome.html lists them. See the note there before moving code between parts.

// --------------------------------------------------------- command palette
let palSel = 0, palShown = [];

// Subsequence fuzzy match. Consecutive hits and word-starts score up, length
// drags down, so "gob" finds "open Goblin Brain" ahead of anything that
// merely contains those letters somewhere.
function fuzzy(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase();
  let qi = 0, score = 0, streak = 0, last = -2;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) {
      streak = last === i - 1 ? streak + 1 : 1;
      score += 2 + streak * 3 + (i === 0 || " -_./·+".includes(s[i - 1]) ? 6 : 0);
      last = i; qi++;
    }
  }
  return qi === q.length ? score - s.length * 0.05 : -1;
}

const KEYMAP = [
  ["Ctrl+K", "command palette"],
  ["Ctrl+1…9", "jump to the nth app"],
  ["Ctrl+Tab / +Shift", "cycle apps — tabs while browsing The Wilds"],
  ["Ctrl+F", "find in page"],
  ["Ctrl+L", "logs for the active app — the address bar in The Wilds"],
  ["Ctrl+D", "quick-add — clip a link, note, image or file"],
  ["Ctrl+M / Ctrl+`", "Auri — answer her cards; again, or Esc, gives the keys back"],
  ["Ctrl+R / F5", "reload the active app"],
  ["Ctrl+= / − / 0", "zoom in / out / reset (remembered per app)"],
  ["Alt+← / Alt+→", "back / forward"],
  ["F12", "devtools"],
  ["Ctrl+W", "hibernate the active app — or close a tab in The Wilds"],
  ["Ctrl+T", "a new page in The Wilds (Ctrl+Shift+T reopens the last one)"],
  ["middle-click an app", "hibernate it"],
];

function fullName(a) {
  return a.group ? `${a.group} · ${a.name}` : a.name;
}

function palItems(q) {
  const items = [];
  apps.forEach((a, i) => items.push({
    verb: "open", label: fullName(a),
    hint: (i < 9 ? `ctrl+${i + 1} · ` : "") + a.persona,
    run: () => roostChrome.activate(a.id),
  }));
  const act = apps.find((a) => a.id === activeId);
  if (act) {
    items.push({ verb: "app", label: `reload ${act.name}`, hint: "ctrl+r", run: () => roostChrome.reload(activeId) });
    items.push({ verb: "app", label: `devtools ${act.name}`, hint: "f12", run: () => roostChrome.devtools(activeId) });
    items.push({ verb: "app", label: "find in page", hint: "ctrl+f", run: () => openFind() });
    items.push({ verb: "app", label: "toggle live reload", run: async () => {
      const r = await roostChrome.toggleWatch(activeId);
      $("live").classList.toggle("on", r.watching);
    }});
    items.push({ verb: "app", label: "back", hint: "alt+←", run: () => roostChrome.nav(activeId, "back") });
    items.push({ verb: "app", label: "forward", hint: "alt+→", run: () => roostChrome.nav(activeId, "forward") });
    items.push({ verb: "zoom", label: "zoom in", hint: "ctrl+=", run: () => roostChrome.zoom(activeId, "in") });
    items.push({ verb: "zoom", label: "zoom out", hint: "ctrl+-", run: () => roostChrome.zoom(activeId, "out") });
    items.push({ verb: "zoom", label: "reset zoom", hint: "ctrl+0", run: () => roostChrome.zoom(activeId, "reset") });
    items.push({ verb: "url", label: `open ${act.name} in browser`, run: async () => {
      const r = await roostChrome.openExternal(activeId);
      if (r?.error) { $("msg").className = "msg err"; $("msg").textContent = r.error; }
    }});
    items.push({ verb: "url", label: "copy current url", run: async () => {
      const r = await roostChrome.copyUrl(activeId);
      $("msg").className = "msg";
      $("msg").textContent = r?.copied ? "url copied" : (r?.error || "");
    }});
    items.push({ verb: "logs", label: `logs — ${act.name}`, hint: "ctrl+l", run: () => openLogs(activeId) });
  }
  items.push({ verb: "shell", label: "performance — memory per app", run: () => openPerf() });
  items.push({ verb: "shell", label: "home — Ifreglen", run: () => $("home").onclick() });
  items.push({ verb: "shell", label: railMode === "min" ? "expand the rail" : "collapse the rail",
    run: () => setRail(railMode === "min" ? "full" : "min") });
  items.push({ verb: "rest",
    label: autoRestMins
      ? `auto-rest: hibernating idle apps after ${autoRestMins}m — turn off`
      : "auto-rest idle apps: off — hibernate after 20m",
    hint: "the active app and Home exempt",
    run: async () => {
      const r = await roostChrome.autoRest(autoRestMins ? 0 : 20);
      autoRestMins = r.mins;
      $("msg").className = "msg";
      $("msg").textContent = autoRestMins ? `auto-rest on: ${autoRestMins}m` : "auto-rest off";
    } });
  items.push({ verb: "clip", label: `quick-add…${clipsToday ? `  ${clipsToday} today` : ""}`,
    hint: "ctrl+d", run: () => openClip() });
  if (act) {
    items.push({ verb: "clip", label: `clip this page — ${act.name}`, run: async () => {
      const r = await roostChrome.clipAdd({ source: "palette", url: navState.url });
      $("msg").className = r?.error ? "msg err" : "msg";
      $("msg").textContent = r?.error || "page clipped";
    }});
  }
  items.push({ verb: "clip", label: "verify the Trove — re-hash every object", run: async () => {
    $("msg").className = "msg"; $("msg").textContent = "verifying…";
    const r = await roostChrome.clipVerify();
    $("msg").className = r.bad?.length ? "msg err" : "msg";
    $("msg").textContent = r.bad?.length
      ? `${r.bad.length} of ${r.checked} objects failed`
      : `${r.ok} objects verified, all intact`;
  }});
  // Beside: a chat down the right that can be handed the page in front.
  items.push({ verb: "ask", label: act ? `ask a chat about this page — ${act.name}` : "ask a chat about this page",
    hint: "ctrl+j — Beside; you press Enter", run: () => roostChrome.beside("share") });
  items.push({ verb: "ask", label: "Beside: open or close the chat column", run: () => roostChrome.beside("toggle") });
  // Restart the shell. Refused while a Forge turn is mid-flight, and it says so.
  items.push({ verb: "shell", label: "restart the shell", hint: "the apps it started come back with it", run: async () => {
    const r = await roostChrome.update("relaunch");
    if (r && !r.ok) { $("msg").className = "msg err"; $("msg").textContent = r.error || "could not restart"; }
  } });
  items.push({ verb: "shell", label: "keyboard shortcuts", run: () => openKeys() });
  const wilds = apps.find((a) => a.kind === "browser");
  if (wilds) {
    items.push({ verb: "web", label: `browse the web — ${wilds.name}`, hint: "ctrl+t",
      run: () => roostChrome.activate(wilds.id) });
    // The outbound leg of the handoff. Put the cursor in a chat box first;
    // this types the packed context in and stops. Enter stays yours.
    for (const a of forgeApps) {
      items.push({
        verb: "forge",
        label: `cartridge for ${a.name || a.id} → this chat`,
        hint: "put your cursor in the chat box first",
        run: async () => {
          const r = await roostChrome.cartridge("to-chat", { appIds: [a.id] });
          $("msg").className = r && r.ok ? "msg" : "msg err";
          $("msg").textContent = r && r.ok
            ? `cartridge in — ${Math.round(r.chars / 1024)} KB. Press Enter when ready.`
            : (r && r.error) || "could not pack it";
        },
      });
    }
  }
  items.push({ verb: "shell", label: "absorb an outside project…", run: () => openAbsorb() });
  for (const a of apps.filter((x) => x.kind === "local")) {
    items.push({ verb: "server", label: `restart ${a.name}`, run: () => roostChrome.restart(a.id) });
    items.push({ verb: "server", label: `stop ${a.name}`, run: () => roostChrome.stop(a.id) });
  }
  for (const a of apps.filter((x) => x.open && x.id !== activeId && x.id !== "launcher")) {
    items.push({ verb: "rest", label: `hibernate ${fullName(a)}`, hint: "frees its renderer",
      run: async () => { await roostChrome.closeView(a.id); refreshApps(); } });
  }
  if (!q) return items;
  const hits = items
    .map((it) => ({ it, s: fuzzy(q, it.verb + " " + it.label) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.it);

  // The palette doubles as an address bar. Whatever you typed is always
  // offered as somewhere to go — ranked LAST, so it can never steal the top
  // slot from the app you were actually reaching for.
  if (wilds) {
    const looksUrl = /^[a-z][a-z0-9+.\-]*:/i.test(q)
      || (!/\s/.test(q) && /\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(q))
      || /^(localhost|127\.0\.0\.1)(:\d+)?/i.test(q);
    hits.push({
      verb: "web",
      label: looksUrl ? `go to ${q}` : `search the web for "${q}"`,
      hint: `in ${wilds.name}`,
      run: async () => {
        await roostChrome.roam("open", { input: q });
        roostChrome.activate(wilds.id);
      },
    });
  }
  return hits;
}

function palRender() {
  palShown = palItems($("palIn").value.trim());
  palSel = Math.min(palSel, Math.max(0, palShown.length - 1));
  $("palList").innerHTML = palShown.length
    ? palShown.map((it, i) => `
        <li class="${i === palSel ? "sel" : ""}" data-i="${i}">
          <span class="verb">${esc(it.verb)}</span><span>${esc(it.label)}</span>
          ${it.hint ? `<span class="hint">${esc(it.hint)}</span>` : ""}
        </li>`).join("")
    : '<div class="none">nothing matches</div>';
  document.querySelector("#pal li.sel")?.scrollIntoView({ block: "nearest" });
}

async function openPalette() {
  if (!$("pal").hidden) return;
  hideSurfaces();
  await roostChrome.overlay(true);         // grow FIRST — the rail-width rule
  document.body.classList.add("overlay");
  $("pal").hidden = false;
  $("palIn").value = ""; palSel = 0;
  palRender();
  $("palIn").focus();
}

async function closePalette() {
  $("pal").hidden = true;
  await syncOverlay();
}

async function palRun(i) {
  const it = palShown[i];
  await closePalette();
  if (it) it.run();
}

roostChrome.on("palette", openPalette);
