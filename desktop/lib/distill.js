"use strict";
// The Wilds' content condenser: the page-side script behind `wilds_read`.
//
// `innerText` of <main> (or <body>) was the whole reader for a long time, and
// on a real site that is mostly furniture: the header's link soup, the cookie
// notice, three "related" sidebars, the footer's legal paragraph, a newsletter
// modal. An agent paid for every character of it, on every read, and the
// furniture is also where injection text likes to hide — a disclaimer nobody
// reads, a display:none div, a zero-point span. This strips the furniture in
// the page and emits markdown-shaped text, which both cuts the bill and
// removes most of the places a page can whisper to the model.
//
// Written as a real function and stringified, not as a template string: the
// regexes and quotes in here would need double escaping as a string literal,
// and a function Node can parse is a function Node can syntax-check. It must
// stay SELF-CONTAINED — no closures over this module, no requires — because it
// runs in the page's world via executeJavaScript, where none of that exists.
//
// It is pure JS by design. Readability.js is a dependency, and lib/ carries
// none; the scorer below is the part of that algorithm that earns its keep.

function distill(opts) {
  opts = opts || {};
  var WANT_LINKS = !!opts.links;
  var NODE_BUDGET = 60000;   // a hostile page with a million spans ends, not hangs
  var visited = 0;

  // --- what is furniture -----------------------------------------------------
  var DROP_TAGS = {
    script: 1, style: 1, noscript: 1, template: 1, svg: 1, canvas: 1, iframe: 1,
    object: 1, embed: 1, video: 1, audio: 1, map: 1, link: 1, meta: 1, head: 1,
    nav: 1, header: 1, footer: 1, aside: 1, dialog: 1, menu: 1, button: 1, select: 1, option: 1, textarea: 1,
  };
  var DROP_ROLES = {
    navigation: 1, banner: 1, contentinfo: 1, complementary: 1, dialog: 1, alertdialog: 1,
    menu: 1, menubar: 1, toolbar: 1, search: 1, tooltip: 1, alert: 1, status: 1,
  };
  // Readability's "unlikely candidates", trimmed. Applied to id+class, and only
  // to containers that are link-heavy or short — a real article wrapped in
  // <div class="comment-free-sidebar-killer"> keeps its text.
  var UNLIKELY = /cookie|consent|gdpr|banner|popup|pop-up|modal|overlay|lightbox|sidebar|side-bar|widget|advert|^ad-|-ad-|_ad_|\bads?\b|sponsor|promo|newsletter|subscribe|signup|sign-up|share|social|comment|disqus|related|recommend|breadcrumb|menu|navbar|nav-|toolbar|footer|header|masthead|skip-link|sr-only|visually-hidden|tracking|paywall|teaser|outbrain|taboola/i;
  var SKIP_INLINE = /^(b|strong|i|em|u|s|span|small|mark|abbr|cite|q|sub|sup|time|font|label|a|code|kbd|var|samp|del|ins|wbr|bdi|bdo|data|dfn|output|ruby|rt|rp)$/;

  function tagOf(el) { return (el.tagName || "").toLowerCase(); }

  // Hidden is hidden however it was done. Text a person cannot see is text
  // the agent should not be reading as the page's content — that is the
  // injection surface, and it is also what innerText already skipped for
  // display:none. We go further than innerText: zero font, zero opacity, and
  // the clip-rect trick all count as hidden.
  function hidden(el) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    var cs;
    try { cs = getComputedStyle(el); } catch (e) { return false; }
    if (!cs) return false;
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return true;
    if (cs.opacity === "0") return true;
    if (parseFloat(cs.fontSize) === 0) return true;
    if (cs.position === "absolute" || cs.position === "fixed") {
      // the 1px clip rect, and the "left: -9999px" family
      var w = parseFloat(cs.width), h = parseFloat(cs.height);
      if ((w <= 1 && h <= 1) || /rect\(\s*0(px)?[, ]\s*0(px)?[, ]\s*0(px)?[, ]\s*0(px)?\s*\)/.test(cs.clip || "")) return true;
      var left = parseFloat(cs.left), top = parseFloat(cs.top);
      if (left < -2000 || top < -2000) return true;
    }
    return false;
  }

  function textLen(el) { return ((el.textContent || "").replace(/\s+/g, " ").trim()).length; }
  function linkDensity(el) {
    var total = textLen(el);
    if (!total) return 0;
    var links = 0, as = el.getElementsByTagName("a");
    for (var i = 0; i < as.length; i++) links += textLen(as[i]);
    return links / total;
  }
  function unlikely(el) {
    var key = ((el.id || "") + " " + (typeof el.className === "string" ? el.className : "")).trim();
    if (!key || !UNLIKELY.test(key)) return false;
    // The class says furniture; let the content overrule it if it looks like
    // content. Short or link-heavy and it goes.
    return textLen(el) < 400 || linkDensity(el) > 0.4;
  }
  function furniture(el) {
    var t = tagOf(el);
    // <article><header><h1>…</h1><p class=byline>…</p></header> is the title,
    // not the site's masthead: a header that carries a heading and is not
    // mostly links stays. The page-level one is link soup and goes.
    if (t === "header") return !(el.querySelector("h1,h2,h3") && linkDensity(el) < 0.5);
    if (DROP_TAGS[t]) return true;
    var role = (el.getAttribute("role") || "").toLowerCase();
    if (role && DROP_ROLES[role]) return true;
    if (el.getAttribute("contenteditable") === "true") return false;
    return unlikely(el);
  }

  // --- where the content is ---------------------------------------------------
  // Landmarks first: a page that declared its main region gets believed. With
  // several, the one with the most text. Without any, Readability's trick:
  // every paragraph hands points to its parent and half to its grandparent,
  // and the ancestor that collected the most, discounted by link density, is
  // the article.
  function root() {
    var marked = document.querySelectorAll("main, article, [role='main']");
    var best = null, bestLen = 0;
    for (var i = 0; i < marked.length; i++) {
      var L = textLen(marked[i]);
      if (L > bestLen) { best = marked[i]; bestLen = L; }
    }
    if (best && bestLen >= 200) return best;

    var scores = new Map();
    var paras = document.body.querySelectorAll("p, pre, td, li, blockquote, h1, h2, h3, dd, figcaption");
    for (var j = 0; j < paras.length && j < 5000; j++) {
      var p = paras[j];
      var txt = (p.textContent || "").replace(/\s+/g, " ").trim();
      if (txt.length < 25) continue;
      var pts = 1 + Math.min(3, Math.floor(txt.length / 100)) + (txt.split(",").length - 1);
      var par = p.parentElement, gp = par && par.parentElement;
      if (par) scores.set(par, (scores.get(par) || 0) + pts);
      if (gp) scores.set(gp, (scores.get(gp) || 0) + pts / 2);
    }
    var top = null, topScore = 0;
    scores.forEach(function (s, el) {
      if (furniture(el)) return;
      var adj = s * (1 - linkDensity(el));
      if (adj > topScore) { top = el; topScore = adj; }
    });
    if (!top) return best || document.body;
    // Climb while the parent is not much bigger: the heading above the article
    // body usually sits in the parent, and the whole page sits two above.
    var cur = top, curLen = textLen(cur);
    while (cur.parentElement && cur.parentElement !== document.body) {
      var pl = textLen(cur.parentElement);
      if (pl > curLen * 1.5 + 200) break;
      cur = cur.parentElement; curLen = pl;
    }
    return cur;
  }

  // --- serialising to markdown --------------------------------------------------
  var out = [];                 // blocks, joined by blank lines at the end
  var line = "";                // the inline run being built
  function flush() {
    var s = line.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
    if (s) out.push(s);
    line = "";
  }
  function inline(s) {
    if (!s) return;
    if (line && !/\s$/.test(line) && !/^\s/.test(s) && !/^[,.;:!?)\]]/.test(s)) line += " ";
    line += s;
  }

  function href(a) {
    var h = a.getAttribute("href") || "";
    if (!/^https?:/i.test(h)) { try { h = new URL(h, location.href).href; } catch (e) { return ""; } }
    return /^https?:/i.test(h) ? h : "";
  }

  function codeText(el) {
    var t = el.innerText != null ? el.innerText : el.textContent;
    return (t || "").replace(/\s+$/, "");
  }

  function table(el) {
    flush();
    var rows = [];
    var trs = el.querySelectorAll("tr");
    for (var i = 0; i < trs.length && i < 200; i++) {
      if (hidden(trs[i])) continue;
      var cells = trs[i].children, row = [];
      for (var j = 0; j < cells.length; j++) {
        var tg = tagOf(cells[j]);
        if (tg !== "td" && tg !== "th") continue;
        row.push((cells[j].innerText || cells[j].textContent || "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim());
      }
      if (row.length) rows.push(row);
    }
    if (!rows.length) return;
    var width = 0;
    for (var r = 0; r < rows.length; r++) width = Math.max(width, rows[r].length);
    var md = [];
    for (var k = 0; k < rows.length; k++) {
      var cells2 = rows[k].slice();
      while (cells2.length < width) cells2.push("");
      md.push("| " + cells2.join(" | ") + " |");
      if (k === 0) md.push("|" + cells2.map(function () { return " --- |"; }).join(""));
    }
    out.push(md.join("\n"));
  }

  function list(el, depth) {
    flush();
    var ordered = tagOf(el) === "ol";
    var n = 0, items = [];
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (tagOf(c) !== "li" || hidden(c)) continue;
      n++;
      var saveOut = out, saveLine = line;
      out = []; line = "";
      walk(c, depth + 1, true);
      flush();
      var body = out.join("\n").split("\n").map(function (l, i) { return i ? "  " + l : l; }).join("\n");
      out = saveOut; line = saveLine;
      if (body) items.push((ordered ? n + ". " : "- ") + body);
    }
    if (items.length) out.push(items.join("\n"));
  }

  function walk(el, depth, inLi) {
    if (++visited > NODE_BUDGET) return;
    for (var node = el.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 3) { inline(node.nodeValue.replace(/\s+/g, " ")); continue; }
      if (node.nodeType !== 1) continue;
      var t = tagOf(node);
      if (furniture(node) || hidden(node)) continue;

      if (/^h[1-6]$/.test(t)) {
        flush();
        var ht = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        if (ht) out.push("#".repeat(+t[1]) + " " + ht);
        continue;
      }
      if (t === "pre") { flush(); var code = codeText(node); if (code.trim()) out.push("```\n" + code + "\n```"); continue; }
      if (t === "code") { inline("`" + (node.textContent || "").replace(/\s+/g, " ").trim() + "`"); continue; }
      if (t === "ul" || t === "ol") { list(node, depth); continue; }
      if (t === "table") { table(node); continue; }
      if (t === "br") { line += "\n"; continue; }
      if (t === "hr") { flush(); out.push("---"); continue; }
      if (t === "img") {
        var alt = (node.getAttribute("alt") || "").trim();
        if (alt && alt.length > 2 && !/^(image|photo|picture|icon|logo)$/i.test(alt)) inline("[image: " + alt + "]");
        continue;
      }
      if (t === "input") {
        var ty = (node.getAttribute("type") || "text").toLowerCase();
        if (/^(hidden|submit|button|image|reset)$/.test(ty)) continue;
        var ph = node.getAttribute("placeholder") || node.getAttribute("aria-label") || node.name || ty;
        inline("[" + ty + ": " + ph + (node.value ? " = " + node.value : "") + "]");
        continue;
      }
      if (t === "a") {
        var label = (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
        if (!label) continue;
        var h = WANT_LINKS ? href(node) : "";
        inline(h ? "[" + label + "](" + h + ")" : label);
        continue;
      }
      if (t === "blockquote") {
        flush();
        var saveOut = out, saveLine = line; out = []; line = "";
        walk(node, depth + 1, inLi); flush();
        var q = out.join("\n\n").split("\n").map(function (l) { return "> " + l; }).join("\n");
        out = saveOut; line = saveLine;
        if (q.trim()) out.push(q);
        continue;
      }
      if (SKIP_INLINE.test(t)) { walk(node, depth + 1, inLi); continue; }
      // Anything else is a block: paragraph break around it.
      flush();
      walk(node, depth + 1, inLi);
      flush();
    }
  }

  var r = root();
  walk(r, 0, false);
  flush();

  var md = out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  // What innerText would have given, for the fallback decision and so the
  // caller can say what the distillation saved.
  var whole = document.querySelector("main, article, [role='main']") || document.body;
  var plain = (whole.innerText || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: md, rawChars: plain.length, root: tagOf(r) + (r.id ? "#" + r.id : ""), budget: visited > NODE_BUDGET };
}

// The script for executeJavaScript. `opts.links` includes http(s) hrefs as
// markdown links; off by default because an agent that wants to navigate has
// wilds_outline, and link soup is most of what we are here to remove.
function distillJs(opts) {
  return "(" + distill.toString() + ")(" + JSON.stringify(opts || {}) + ")";
}

module.exports = { distill, distillJs };
