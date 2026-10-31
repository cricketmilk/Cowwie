"use strict";
// The herald's page. It draws the state main.js hands it (lib/herald.js) and
// sends back what you pressed. It decides nothing about WHAT to show — order,
// timers, collapsing, quiet hours and trust all live in the main process, so
// a reload of this page loses nothing and a test can drive the queue without
// it. What lives here is how things look and move, and the keyboard.

const R = window.roostHerald;
const FACES = window.AURI_FACES || {};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// The vocabulary. One face, one meaning, always: if two kinds of news wore
// the same face you would have to read the card to know which it was, and
// the whole point of a face is that you do not.
const KIND = {
  message:       { face: "message",     tag: "MESSAGE" },
  approval:      { face: "urgent",      tag: "NEEDS YOU" },
  question:      { face: "question",    tag: "QUESTION" },
  done:          { face: "done",        tag: "DONE" },
  error:         { face: "furious",     tag: "IT BROKE" },
  missed:        { face: "hurt",        tag: "MISSED" },
  pileup:        { face: "overwhelmed", tag: "PILE-UP" },
  digest:        { face: "asleep",      tag: "WHILE YOU WERE OUT" },
  look:          { face: "heads-up",    tag: "LOOK" },
  call:          { face: "call",        tag: "CALLING" },
  love:          { face: "love",        tag: "YOUR PEOPLE" },
  hello:         { face: "wave",        tag: "HELLO" },
  blocked:       { face: "angry",       tag: "BLOCKED" },
  offline:       { face: "dizzy",       tag: "OUT OF REACH" },
  "task-done":   { face: "done",        tag: "DONE" },
  "task-failed": { face: "hurt",        tag: "DIDN'T LAND" },
};
// Work, as she does it and as she holds it up when it is finished.
const TASK = {
  art:      { working: "art-working",      done: "art-done",      tag: "PAINTING" },
  code:     { working: "code-working",     done: "code-done",     tag: "CODING" },
  write:    { working: "write-working",    done: "write-done",    tag: "WRITING" },
  research: { working: "research-working", done: "research-done", tag: "LOOKING" },
};
// [key, label, look]. A key is only ever one thing across every card.
const ACT = {
  reply: ["R", "Reply"], answer: ["R", "Answer"], open: ["O", "Open"], later: ["L", "Later"],
  dismiss: ["Esc", "Dismiss"], allow: ["A", "Allow", "go"], always: ["Y", "Always", "go"],
  deny: ["D", "Deny", "stop"], retry: ["T", "Restart"], restart: ["T", "Restart"], logs: ["G", "Logs"],
  stop: ["X", "Stop", "stop"], mute: ["M", "Mute 1h"], callback: ["C", "Call back"],
};

// ---------------------------------------------------------------- scale
// Müt's rule (renderer/mut.html setScale): a native pixel is a whole number
// of DEVICE pixels, so the CSS size per native pixel is that count over the
// display's ratio — fractional at 125% and 150%, and correct there.
let dpr = 1;
const kFor = (n) => Math.max(1, Math.round(n * dpr)) / dpr;
let K = 2, KS = 1.5, K1 = 1;
let dprQuery = null;
function setScale() {
  dpr = window.devicePixelRatio || 1;
  K = kFor(2); KS = kFor(1.5); K1 = kFor(1);
  if (dprQuery) dprQuery.onchange = null;
  dprQuery = matchMedia(`(resolution: ${dpr}dppx)`);
  dprQuery.onchange = () => { setScale(); if (last) { wipeFaces(); render(last); } };
}

function pimg(src, w, h, cls) {
  const im = new Image();
  im.src = src; im.alt = ""; im.draggable = false; im.className = cls;
  im.style.width = w + "px"; im.style.height = h + "px";
  return im;
}

// Mood motion families: every face gets a stepped native-pixel idle rhythm and
// FX choreography matched to what she is feeling or doing.
const FACE_MOOD = {
  "heads-up": "idle", message: "idle", question: "idle", shy: "idle", delivered: "joy",
  asleep: "sleep",
  urgent: "alert",
  angry: "seethe", furious: "seethe",
  dizzy: "sway", hurt: "sway", overwhelmed: "sway",
  joy: "joy", wink: "joy", love: "joy", done: "joy", wave: "joy",
  "art-done": "joy", "code-done": "joy", "write-done": "joy", "research-done": "joy",
  call: "ring",
  "art-working": "work", "code-working": "work", "write-working": "work", "research-working": "work",
};

