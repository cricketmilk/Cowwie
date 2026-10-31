// The herald: Auri's cards, over the app area's top-right corner.
//
// Müt narrates; Auri asks. He lives bottom-right and says what the platform
// is doing in a line you can let go past. She holds the things that want a
// decision or are worth a glance — an approval, a question, a crash with a
// Restart on it, a task landing — as cards you answer from the keyboard. Two
// creatures because they are two jobs: a companion that also demanded
// answers would be a notification bell with a face.
//
// The queue lives here, in the main process, for the reason companion.js
// gives: it survives a renderer reload, it can be tested without a window,
// and the view (renderer/herald) only ever draws the state it is handed.
// Nothing in this file touches Electron; main.js hands it the effects.
//
// THE RULES. Each is the difference between a herald and a bell.
//   * The face is the meaning. One face, one thing, always — the renderer's
//     FACES table is the vocabulary, and a card only overrides it on purpose.
//   * Urgency is motion, not volume. Band 3 ("needs you") slams in and stays
//     until answered; band 2 slides in and leaves on its own; band 1 never
//     gets a card at all — it is a count on the pip and a row in the drawer.
//   * Ten pings about one thing are one card with x10 on it. At five it turns
//     into a pile-up, because at five nobody is reading them one by one.
//   * Three cards on screen at most. The oldest report steps back into the
//     drawer, unread, rather than off the edge of the window.
//   * While something that needs you is in front, nothing behind it times
//     out: you were busy answering, not ignoring them.
//   * Quiet hours: chatter is dropped on arrival, reports wait for a single
//     digest card, and only "needs you" gets through. companion.js's rule,
//     applied to cards.
//   * An app on the bus can tell her something; it cannot alarm you. Untrusted
//     senders are held to band 2, cannot raise an approval or a question, and
//     cannot put a button on a card that does more than open or dismiss it.
//     (mutHears has the same rule for Müt, for the same reason.)
//
// TASKS are the other half. A task is a strip, not a card: it shows what is
// being worked on (Auri at her easel, at the keyboard, with the quill, in the
// vortex), moves a pixel or two while it runs, and when it lands it turns
// into a completion card with the finished drawing. A strip never takes the
// keyboard and never counts against the three cards.

const MAX_CARDS = 3;
const REPORT_LIFE = 8000;
const DONE_LIFE = 9000;
const RESOLVE_MS = 1400;        // long enough to read "ALLOWED", short enough not to linger
const PILEUP = 5;
const WAITING_MAX = 60;
const TASK_STALE_MS = 20 * 60 * 1000;   // a task nobody has updated in 20 min was abandoned
const MUTE_MS = 60 * 60 * 1000;
const LATER_MS = 10 * 60 * 1000;

const KINDS = new Set([
  "message", "approval", "question", "done", "error", "missed", "pileup", "digest",
  "look", "call", "love", "hello", "blocked", "offline", "task-done", "task-failed",
]);
const TASK_KINDS = new Set(["art", "code", "write", "research"]);
const ACTS = new Set([
  "reply", "answer", "choose", "open", "later", "dismiss", "allow", "always", "deny",
  "retry", "logs", "stop", "mute", "callback", "restart",
]);
// What an untrusted sender may put on a card. Everything else does something.
const SAFE_ACTS = new Set(["open", "later", "dismiss", "mute"]);
// Only main.js's own code may ask a person to approve something, because only
// it can carry the answer back to whoever asked.
const INTERNAL_KINDS = new Set(["approval", "question"]);

const DONE_TAG = { art: "FINISHED", code: "DONE", write: "WRITTEN", research: "FOUND IT" };

// What a card says in the moment after you answer it, before it leaves.
// A handler can return its own; these are the defaults.
const RESOLVED = {
  allow:    { face: "done", tag: "ALLOWED", body: "Running it now." },
  always:   { face: "done", tag: "ALWAYS", body: "Allowed, and remembered." },
  deny:     { face: "heads-up", tag: "DENIED", body: "Nothing ran." },
  open:     { face: "wink", tag: "OPENING", body: "" },
  retry:    { face: "joy", tag: "RESTARTING", body: "Starting it again." },
  restart:  { face: "wave", tag: "RESTARTING", body: "Back in a moment." },
  logs:     { face: "wink", tag: "LOGS", body: "Opened the log drawer." },
  stop:     { face: "asleep", tag: "STOPPED", body: "Put it down." },
  callback: { face: "call", tag: "CALLING", body: "" },
};

