// Ifreglen UI kit, the behaviour half. Load it with `defer` after
// ifreglen-ui.css. It has no API an app must call; everything is opt-in by
// markup or free:
//
//   [data-stagger]   children added to this element rise in one after
//                    another (the list of watches, the kanban cards...).
//   .bar             gets a sound toggle and the "leave" hint at its right.
//   buttons          tick on hover, knock on click. Synthesised, no files.
//   window.IFR       { sfx: { tick, knock, chime, open, bad }, toast(msg) }
//
// Sound is quiet and off by default in the apps (an HR desk is an office);
// the toggle in the bar turns it on, per app, remembered in localStorage.
// The home page has its own copy of the synth with the opposite default,
// because walking the painting is the part that is a game.
(() => {
  "use strict";
  const KEY = "ifreglen:sound";
  let on = false;
  try { on = localStorage.getItem(KEY) === "on"; } catch {}

  // ---------------------------------------------------------------- sfx
  let ctx = null;
  const ac = () => {
    if (ctx) return ctx;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; }
    return ctx;
  };
  // A short wooden knock: a damped low sine plus a breath of filtered noise.
  function knock(gain = 0.25, pitch = 170) {
    const c = ac(); if (!c || !on) return;
    const t = c.currentTime;
    const o = c.createOscillator(), g = c.createGain();
    o.type = "sine"; o.frequency.setValueAtTime(pitch, t); o.frequency.exponentialRampToValueAtTime(pitch * 0.55, t + 0.09);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + 0.13);
    const n = c.createBufferSource(), buf = c.createBuffer(1, c.sampleRate * 0.04, c.sampleRate);
    const d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    n.buffer = buf;
    const f = c.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 1400; f.Q.value = 0.8;
    const ng = c.createGain(); ng.gain.value = gain * 0.5;
    n.connect(f).connect(ng).connect(c.destination); n.start(t);
  }
  // A small bell: two partials, the second a fifth up, both dying fast.
  function chime(base = 660, gain = 0.12, len = 0.35) {
    const c = ac(); if (!c || !on) return;
    const t = c.currentTime;
    for (const [mul, g0] of [[1, gain], [1.5, gain * 0.45], [2.01, gain * 0.2]]) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = "triangle"; o.frequency.value = base * mul;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(g0, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(c.destination); o.start(t); o.stop(t + len + 0.02);
    }
  }
  const sfx = {
    tick:  () => knock(0.08, 320),
    knock: () => knock(0.22, 170),
    chime: () => chime(660, 0.12),
    open:  () => { chime(520, 0.1, 0.5); setTimeout(() => chime(780, 0.08, 0.5), 90); },
    bad:   () => { chime(220, 0.1, 0.3); setTimeout(() => chime(196, 0.08, 0.4), 80); },
  };

  // ------------------------------------------------------------- toggle
  function setOn(v) {
    on = !!v;
    try { localStorage.setItem(KEY, on ? "on" : "off"); } catch {}
    for (const b of document.querySelectorAll(".ifr-sound")) {
      b.classList.toggle("off", !on);
      b.textContent = on ? "♫" : "♫";
      b.title = on ? "Sound on. Click to mute." : "Sound off. Click for ticks and knocks.";
    }
    if (on) sfx.chime();
  }

  function dressBar() {
    const bar = document.querySelector(".bar");
    if (!bar || bar.querySelector(".ifr-sound")) return;
    const leave = document.createElement("span");
    leave.className = "ifr-leave"; leave.textContent = "ctrl+W leaves";
    leave.title = "Ctrl+W hibernates this app and walks back to the signpost";
    const b = document.createElement("button");
    b.className = "ifr-sound"; b.type = "button";
    b.addEventListener("click", (e) => { e.stopPropagation(); setOn(!on); });
    bar.append(leave, b);
    setOn(on);
  }

  // ------------------------------------------------------------ stagger
  // Each child of a [data-stagger] element gets --i (its index) and .rise
  // when it first appears, so a freshly painted list cascades in. Re-rendering
  // the same list re-cascades it, which is the point: you see what changed.
  function stagger(root) {
    const kids = [...root.children];
    kids.forEach((k, i) => { if (!k.classList.contains("rise")) { k.style.setProperty("--i", Math.min(i, 24)); k.classList.add("rise"); } });
  }
  function watchStagger() {
    const mo = new MutationObserver((muts) => {
      const seen = new Set();
      for (const m of muts) { const t = m.target.closest ? m.target.closest("[data-stagger]") : null; if (t) seen.add(t); }
      for (const t of seen) stagger(t);
    });
    for (const el of document.querySelectorAll("[data-stagger]")) stagger(el);
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // ------------------------------------------------------- button sounds
  let lastTick = 0;
  document.addEventListener("pointerenter", (e) => {
    const b = e.target.closest && e.target.closest("button, .btn, .tabs button, .tpl, .watch, .hire, .card");
    if (!b || b.disabled) return;
    const now = performance.now(); if (now - lastTick < 60) return; lastTick = now;
    sfx.tick();
  }, true);
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("button, .btn");
    if (!b || b.disabled || b.classList.contains("ifr-sound")) return;
    if (b.classList.contains("primary")) sfx.open(); else sfx.knock();
  }, true);

  function toast(msg) {
    const t = document.querySelector(".toast"); if (!t) return;
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  window.IFR = { sfx, toast, get sound() { return on; }, set sound(v) { setOn(v); } };
  const boot = () => { dressBar(); watchStagger(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