// One face: her body as one image, pixel-stepped eyelids over her open eyes,
// and every loose mark as its own layer so the marks and her breathing move in
// whole native pixels. Placed by her face's centre (the manifest's ax/ay), so
// an easel on one side or a scroll on the other never moves her head.
function face(name, k) {
  const known = FACES[name] ? name : "heads-up";
  const f = FACES[known];
  const mood = FACE_MOOD[known] || "idle";
  const box = document.createElement("div");
  box.className = `face m-${mood}`;
  box.dataset.name = known;
  if (!f) return box;
  box.style.cssText = `width:${f.w * k}px;height:${f.h * k}px;left:${-f.ax * k}px;top:${-f.ay * k}px;--k:${k}px`;
  box.append(pimg(`auri/${known}.png`, f.w * k, f.h * k, "body"));
  if (Array.isArray(f.eyes)) {
    for (const [ex, ey, ew, eh] of f.eyes) {
      const lid = document.createElement("i");
      lid.className = "lid";
      lid.style.cssText = `left:${ex * k}px;top:${ey * k}px;width:${ew * k}px;height:${Math.max(2, eh - 1) * k}px`;
      box.append(lid);
    }
  }
  f.fx.forEach((m, idx) => {
    const area = m.w * m.h;
    const kind = mood === "sleep" ? "zz" : mood === "joy" ? (area <= 28 ? "tw" : "rs")
      : (mood === "seethe" || mood === "alert" || mood === "ring") ? "sn"
      : mood === "work" ? (area <= 24 ? "tw" : "wk")
      : (area <= 24 ? "tw" : "dr");
    const im = pimg(`auri/${m.src}`, m.w * k, m.h * k, `fx ${kind}`);
    im.style.left = m.x * k + "px";
    im.style.top = m.y * k + "px";
    im.style.setProperty("--i", String(idx));
    // Staggered left to right, so a row of dots reads as a ripple, not a blink.
    im.style.animationDelay = (-(m.x / f.w) * 1.4 - (m.y / f.h) * 0.65 - idx * 0.18).toFixed(2) + "s";
    box.append(im);
  });
  return box;
}

function portrait(extra = "") {
  const p = document.createElement("div");
  p.className = "portrait " + extra;
  p.innerHTML = `${extra === "p-card" ? '<div class="burst"></div>' : ""}<div class="face-box"><div class="anchor"></div></div>`;
  return p;
}

// Swap the face only when it changed; a swap is a hop, never a zoom.
function setFace(p, name, k, at, hop) {
  const a = p.querySelector(".anchor");
  const cur = a.firstElementChild;
  a.style.left = at[0] + "px";
  a.style.top = at[1] + "px";
  a.style.setProperty("--kb", k + "px");
  if (cur && cur.dataset.name === (FACES[name] ? name : "heads-up") && cur.dataset.k === String(k)) return cur;
  const f = face(name, k);
  f.dataset.k = String(k);
  a.replaceChildren(f);
  if (hop) {
    const fb = p.querySelector(".face-box");
    fb.classList.remove("hop"); void fb.offsetWidth; fb.classList.add("hop");
  }
  return f;
}
function wipeFaces() { for (const a of document.querySelectorAll(".anchor")) a.replaceChildren(); }

// ---------------------------------------------------------------- words
// Speaker nameplate: a cohesive JRPG character banner with an illuminated
// initial crest seeded by the sender's name, so the same person always wears
// the same crest colour while the typography stays razor-sharp.
function rng(str) {
  let a = 2166136261;
  for (const c of str) a = Math.imul(a ^ c.charCodeAt(0), 16777619);
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function ransom(name) {
  const text = String(name || "Auri").trim() || "Auri";
  const r = rng(text);
  const crests = ["red", "gold", "holly", "red", "gold"];
  const crest = crests[Math.floor(r() * crests.length)];
  return [...text].map((ch, i) => {
    if (ch === " ") return '<span class="rl gap"></span>';
    if (i === 0) return `<span class="rl cap ${crest}" style="--i:0">${esc(ch)}</span>`;
    return `<span class="rl chr" style="--i:${i}">${esc(ch)}</span>`;
  }).join("");
}
function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 10 ? "NOW" : s < 60 ? s + "S" : s < 3600 ? Math.round(s / 60) + "M" : Math.round(s / 3600) + "H";
}
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 3600 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- cards
const cardEls = new Map();
const CARD_AT = { front: () => [64, 52], back: () => [48, 36] };

