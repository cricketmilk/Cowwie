// The rail (renderer/chrome.html), part 9 of 11: quick-add (Ctrl+D).
// Plain script, one global scope with the other parts, loaded in the order
// chrome.html lists them. See the note there before moving code between parts.

// -------------------------------------------------------------- quick-add
// One input, four accepted things: a URL, a note, a pasted image, a dropped
// file. The Trove is not a checkbox — it is the record.
let clipPending = null;   // { dataUrl } | { filePath } — set by paste/drop
let clipPeekTimer = null;
let clipsToday = 0;

async function openClip() {
  if (!$("clip").hidden) return;
  hideSurfaces();
  await roostChrome.overlay(true);      // grow FIRST — the rail-width rule
  document.body.classList.add("overlay");
  $("clip").hidden = false;
  $("clipIn").value = "";
  $("clipBody").innerHTML = "";
  clipPending = null;
  $("clipIn").focus();
}

async function closeClip() {
  $("clip").hidden = true;
  clipPending = null;
  await syncOverlay();
}

// Debounced preview: a URL gets its title and og:image fetched so you can see
// what you're about to keep.
$("clipIn").addEventListener("input", () => {
  clipPending = null;
  const v = $("clipIn").value.trim();
  clearTimeout(clipPeekTimer);
  if (!/^https?:\/\/\S+$/i.test(v)) { $("clipBody").innerHTML = ""; return; }
  clipPeekTimer = setTimeout(async () => {
    const meta = await roostChrome.clipPeek(v);
    if ($("clipIn").value.trim() !== v) return;   // moved on while we fetched
    $("clipBody").innerHTML = `
      <div class="card">
        ${meta.image ? `<img src="${esc(meta.image)}" alt="">` : ""}
        <span>
          <div class="t">${esc(meta.title || "(untitled page)")}</div>
          <div class="u">${esc(v)}</div>
        </span>
      </div>`;
  }, 400);
});

$("clipIn").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); commitClip(); }
});

// Ctrl+V of an image anywhere in the surface.
$("clip").addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (!item) return;
  const file = item.getAsFile();
  if (!file) return;
  const rd = new FileReader();
  rd.onload = () => {
    clipPending = { dataUrl: rd.result };
    $("clipBody").innerHTML = `<div class="card"><img src="${rd.result}" alt=""><span>
      <div class="t">pasted image</div><div class="u">${file.type} · ${Math.round(file.size / 1024)} KB</div>
    </span></div>`;
  };
  rd.readAsDataURL(file);
});

// Drop a file from Explorer. File.path was removed in Electron 32+, so the
// bytes go through a FileReader rather than a path.
["dragover", "dragenter"].forEach((ev) =>
  $("clip").addEventListener(ev, (e) => { e.preventDefault(); document.body.classList.add("dropping"); }));
["dragleave", "drop"].forEach((ev) =>
  $("clip").addEventListener(ev, () => document.body.classList.remove("dropping")));
$("clip").addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  const uri = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
  if (file) {
    const rd = new FileReader();
    rd.onload = () => {
      clipPending = { dataUrl: rd.result };
      $("clipBody").innerHTML = `<div class="card">
        ${file.type.startsWith("image/") ? `<img src="${rd.result}" alt="">` : ""}
        <span><div class="t">${esc(file.name)}</div>
        <div class="u">${esc(file.type || "file")} · ${Math.round(file.size / 1024)} KB</div></span></div>`;
    };
    rd.readAsDataURL(file);
  } else if (uri) {
    $("clipIn").value = uri;
    $("clipIn").dispatchEvent(new Event("input"));
  }
});

async function commitClip() {
  const v = $("clipIn").value.trim();
  const payload = { source: "omnibox" };
  if (clipPending?.dataUrl) { payload.dataUrl = clipPending.dataUrl; payload.note = v || null; }
  else if (/^https?:\/\/\S+$/i.test(v)) payload.url = v;
  else if (v) payload.text = v;
  else return;

  $("clipGo").disabled = true;
  const r = await roostChrome.clipAdd(payload);
  $("clipGo").disabled = false;
  await closeClip();
  $("msg").className = r?.error ? "msg err" : "msg";
  $("msg").textContent = r?.error ? r.error : `clipped · ${r.kind}`;
}

$("clipGo").onclick = commitClip;
$("clipClose").onclick = closeClip;
$("clip").addEventListener("click", (e) => { if (e.target === $("clip")) closeClip(); });
roostChrome.on("clip-open", () => openClip());
roostChrome.on("clip-stats", (s) => {
  if (s?.added) {
    clipsToday += s.added;
    $("msg").className = "msg";
    $("msg").textContent = `clipped · ${s.kind}`;
  }
  if (s?.fanout && !s.fanout.ok) {
    $("msg").className = "msg err";
    $("msg").textContent = s.fanout.error || `${s.fanout.to} failed`;
  }
});
