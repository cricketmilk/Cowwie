"use strict";
// The chat-box finder: the page-side script behind the `chat` verb.
//
// The Brain's relay drives four chat sites by a table of selectors, and that
// table is the first thing a redesign breaks. A chat box does not need a
// selector to be found: it is the editable thing near the bottom of the
// viewport, wide, with a send button or a placeholder that says "ask" or
// "message", and while the model is answering there is a stop button where
// the send button was. This scores every candidate on the page by those
// facts and returns a path to the best one -- plus whether the page is
// generating right now, which is what tells the caller the reply is done.
//
// Written as a real function and stringified (lib/distill.js explains why):
// self-contained, no closures, no requires; it runs in the page's world.

function chatbox(opts) {
  opts = opts || {};
  var vw = window.innerWidth || 1000, vh = window.innerHeight || 800;
  var WORDS = /ask|message|send|prompt|chat|type|question|talk|reply|write|search or ask/i;
  var STOP = /stop|cancel|generating|streaming/i;
  var SEND = /send|submit|go\b|ask|enter/i;

  function visible(el) {
    if (!el || !el.getClientRects || !el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < vh;
  }
  // A CSS path that document.querySelector can follow back to this node:
  // an id when one is there, else tag:nth-of-type up to the nearest id.
  function pathTo(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.id && /^[A-Za-z_][\w-]*$/.test(el.id)) { parts.unshift("#" + CSS.escape(el.id)); break; }
      var tag = el.tagName.toLowerCase(), i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
      parts.unshift(tag + ":nth-of-type(" + i + ")");
      el = el.parentElement;
    }
    return parts.join(" > ");
  }
  function label(el) {
    return [el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("data-placeholder"), el.getAttribute("title"), el.getAttribute("name"), el.id, el.className && String(el.className)].filter(Boolean).join(" ");
  }
  function buttonsNear(el) {
    // The send button is a sibling or a cousin. Walk up until the ancestor
    // holds a button (at most eight levels: Gemini nests its composer seven
    // deep inside the element that also holds Send), then keep the buttons
    // whose box is within reach of the composer's: level with it, or just
    // under it, and not far off to either side.
    var r = el.getBoundingClientRect(), out = [], root = el, up = 0;
    while (root.parentElement && up < 8) {
      root = root.parentElement; up++;
      if (up >= 3 && root.querySelector("button, [role=button], input[type=submit]")) break;
    }
    var bs = root.querySelectorAll("button, [role=button], input[type=submit]");
    for (var i = 0; i < bs.length && out.length < 16; i++) {
      var b = bs[i];
      if (!visible(b)) continue;
      var br = b.getBoundingClientRect();
      if (br.bottom < r.top - 60 || br.top > r.bottom + 120 || br.right < r.left - 160 || br.left > r.right + 240) continue;
      out.push(b);
    }
    return out;
  }
  // Last resort: anywhere on the page, a visible button that says it sends,
  // nearest the composer.
  function sendAnywhere(el) {
    var r = el.getBoundingClientRect(), best = null, bd = Infinity;
    var bs = document.querySelectorAll("button, [role=button], input[type=submit]");
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (!visible(b)) continue;
      var t = btnText(b);
      if (!/^(send|submit)\b|send message|send prompt/i.test(t) || STOP.test(t)) continue;
      var br = b.getBoundingClientRect();
      var d = Math.hypot((br.left + br.right) / 2 - (r.left + r.right) / 2, (br.top + br.bottom) / 2 - (r.top + r.bottom) / 2);
      if (d < bd) { bd = d; best = b; }
    }
    return bd < 600 ? best : null;
  }
  function btnText(b) { return (b.getAttribute("aria-label") || b.getAttribute("title") || b.getAttribute("data-testid") || b.textContent || "").replace(/\s+/g, " ").trim(); }

  // --- candidates -------------------------------------------------------------
  var cands = [];
  var els = document.querySelectorAll("textarea, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only'], input[type='text'], input:not([type])");
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!visible(el) || el.disabled || el.readOnly) continue;
    var r = el.getBoundingClientRect();
    var s = 0;
    s += Math.max(0, Math.min(1, r.width / (vw * 0.5))) * 3;          // wide
    s += r.top > vh * 0.5 ? 3 : r.top > vh * 0.25 ? 1 : 0;             // low on the page
    if (WORDS.test(label(el))) s += 3;
    if (el.tagName === "TEXTAREA" || el.isContentEditable) s += 1;
    if (el.tagName === "INPUT") s -= 1;                                  // a search field, usually
    if (/search/i.test(label(el)) && !/ask/i.test(label(el))) s -= 2;
    if (document.activeElement === el) s += 1;
    var near = buttonsNear(el), send = null, stop = null;
    // The form's own submit button is the send button when there is one;
    // a disabled stop button is the idle state, not generation.
    var form = el.closest ? el.closest("form") : null;
    var submit = form ? form.querySelector("button[type=submit], input[type=submit]") : null;
    if (submit && visible(submit)) send = submit;
    // A button that SAYS send beats one that merely carries an icon: a
    // microphone or an attach button is an svg in a button too.
    for (var k = 0; k < near.length; k++) {
      var t = btnText(near[k]);
      if (!stop && STOP.test(t) && !near[k].disabled && near[k].getAttribute("aria-disabled") !== "true") stop = near[k];
      if (!send && SEND.test(t) && !STOP.test(t) && !/microphone|voice|attach|upload|tools|mic\b/i.test(t)) send = near[k];
    }
    for (var k2 = 0; !send && k2 < near.length; k2++) {
      var t2 = btnText(near[k2]);
      if (near[k2].querySelector("svg") && t2.length < 24 && !STOP.test(t2) && !/microphone|voice|attach|upload|tools|mic\b|menu|more/i.test(t2)) send = near[k2];
    }
    if (!send) send = sendAnywhere(el);
    if (send) s += 2;
    cands.push({ el: el, score: s, send: send, stop: stop, rect: r });
  }
  cands.sort(function (a, b) { return b.score - a.score; });
  var best = cands[0] || null;

  // Generating: a stop button near the composer, or anywhere a button says
  // stop/generating, or an aria-busy region.
  var generating = false;
  if (best && best.stop) generating = true;
  if (!generating) {
    var all = document.querySelectorAll("button, [role=button]");
    for (var j = 0; j < all.length; j++) { if (visible(all[j]) && !all[j].disabled && all[j].getAttribute("aria-disabled") !== "true" && STOP.test(btnText(all[j])) && !/stopwatch|stop sharing|stop video/i.test(btnText(all[j]))) { generating = true; break; } }
  }
  if (!generating && document.querySelector("[aria-busy='true'], .result-streaming, [data-streaming='true']")) generating = true;

  return {
    composer: best ? { selector: pathTo(best.el), kind: best.el.isContentEditable ? "contenteditable" : best.el.tagName.toLowerCase(), label: label(best.el).slice(0, 120), score: best.score, width: Math.round(best.rect.width), top: Math.round(best.rect.top) } : null,
    send: best && best.send ? pathTo(best.send) : null,
    generating: generating,
    candidates: cands.length,
    host: location.hostname,
  };
}

function chatboxJs(opts) {
  return "(" + chatbox.toString() + ")(" + JSON.stringify(opts || {}) + ")";
}

module.exports = { chatbox, chatboxJs };