function faceFor(c) {
  if (c.resolved && c.resolved.face) return c.resolved.face;
  if (c.face) return c.face;
  return (KIND[c.kind] || KIND.look).face;
}

function makeCard(c) {
  const el = document.createElement("article");
  el.className = "card";
  el.dataset.id = c.id;
  el.innerHTML = `<div class="plate red"></div><div class="plate bone"></div>
    <div class="panel">
      <div class="meta"><span class="tag"></span><span class="chan"></span><span class="count"></span><span class="when"></span></div>
      <div class="who"></div>
      <p class="body"></p>
      <code class="cmd" hidden></code>
      <div class="choices" hidden></div>
      <div class="actions"></div>
      <div class="summon">Ctrl+\` to answer</div>
      <div class="timer" hidden><i></i></div>
    </div>
    <form class="reply"><input aria-label="Reply" placeholder="Say it..." maxlength="500"><span class="via"></span><kbd>↵</kbd></form>`;
  el.insertBefore(portrait("p-card"), el.querySelector(".reply"));
  el.addEventListener("pointerdown", () => { if (!el.classList.contains("front")) R.act(c.id, "front"); });
  el.addEventListener("mouseenter", () => R.act(c.id, "hover", { on: true }));
  el.addEventListener("mouseleave", () => R.act(c.id, "hover", { on: false }));
  el.querySelector(".actions").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) doAct(el, b.dataset.act);
  });
  el.querySelector(".choices").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) R.act(el._c.id, "choose", { index: Number(b.dataset.i) });
  });
  el.querySelector(".reply").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.querySelector(".reply input").value.trim();
    if (!text) return;
    R.act(el._c.id, el._c.acts.includes("answer") ? "answer" : "reply", { text });
    stopReplying(el, true);
  });
  el.addEventListener("animationend", (e) => {
    if (e.target !== el) return;
    if (el.classList.contains("out")) { el.remove(); cardEls.delete(el.dataset.id); report(); return; }
    el.classList.remove("in-slam", "in-slide", "land", "bump");
    el.style.animationDelay = "";
  });
  return el;
}