const str = (v, n) => (v === undefined || v === null ? "" : String(v)).replace(/\s+/g, " ").trim().slice(0, n);

class Herald {
  /**
   * @param {object} o
   * @param {(state:object)=>void} [o.emit]   every change, the whole state
   * @param {object} [o.handlers]  action -> async (card, payload) => result
   * @param {()=>boolean} [o.isQuiet]  quiet hours, read on every arrival
   * @param {()=>number} [o.now]
   */
  constructor({ emit = () => {}, handlers = {}, isQuiet = () => false, now = () => Date.now() } = {}) {
    this.emit = emit;
    this.handlers = handlers;
    this.isQuiet = isQuiet;
    this.now = now;
    this.cards = [];            // front first
    this.tasks = new Map();     // id -> task
    this.waiting = [];          // unread, newest first: the drawer
    this.held = [];             // reports that arrived in quiet hours
    this.muted = new Map();     // key -> until
    this.later = [];            // [{ at, item }]
    this.hover = null;
    this.wasQuiet = !!isQuiet();
    this.lastTick = now();
    this.seq = 0;
  }

  // ------------------------------------------------------------ arrivals

  /** A card. Returns its id, or null when it went to the drawer or nowhere. */
  notify(input, { trusted = true, internal = false } = {}) {
    const it = this._clean(input, trusted, internal);
    if (!it) return null;
    const now = this.now();
    if (it.key && (this.muted.get(it.key) || 0) > now) { this._wait(it); return this._changed(null); }
    const same = it.key ? this.cards.find((c) => c.key === it.key && !c.resolved) : null;
    if (same && it.once) return same.id;
    if (this.isQuiet() && it.band < 3) {
      if (it.band >= 2) this.held.push(it);
      return this._changed(null);
    }
    if (it.band <= 1) { this._wait(it); return this._changed(null); }
    if (same) return this._collapse(same, it);

    const card = { ...it, id: "h" + (++this.seq).toString(36), t: now, count: 1,
      remaining: it.band === 2 ? it.life : null, held: false, resolved: null, busy: false, replying: false };
    this._insert(card);
    this._trim();
    return this._changed(card.id);
  }

  /** A task's progress. state: working | done | failed | stopped. */
  task(u, { trusted = true } = {}) {
    const id = str(u && u.id, 80);
    if (!id) return null;
    const now = this.now();
    const state = ["done", "failed", "stopped"].includes(u.state) ? u.state : "working";
    let t = this.tasks.get(id);
    if (state === "working") {
      if (!t) {
        t = { id, kind: "code", who: "", title: "", step: "", progress: null, started: now, updated: now, target: null };
        this.tasks.set(id, t);
      }
      if (TASK_KINDS.has(u.kind)) t.kind = u.kind;
      if (u.who !== undefined) t.who = str(u.who, 40);
      if (u.title !== undefined) t.title = str(u.title, 80);
      if (u.step !== undefined) t.step = str(u.step, 120);
      if (u.progress === null || (typeof u.progress === "number" && u.progress >= 0 && u.progress <= 1)) t.progress = u.progress;
      if (u.target) t.target = this._target(u.target);
      t.updated = now;
      this._changed();
      return t;
    }
    if (t) this.tasks.delete(id);
    if (state === "stopped") { this._changed(); return null; }
    const kind = TASK_KINDS.has(u.kind) ? u.kind : (t ? t.kind : "code");
    const done = state === "done";
    const target = u.target ? this._target(u.target) : (t && t.target);
    return this.notify({
      kind: done ? "task-done" : "task-failed",
      band: 2,
      face: done ? `${kind}-done` : "hurt",
      tag: u.tag || (done ? DONE_TAG[kind] : "DIDN'T LAND"),
      who: u.who || (t && t.who) || "",
      chan: u.chan || (t && t.title) || "",
      body: u.summary || (t && t.step) || "",
      key: `task:${id}`,
      fromTask: id,
      taskKind: kind,
      life: DONE_LIFE,
      target,
      acts: target ? ["open", "dismiss"] : ["dismiss"],
    }, { trusted });
  }