function updateCard(el, c, front) {
  const prev = el._c;
  el._c = c;
  const k = KIND[c.kind] || KIND.look;
  el.className = el.className.replace(/\b(k|t)-[\w-]+|\bband\d\b/g, "").trim();
  el.classList.add(`k-${c.kind}`, `band${c.band}`);
  if (c.taskKind) el.classList.add(`t-${c.taskKind}`);
  el.classList.toggle("front", front);
  el.classList.toggle("many", c.count > 1);
  el.classList.toggle("pile", !!c.pileup);
  el.classList.toggle("resolved", !!c.resolved);
  el.classList.toggle("is-busy", !!c.busy);
  if (c.resolved && el._replying) stopReplying(el, true);

  const q = (s) => el.querySelector(s);
  q(".tag").textContent = (c.resolved && c.resolved.tag) || c.tag || k.tag;
  q(".chan").textContent = c.chan || "";
  q(".count").textContent = "×" + c.count;
  q(".when").textContent = ago(c.t);
  const who = c.who || "Auri";
  if (!prev || prev.who !== c.who) q(".who").innerHTML = ransom(who);
  q(".body").textContent = c.resolved ? (c.resolved.body || "") : c.body || "";
  q(".cmd").hidden = !c.cmd || !!c.resolved;
  if (c.cmd) q(".cmd").textContent = "$ " + c.cmd;
  q(".via").textContent = "via " + (c.chan || "Auri");

  const choices = c.choices || [];
  q(".choices").hidden = !choices.length;
  if (!prev || JSON.stringify(prev.choices) !== JSON.stringify(c.choices)) {
    q(".choices").innerHTML = choices.map((t, i) => `<button data-i="${i}"><kbd>${i + 1}</kbd>${esc(t)}</button>`).join("");
  }
  if (!prev || prev.acts.join() !== c.acts.join()) {
    q(".actions").innerHTML = c.acts.filter((a) => ACT[a]).map((a) =>
      `<button class="${ACT[a][2] || ""}" data-act="${a}"><kbd>${ACT[a][0]}</kbd><span>${ACT[a][1]}</span></button>`).join("");
  }

  // The bar shows the time main.js says is left. It only animates while main
  // says the card is running; held (hover, a needs-you card in front, a reply
  // being typed) it freezes where it is.
  const timer = q(".timer"), bar = q(".timer i");
  const timed = c.band === 2 && !c.resolved && c.life;
  timer.hidden = !timed;
  if (timed) {
    const frac = Math.max(0, Math.min(1, c.remaining / c.life));
    const sig = `${Math.round(c.remaining / 50)}|${c.held}`;
    if (el._timerSig !== sig) {
      el._timerSig = sig;
      if (el._anim) el._anim.cancel();
      bar.style.transform = `scaleX(${frac})`;
      if (!c.held && c.remaining > 0) {
        el._anim = bar.animate([{ transform: `scaleX(${frac})` }, { transform: "scaleX(0)" }], { duration: c.remaining, fill: "forwards", easing: "linear" });
      }
    }
  }

  const name = c.kind === "task-done" && !c.face && !c.resolved && c.taskKind ? TASK[c.taskKind].done : faceFor(c);
  const at = front ? CARD_AT.front() : CARD_AT.back();
  const changed = prev && (faceFor(prev) !== faceFor(c));
  setFace(q(".portrait"), name, front ? K : KS, at, changed);
  if (prev && c.count > prev.count) { el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump"); }
  if (c.resolved && !(prev && prev.resolved)) {
    const f = q(".face");
    if (f) f.classList.add("cheer");
  }
}

function doAct(el, act) {
  if (!el || !el._c || el._c.resolved) return;
  if (act === "reply" || act === "answer") return startReplying(el);
  R.act(el._c.id, act);
}
function startReplying(el) {
  el._replying = true;
  el.classList.add("replying");
  // Focus in the same tick: a key typed a beat after R must land in the box,
  // not fire as a shortcut (an "o" in a word would Open).
  el.querySelector(".reply input").focus();
  R.act(el._c.id, "replying", { on: true });
  report();
}
function stopReplying(el, quiet) {
  el._replying = false;
  el.classList.remove("replying");
  el.querySelector(".reply input").value = "";
  if (!quiet && el._c && !el._c.resolved) R.act(el._c.id, "replying", { on: false });
  report();
}

// ---------------------------------------------------------------- tasks
const stripEls = new Map();
const STRIP_AT = [44, 50];

function makeStrip(t) {
  const el = document.createElement("div");
  el.className = "strip in";
  el.dataset.id = t.id;
  el.innerHTML = `<div class="panel"><div class="amb"></div>
      <div class="line1"><span class="tag"></span><span class="who"></span><span class="title"></span><span class="elapsed"></span></div>
      <div class="step"></div>
      <div class="bar"><i></i></div></div>
    <div class="halo"></div>`;
  el.append(portrait("p-strip"));
  el.addEventListener("animationend", (e) => {
    if (e.target !== el) return;
    if (el.classList.contains("folding") || el.classList.contains("gone")) { el.remove(); stripEls.delete(el.dataset.id); report(); return; }
    el.classList.remove("in");
  });
  return el;
}

function updateStrip(el, t) {
  const prev = el._t;
  el._t = t;
  const spec = TASK[t.kind] || TASK.code;
  el.className = el.className.replace(/\bk-\w+/g, "").trim();
  el.classList.add(`k-${t.kind}`);
  const q = (s) => el.querySelector(s);
  q(".tag").textContent = spec.tag;
  q(".who").textContent = t.who || "";
  q(".title").textContent = t.title || "";
  if (!prev || prev.step !== t.step) {
    const s = q(".step");
    s.textContent = t.step || "";
    s.classList.remove("fresh"); void s.offsetWidth; s.classList.add("fresh");
  }
  const bar = q(".bar");
  bar.classList.toggle("idle", t.progress === null || t.progress === undefined);
  q(".bar i").style.width = typeof t.progress === "number" ? Math.round(t.progress * 100) + "%" : "";
  setFace(q(".portrait"), spec.working, KS, STRIP_AT, !!prev && prev.kind !== t.kind);
}

// A leaving card or strip goes on its animationend, and also on a timer: a
// page in a covered or hidden window runs no animations, and an exit that
// never ends kept the view a full column wide over the app with nothing in it
// (heraldtest caught it once its window was behind another).
function dropLater(el, map, ms) {
  setTimeout(() => { if (el.isConnected) { el.remove(); map.delete(el.dataset.id); report(); } }, ms);
}

function finishStrip(el, landed) {
  if (el.classList.contains("finishing") || el.classList.contains("gone")) return;
  if (!landed) { el.classList.add("gone"); dropLater(el, stripEls, 900); return; }
  const spec = TASK[el._t.kind] || TASK.code;
  el.classList.add("finishing");
  const f = setFace(el.querySelector(".portrait"), spec.done, KS, STRIP_AT, true);
  if (f) f.classList.add("cheer");
  setTimeout(() => el.classList.add("folding"), 950);
  dropLater(el, stripEls, 950 + 900);
}

// ---------------------------------------------------------------- render
let last = null;
let focused = false;
let drawerOpen = false;
let lastCount = 0;

function render(s) {
  last = s;
  // Tasks first, so a strip that just landed can hand over to its card.
  const tasks = $("tasks");
  const want = new Set(s.tasks.map((t) => t.id));
  const landing = new Set(s.cards.filter((c) => c.fromTask).map((c) => c.fromTask));
  for (const [id, el] of stripEls) if (!want.has(id)) finishStrip(el, landing.has(id));
  const shown = s.tasks.slice(0, 3);
  for (const t of shown) {
    let el = stripEls.get(t.id);
    if (!el) { el = makeStrip(t); stripEls.set(t.id, el); tasks.append(el); }
    updateStrip(el, t);
  }
  let more = tasks.querySelector(".strip-more");
  if (s.tasks.length > shown.length) {
    if (!more) { more = document.createElement("div"); more.className = "strip-more"; tasks.append(more); }
    more.textContent = `+${s.tasks.length - shown.length} more working`;
    tasks.append(more);
  } else if (more) more.remove();

  // Cards, in main's order. Leaving cards finish their exit where they are.
  const cards = $("cards");
  const ids = new Set(s.cards.map((c) => c.id));
  for (const [id, el] of cardEls) if (!ids.has(id) && !el.classList.contains("out")) {
    el.classList.remove("front", "in-slam", "in-slide", "land");
    el.classList.add("out");
    dropLater(el, cardEls, 700);
  }
  const frontId = (s.cards.find((c) => !c.resolved) || {}).id;
  let prevEl = null;
  for (const c of s.cards) {
    let el = cardEls.get(c.id);
    if (!el) {
      el = makeCard(c);
      cardEls.set(c.id, el);
      const gentle = c.fromTask || c.kind === "done" || c.kind === "task-done";
      el.classList.add(c.band >= 3 ? "in-slam" : gentle ? "land" : "in-slide");
      // A completion waits for its strip to finish turning into the drawing.
      if (c.fromTask && stripEls.has(c.fromTask)) el.style.animationDelay = ".55s";
    }
    updateCard(el, c, c.id === frontId);
    const want = prevEl ? prevEl.nextSibling : cards.firstChild;
    if (want !== el) cards.insertBefore(el, want);
    prevEl = el;
  }

  // The pip: what is waiting, and whether she is keeping quiet. With Müt
  // retired (s.rest) she is the only creature on the screen, so she stays in
  // the corner with nothing to say: without that there was nothing to see and
  // nowhere to click, and "where is Auri" had no answer until something
  // arrived. Resting she is her face alone, and report() narrows the view to it.
  const count = s.waitingCount + s.held;
  const pip = $("pip");
  const busy = !!(count || s.quiet || drawerOpen || (focused && !s.cards.length && !s.tasks.length));
  const resting = !busy && !!s.rest && !s.cards.length && !s.tasks.length;
  pip.hidden = !(busy || resting);
  pip.classList.toggle("rest", resting);
  pip.title = resting ? "Auri: click or Ctrl+` for her drawer" : "Auri: what's waiting (Ctrl+`)";
  pip.classList.toggle("quiet", !!s.quiet);
  $("pipn").textContent = count ? String(count) : "";
  if (count > lastCount) { pip.classList.remove("bump"); void pip.offsetWidth; pip.classList.add("bump"); }
  lastCount = count;
  const pf = $("pipface");
  if (!pf.querySelector(".face-box")) pf.innerHTML = '<div class="face-box"><div class="anchor"></div></div>';
  const pipFace = s.tasks.length ? (TASK[s.tasks[0].kind] || TASK.code).working : s.quiet ? "asleep" : "heads-up";
  // Resting, the whole of her sits in the frame (herald.css #pip.rest):
  // centred, collar on the bottom edge. Otherwise her head peeks over the tag.
  const pf0 = FACES[pipFace] || FACES["heads-up"];
  const at = resting && pf0 ? [Math.round(pf0.ax * K1 + (62 - pf0.w * K1) / 2), Math.round(pf0.ay * K1 + (70 - pf0.h * K1))] : [20, 26];
  setFace(pf, pipFace, K1, at, false);

  $("legend").classList.toggle("on", focused && s.cards.some((c) => !c.resolved));
  if (drawerOpen) fillDrawer(s);
  report();
}

// The phone, as the drawer says it: whether Professional Goat has checked in
// and whether its notification listener has been heard. Words a person can
// act on, because "no notifications yet" and "the phone is not in reach" need
// different fixes.
function phoneWords(p) {
  if (!p) return ["", ""];
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  const recent = (t) => t && Date.now() - t < 2 * 60 * 1000;
  if (p.listener) return [recent(p.listener) || recent(p.page) ? "on" : "warn",
    `phone · notifications last heard ${ago(p.listener)} · ${p.showing} showing${p.outbox ? ` · ${p.outbox} replies waiting` : ""}`];
  if (recent(p.page)) return ["warn", "phone · Professional Goat is in reach, but no notification has come through yet — is notification access on?"];
  if (p.page) return ["warn", `phone · last heard ${ago(p.page)}; nothing from its notifications yet`];
  return ["", "phone · not heard from yet — open Professional Goat on the phone"];
}

function fillDrawer(s) {
  const d = $("drawer");
  d.hidden = false;
  const [lamp, words] = phoneWords(s.phone);
  $("phoneLine").className = "dphone " + lamp;
  $("phoneLine").innerHTML = words ? `<i></i><span>${esc(words)}</span>` : "";
  const rows = s.waiting.map((w) => `<div class="row" role="button" data-id="${esc(w.id)}" data-face="${esc(w.face || (KIND[w.kind] || KIND.look).face)}">
      <div class="portrait"><div class="face-box"><div class="anchor"></div></div></div>
      <div class="txt"><b>${esc(w.who || "Auri")}<i>${esc(w.chan || "")}</i></b><span>${esc(w.body)}</span></div></div>`).join("");
  const list = $("drawerList");
  list.innerHTML = (s.held ? `<h3>HELD FOR LATER · ${s.held}</h3>` : "")
    + `<h3>WAITING · ${s.waitingCount}${s.waitingCount ? '<button data-clear>CLEAR</button>' : ""}</h3>`
    + (rows || `<div class="empty">Nothing waiting. Auri has it.</div>`);
  for (const row of list.querySelectorAll(".row")) setFace(row.querySelector(".portrait"), row.dataset.face, K1, [26, 30], false);
}

// Ask Kenoma from the drawer: the turn becomes a task strip, so the drawer
// closes and gives the keyboard back as soon as it is asked.
$("ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = $("askIn").value.trim();
  if (!prompt) return;
  $("askIn").value = "";
  openDrawer(false);
  R.release();
  const r = await R.verb("ask", { prompt });
  if (r && r.error) { $("askIn").value = prompt; openDrawer(true); }
});

// A file dropped on her has nowhere to go; preventDefault on both events or
// Chromium navigates this view to the file.
document.addEventListener("dragover", (e) => { e.preventDefault(); });
document.addEventListener("drop", (e) => { e.preventDefault(); });
$("drawer").addEventListener("click", (e) => {
  if (e.target.closest("[data-clear]")) return R.act(null, "waiting", { do: "clear" });
  const row = e.target.closest(".row");
  if (row) R.act(null, "waiting", { do: "raise", id: row.dataset.id });
});
function openDrawer(on) {
  drawerOpen = on;
  $("drawer").hidden = !on;
  if (last) render(last);
  // Opened with nothing in front: the keys go to the ask box.
  if (on && !document.querySelector(".card.front:not(.resolved)")) setTimeout(() => $("askIn").focus(), 0);
}
$("pip").addEventListener("click", () => openDrawer(!drawerOpen));

// ---------------------------------------------------------------- size
// The view is exactly as tall as the column. Zero means hide it: an empty
// transparent view over the app is a dead patch nobody can click through.
// The width is the same rule sideways: with only the pip drawn (resting, or a
// count and nothing else) the view narrows to the pip, so the strip of app it
// would otherwise lie over stays clickable. Zero means the full column.
// A timer, not an animation frame: a page in a hidden or covered window runs
// no frames, and a measurement that waits for one never tells main how big to
// make the view -- and the view starts hidden. Reading the layout forces it,
// painted or not.
let lastH = -1, lastW = -1, reportQueued = false;
function report() {
  if (reportQueued) return;
  reportQueued = true;
  setTimeout(() => {
    reportQueued = false;
    const col = $("col");
    const cards = $("cards").childElementCount, tasks = $("tasks").childElementCount, legend = $("legend").classList.contains("on");
    const any = cards || tasks || !$("pip").hidden || drawerOpen || legend;
    const h = any ? Math.ceil(col.getBoundingClientRect().bottom + 26) : 0;
    const lone = h && !cards && !tasks && !drawerOpen && !legend;
    const pipRect = $("pip").getBoundingClientRect();
    const w = lone ? Math.ceil((window.innerWidth >= 40 ? window.innerWidth - pipRect.left : pipRect.width + 22) + 14) : 0;
    if (h !== lastH || w !== lastW) { lastH = h; lastW = w; R.bounds(h, w); }
  });
}
new ResizeObserver(report).observe($("col"));
window.addEventListener("resize", report);