  // ------------------------------------------------------------ answers

  async act(id, action, payload = {}) {
    // The view's own bookkeeping first: none of these answer anything.
    if (action === "hover") {
      this.hover = payload.on ? id : (this.hover === id ? null : this.hover);
      return this._changed({ ok: true });
    }
    if (action === "cycle") {
      const live = this.cards.filter((c) => !c.resolved);
      if (live.length > 1) { this.cards = this.cards.filter((c) => c !== live[0]); this.cards.push(live[0]); }
      return this._changed({ ok: true });
    }
    if (action === "waiting") return this._waitingAct(payload);

    const card = this.cards.find((c) => c.id === id);
    if (!card || card.resolved) return { ok: false, error: "that card is gone" };
    if (action === "front") {
      this.cards = [card, ...this.cards.filter((c) => c !== card)];
      return this._changed({ ok: true });
    }
    if (action === "replying") { card.replying = !!payload.on; return this._changed({ ok: true }); }
    if (!card.acts.includes(action) && !(action === "choose" && card.choices)) return { ok: false, error: `"${action}" is not on this card` };

    if (action === "dismiss") { this._remove(card); return this._changed({ ok: true }); }
    if (action === "later") {
      this.later.push({ at: this.now() + LATER_MS, item: this._again(card) });
      return this._resolve(card, { face: "asleep", tag: "LATER", body: "Back in ten minutes." });
    }
    if (action === "mute") {
      if (card.key) this.muted.set(card.key, this.now() + MUTE_MS);
      return this._resolve(card, { face: "asleep", tag: "MUTED 1H", body: "The rest go in the drawer." });
    }

    const h = this.handlers[action];
    if (!h) return { ok: false, error: `nothing handles "${action}"` };
    card.busy = true;
    this._changed();
    let r;
    try { r = await h(card, payload); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    card.busy = false;
    if (!this.cards.includes(card)) return r || { ok: true };   // answered elsewhere while we waited
    if (r && r.ok === false) {
      return this._resolve(card, { face: "hurt", tag: "DIDN'T WORK", body: str(r.error || "it failed", 140) }, r);
    }
    // Opening an approval shows you where it came from; it does not answer it.
    if (r && r.keep) return this._changed(r);
    const text = str(payload.text || (card.choices && card.choices[payload.index]) || "", 120);
    const said = action === "reply" ? { face: "delivered", tag: "SENT", body: "↳ " + text }
      : action === "answer" || action === "choose" ? { face: "delivered", tag: "ANSWERED", body: "↳ " + text }
      : RESOLVED[action] || { face: "done", tag: "DONE", body: "" };
    return this._resolve(card, { ...said, ...((r && r.resolved) || {}) }, r);
  }

  /** Something answered elsewhere (the phone, the cockpit): the card goes. */
  settle(key, resolved = { face: "wink", tag: "ANSWERED ELSEWHERE", body: "" }) {
    const card = this.cards.find((c) => c.key === key && !c.resolved);
    if (card) this._resolve(card, resolved);
    return !!card;
  }

  has(key) { return this.cards.some((c) => c.key === key && !c.resolved); }

  keys(prefix) { return this.cards.filter((c) => !c.resolved && c.key && c.key.startsWith(prefix)).map((c) => c.key); }

  // ------------------------------------------------------------ time

  /** Timers, quiet hours, stale tasks. main.js calls it four times a second. */
  tick() {
    const now = this.now();
    const dt = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    let changed = false;

    const quiet = !!this.isQuiet();
    if (this.wasQuiet && !quiet && this.held.length) { this._digest(); changed = true; }
    if (quiet !== this.wasQuiet) { this.wasQuiet = quiet; changed = true; }
    if (!this.cards.length && !this.tasks.size && !this.later.length && !this.muted.size) {
      if (changed) this._changed();
      return;
    }

    const live = this.cards.filter((c) => !c.resolved);
    const front = live[0];
    const busy = !!front && (front.band >= 3 || front.replying);
    for (const c of live) {
      if (c.band !== 2) continue;
      const held = (busy && c !== front) || c.id === this.hover || c.replying || c.busy;
      if (held !== c.held) { c.held = held; changed = true; }
      if (held) continue;
      c.remaining -= dt;
      if (c.remaining <= 0) { this._remove(c); this._wait(c); changed = true; }
    }
    for (const c of this.cards.filter((x) => x.resolved && now >= x.resolved.until)) { this._remove(c); changed = true; }
    for (const [id, t] of this.tasks) if (now - t.updated > TASK_STALE_MS) { this.tasks.delete(id); changed = true; }
    for (const [k, until] of this.muted) if (until <= now) this.muted.delete(k);
    const due = this.later.filter((l) => l.at <= now);
    if (due.length) {
      this.later = this.later.filter((l) => l.at > now);
      for (const l of due) this.notify({ ...l.item, tag: "BACK AGAIN" }, { trusted: true, internal: true });
    }
    if (changed) this._changed();
  }

  state() {
    return {
      cards: this.cards.map((c) => ({
        id: c.id, kind: c.kind, band: c.band, face: c.face || null, tag: c.tag || null,
        who: c.who, chan: c.chan, body: c.body, cmd: c.cmd || null, choices: c.choices || null,
        acts: c.acts, count: c.count, pileup: !!c.pileup, t: c.t, life: c.life || null,
        remaining: c.remaining, held: !!c.held, busy: c.busy, replying: c.replying,
        fromTask: c.fromTask || null, taskKind: c.taskKind || null, source: c.source,
        resolved: c.resolved ? { face: c.resolved.face, tag: c.resolved.tag, body: c.resolved.body } : null,
      })),
      tasks: [...this.tasks.values()].sort((a, b) => a.started - b.started)
        .map((t) => ({ id: t.id, kind: t.kind, who: t.who, title: t.title, step: t.step, progress: t.progress, started: t.started })),
      waiting: this.waiting.slice(0, 20).map((w) => ({ id: w.wid, kind: w.kind, face: w.face || null, who: w.who, chan: w.chan, body: w.body, t: w.t })),
      waitingCount: this.waiting.length,
      held: this.held.length,
      quiet: this.wasQuiet,
    };
  }

  // ------------------------------------------------------------ inside

  _clean(input, trusted, internal) {
    if (!input || typeof input !== "object") return null;
    let kind = KINDS.has(input.kind) ? input.kind : "look";
    if (!internal && INTERNAL_KINDS.has(kind)) kind = "look";
    let band = Number.isInteger(input.band) ? Math.max(1, Math.min(3, input.band)) : 2;
    if (!trusted) band = Math.min(band, 2);
    const target = input.target ? this._target(input.target) : null;
    let acts = Array.isArray(input.acts) ? input.acts.filter((a) => ACTS.has(a)) : null;
    if (!internal) acts = acts && acts.filter((a) => a !== "allow" && a !== "always" && a !== "deny" && a !== "answer" && a !== "choose" && a !== "stop");
    if (!trusted) acts = acts && acts.filter((a) => SAFE_ACTS.has(a));
    if (!acts || !acts.length) acts = target ? ["open", "dismiss"] : ["dismiss"];
    const choices = internal && Array.isArray(input.choices)
      ? input.choices.map((c) => str(c, 40)).filter(Boolean).slice(0, 4) : null;
    return {
      kind, band, acts, target,
      key: input.key ? str(input.key, 120) : null,
      once: !!input.once,
      face: /^[a-z][a-z-]{1,30}$/.test(input.face || "") ? input.face : null,
      tag: input.tag ? str(input.tag, 24).toUpperCase() : null,
      who: str(input.who, 40),
      chan: str(input.chan, 48),
      body: str(input.body, 280),
      cmd: input.cmd ? str(input.cmd, 200) : null,
      choices: choices && choices.length ? choices : null,
      life: Number.isFinite(input.life) ? Math.max(3000, Math.min(60000, input.life)) : REPORT_LIFE,
      fromTask: input.fromTask ? str(input.fromTask, 80) : null,
      taskKind: TASK_KINDS.has(input.taskKind) ? input.taskKind : null,
      meta: internal && input.meta && typeof input.meta === "object" ? input.meta : null,
      source: internal ? "shell" : trusted ? "local" : "app",
    };
  }

  _target(t) {
    if (!t || typeof t !== "object") return null;
    const out = {};
    if (t.app) out.app = str(t.app, 64);
    if (t.url && /^https?:\/\//i.test(String(t.url))) out.url = String(t.url).slice(0, 2000);
    if (t.forge) out.forge = str(t.forge, 64);
    return Object.keys(out).length ? out : null;
  }

  _insert(card) {
    // A report never pushes in front of something that needs you.
    if (card.band >= 3) { this.cards.unshift(card); return; }
    let i = 0;
    while (i < this.cards.length && this.cards[i].band >= 3 && !this.cards[i].resolved) i++;
    this.cards.splice(i, 0, card);
  }

  _collapse(card, it) {
    card.count += 1;
    card.body = it.body || card.body;
    // The newest message's handle, so a reply goes to the notification the
    // phone is showing now rather than the first one, which may be gone.
    if (it.meta) card.meta = it.meta;
    card.t = this.now();
    if (card.band === 2) card.remaining = card.life;
    if (card.count >= PILEUP && !card.pileup) {
      card.pileup = true;
      card.face = "overwhelmed";
      card.tag = "PILE-UP";
    }
    // To the front of its band, so the newest thing you heard is the one you see.
    this.cards = this.cards.filter((c) => c !== card);
    this._insert(card);
    return this._changed(card.id);
  }

  _trim() {
    let live = this.cards.filter((c) => !c.resolved);
    while (live.length > MAX_CARDS) {
      const oldest = [...live].reverse().find((c) => c.band < 3);
      if (!oldest) break;
      this._remove(oldest);
      this._wait(oldest);
      live = this.cards.filter((c) => !c.resolved);
    }
  }

  _wait(it) {
    this.waiting.unshift({ ...it, wid: "w" + (++this.seq).toString(36), t: it.t || this.now() });
    if (this.waiting.length > WAITING_MAX) this.waiting.length = WAITING_MAX;
  }

  _waitingAct(p) {
    if (p.do === "clear") { this.waiting = []; return this._changed({ ok: true }); }
    if (p.do === "raise") {
      const w = this.waiting.find((x) => x.wid === p.id);
      if (!w) return { ok: false, error: "gone" };
      this.waiting = this.waiting.filter((x) => x !== w);
      const id = this.notify({ ...this._again(w), band: Math.max(2, Math.min(w.band || 2, 2)) }, { trusted: true, internal: w.source === "shell" });
      return this._changed({ ok: true, id });
    }
    return { ok: false, error: "unknown" };
  }

  _again(c) {
    const { kind, band, acts, target, key, face, tag, who, chan, body, cmd, choices, life, meta, fromTask, taskKind } = c;
    return { kind, band, acts, target, key, face: c.pileup ? null : face, tag: c.pileup ? null : tag, who, chan, body, cmd, choices, life, meta, fromTask, taskKind };
  }

  _digest() {
    const n = this.held.length;
    const who = [...new Set(this.held.map((h) => h.who).filter(Boolean))].slice(0, 3).join(", ");
    for (const h of this.held) this._wait(h);
    this.held = [];
    this.notify({
      kind: "digest", band: 2, life: 15000, who: "Auri", chan: "while you were out",
      body: `${n} held while you were heads-down${who ? ": " + who : ""}.`,
      acts: ["dismiss"],
    }, { trusted: true, internal: true });
  }

  _resolve(card, res, r) {
    card.resolved = { ...res, until: this.now() + RESOLVE_MS };
    card.replying = false;
    return this._changed(r || { ok: true });
  }

  _remove(card) {
    this.cards = this.cards.filter((c) => c !== card);
    if (this.hover === card.id) this.hover = null;
  }

  _changed(ret) {
    try { this.emit(this.state()); } catch {}
    return ret;
  }
}

module.exports = { Herald, MAX_CARDS, PILEUP, REPORT_LIFE, RESOLVE_MS, LATER_MS, MUTE_MS, TASK_STALE_MS };