// ---------------------------------------------------------------- keys
function frontCard() {
  for (const el of $("cards").children) if (el.classList.contains("front") && !el.classList.contains("out")) return el;
  return null;
}
function setFocused(on) {
  if (focused === on) return;
  focused = on;
  document.body.classList.toggle("focused", on);
  if (!on && drawerOpen) openDrawer(false);
  if (last) render(last);
}
window.addEventListener("focus", () => setFocused(true));
window.addEventListener("blur", () => setFocused(false));

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;   // the shell's own hotkeys
  const front = frontCard();
  if (e.target.matches && e.target.matches("input")) {
    if (e.key === "Escape" && e.target.id === "askIn") { e.preventDefault(); e.target.value = ""; openDrawer(false); R.release(); return; }
    if (e.key === "Escape") { e.preventDefault(); const el = e.target.closest(".card"); stopReplying(el); el.focus(); }
    return;   // Enter submits the form
  }
  if (e.key === "`") { e.preventDefault(); openDrawer(!drawerOpen); return; }
  if (!front || !front._c || front._c.resolved) {
    if (e.key === "Escape") { e.preventDefault(); if (drawerOpen) openDrawer(false); else R.release(); }
    return;
  }
  if (front._replying) {
    if (e.key === "Escape") { e.preventDefault(); stopReplying(front); }
    else if (e.key === "Enter") { e.preventDefault(); front.querySelector(".reply").requestSubmit(); }
    else front.querySelector(".reply input").focus();   // the key follows focus into the box
    return;
  }
  if (e.key === "Tab") { e.preventDefault(); R.act(null, "cycle"); return; }
  if (/^[1-4]$/.test(e.key) && front._c.choices && front._c.choices[Number(e.key) - 1]) {
    e.preventDefault();
    R.act(front._c.id, "choose", { index: Number(e.key) - 1 });
    return;
  }
  const key = e.key === "Escape" ? "Esc" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const act = front._c.acts.find((a) => ACT[a] && ACT[a][0] === key);
  if (act) { e.preventDefault(); doAct(front, act); }
  else if (e.key === "Escape") { e.preventDefault(); R.release(); }
});

// When the last thing she was holding is answered, give the keyboard back to
// the app you were in rather than leaving it parked on an empty corner.
setInterval(() => {
  if (focused && last && !drawerOpen && !last.cards.some((c) => !c.resolved) && !document.querySelector(".card.replying")) R.release();
}, 900);
setInterval(() => {
  if (!cardEls.size && !stripEls.size) return;
  for (const el of cardEls.values()) if (el._c) el.querySelector(".when").textContent = ago(el._c.t);
  for (const el of stripEls.values()) if (el._t) el.querySelector(".elapsed").textContent = clock(Date.now() - el._t.started);
}, 1000);

// ---------------------------------------------------------------- go
setScale();
R.on("herald", (s) => render(s));
R.on("herald-focus", (p) => {
  if (p && p.drawer) openDrawer(true);
  setFocused(!(p && p.on === false));
});
R.ready().then((s) => s && render(s));
