// Müt — the shell's familiar.
//
// He lives in the rail, but his mind lives here. Keeping the queue in the main
// process is what lets him survive a renderer reload, know things while the
// screen is locked, and be promoted to his own window later without a rewrite.
//
// The rules below exist because the obvious version of a desktop companion is
// unbearable within a day. Specifically:
//
//   * A second message must not stomp the first. It waits its turn, and an
//     interrupted message goes back to the FRONT of its own band rather than
//     to the floor — so being interrupted costs it nothing.
//   * Ten status pings about one app are one thing that happened, not ten.
//     Messages carry a `key` and collapse onto it.
//   * A message that could not be shown in time expires UNSHOWN. Reading out
//     an hour-old event is worse than silence.
//   * While he is asleep or in quiet hours, chatter (priority <= 1) is dropped
//     on arrival rather than accumulated. Only real news survives into the
//     digest, which is what stops "here's what you missed" from being 200
//     lines of nothing.
//
// That last rule is the difference between a companion and a notification bell.

const BANDS = 4;                 // 0 flavour · 1 ambient · 2 report · 3 needs you
const MAX_PER_BAND = 8;
const DEFAULT_TTL = 5 * 60 * 1000;
const MIN_SHOW_MS = 3200;        // he does not flicker between sentences
const READ_MS_PER_CHAR = 45;

// Scripted lines. Deliberately the default: an LLM call in the event path
// means a three-second stall before he reacts, which is how a companion turns
// into furniture you switch off. The Brain can be asked on demand instead.
const LINES = {
  greet: [
    "The candle's lit.",
    "Everything's where you left it.",
    "Ready when you are.",
  ],
  "clip.added": [
    "Filed it. Hash and source went with it.",
    "Kept. You can find that again.",
    "In the Trove, with where it came from.",
  ],
  "capture.started": ["Recording. I'll keep count."],
  "capture.stopped": ["Capture's closed. The tail got flushed."],
  "app.started": ["That one's up."],
  "app.exited": ["It exited on its own. Logs are in the drawer."],
  "app.hibernated": ["Put it to rest. Its logins kept."],
  crash: [
    "It died on its own — that's worth a look.",
    "Server's gone. Ctrl+L for what it said last.",
  ],
  fanout: ["That hand-off failed. The clip is safe either way."],
  verdict: ["The Brain wants a verdict from you."],
  idle: [
    "Quiet.",
    "Still here.",
    "The wax is holding.",
    "Nothing's on fire.",
  ],
  woke: ["You're back."],
  // The wire: he spoke on a live site through its mascot (lib/wire.js).
  wire: ["Sent through Maizey.", "She has it.", "Speaking through the corn now."],
  "wire.fail": ["The wire's down — nothing reached her.", "Couldn't reach the site. Nothing was said."],
  // Things the shell does that he notices (main.js mutSees / MUT_EVENTS).
  "app.error": ["That one wouldn't load.", "It didn't open. The drawer has what it said."],
  "app.stopped": ["Stopped it. The view's still warm."],
  scan: ["Walking the folder.", "Mapping what's in there."],
  // No "scan.done" here on purpose: main.js says it with the count included
  // ("Mapped it — 4 things in there."), which is strictly better than a bare
  // line, so this entry was dead copy pretending to be vocabulary.
  memory: ["Heavy. Something's eating memory — rest an app.", "The shell is carrying too much."],
  "memory.ok": ["Lighter again."],
  poke: ["Hm?", "Still here.", "That tickles.", "Yes?"],
  // What he says when he picks up a task on his own (ambient, priority 0).
  "task-query": ["Counting the catches."],
  "task-debug": ["Reading the logs."],
  "task-network": ["Listening on the wire."],
  "task-map": ["Mapping the network."],
  "task-glyphs": ["Decoding glyphs."],
  "task-research": ["Reading."],
  "task-execute": ["Digging."],
  // Glamourwell, the desktop's GPU (shell lib/glamourwell.js). These reach the
  // phone and the node too, since both copy this file.
  "node.online": ["The desktop's awake.", "Glamourwell's on the wire.", "The big card is listening."],
  "node.console": ["The node gave me a console. It's a tile now.", "Glamourwell has a face. Open the tile."],
  "node.offline": ["Lost the desktop.", "The node went quiet.", "I'll work on the small card for now."],
  "node.busy": ["Rendering on the big card.", "The desktop's working on it."],
  "node.done": ["Back from the desktop.", "That came off the big card."],
  "node.error": ["The desktop choked on that one.", "Something went wrong on the big card."],
  "node.paired": ["A laptop found me."],
  "watch.start": ["A camera's up. I'm watching the door with it.", "Eyes on the door.", "The shelf phone is looking."],
  "desk.verdict": ["Judged. Off the desk.", "One fewer card waiting."],
  // The shell pulled newer code from the hoard and needs a restart to run it.
  "update.ready": ["New code came down the wire. Restart me when you're ready.", "The hoard has something newer than me. Say the word.", "I fetched the future. It takes on the next launch."],
};

function pick(topic, seed) {
  const list = LINES[topic] || LINES.idle;
  return list[Math.abs(seed) % list.length];
}

// How long a low-priority topic counts as already said. Collapse-on-key merges
// two messages that are QUEUED at the same time; this is the other repetition,
// the one that actually wears people down — the same ambient line twice in a
// couple of minutes, because nothing remembered saying it the first time.
const SAID_MS = 90 * 1000;

class Companion {
  // `memory` is { turns, said } from a previous run, or nothing. He keeps his
  // place in each topic's rotation across restarts: without it, restarting the
  // shell rewinds him to the first line of everything, which is how a
  // twelve-line vocabulary starts sounding like a three-line one.
  constructor(onChange, memory) {
    this.onChange = onChange || (() => {});
    this.bands = Array.from({ length: BANDS }, () => []);
    this.showing = null;      // { key, priority, text, state, until }
    this.asleep = false;
    this.quiet = false;
    this.missed = [];         // priority >= 2 collected while away
    this.turns = { ...(memory?.turns || {}) };   // topic -> times it has spoken
    this.said = { ...(memory?.said || {}) };     // topic -> when it last did
    this.baseState = "idle";  // what he returns to
  }

  // What is worth carrying to the next run. Deliberately small: two plain
  // objects of numbers, so a corrupt or missing file costs nothing.
  snapshot() {
    return { turns: this.turns, said: this.said };
  }

  // `state` is the sprite he wears while saying it; it outlives the sentence
  // only if `sticky` is set (a running routine, a sick disk).
  push({ key, priority = 1, topic, text, state, ttlMs = DEFAULT_TTL, sticky = false }) {
    const p = Math.max(0, Math.min(BANDS - 1, priority));
    // Rotate WITHIN the topic, not across all of them. One shared counter meant
    // which of crash's two lines you got depended on how many unrelated
    // messages had been pushed since boot, so a two-line topic hit twice with
    // an even number of other pushes in between repeated itself word for word.
    const t = topic || "idle";

    // Said it recently, so do not say it again. Only chatter is suppressed:
    // news repeating is news, but an ambient observation repeating is a tic.
    // Checked before the text is chosen so a suppressed message does not burn
    // a turn of the rotation.
    const now = Date.now();
    if (p <= 1 && !text && this.said[t] && now - this.said[t] < SAID_MS) return null;

    const body = text || pick(t, this.turns[t] = (this.turns[t] || 0) + 1);
    if (!text) this.said[t] = now;

    // Asleep or in quiet hours: chatter never even queues. News is remembered
    // for the digest instead of being spoken to an empty chair.
    if ((this.asleep || this.quiet) && p <= 1) return null;
    if (this.asleep && p >= 2) {
      this.missed.push({ text: body, at: Date.now(), priority: p });
      if (this.missed.length > 12) this.missed.shift();
      return null;
    }

    const msg = { key: key || topic || body, priority: p, text: body, state, sticky, expires: Date.now() + ttlMs };

    // Collapse onto an existing message with the same key rather than saying
    // the same thing twice.
    const band = this.bands[p];
    const dup = band.findIndex((m) => m.key === msg.key);
    if (dup >= 0) band[dup] = msg;
    else band.push(msg);
    if (band.length > MAX_PER_BAND) band.shift();

    if (sticky && state) this.baseState = state;
    this.advance();
    return msg;
  }

  // Streaming: for a long-running answer (the agent), update the same message
  // in place rather than queueing one per token. The first call pushes; later
  // calls with the same key grow the text and refresh the dwell so it stays
  // on screen until the stream goes quiet.
  stream(key, text, state, priority = 2) {
    if (this.showing && this.showing.key === key) {
      this.showing.text = text;
      if (state) this.showing.state = state;
      this.showing.until = Date.now() + Math.max(MIN_SHOW_MS, Math.min(20000, text.length * READ_MS_PER_CHAR));
      this.emit();
    } else {
      this.push({ key, priority, text, state: state || "happy", sticky: true, ttlMs: 120000 });
    }
  }

  // A glance: a face he makes for a moment without saying anything and
  // without touching the queue — looking up when you switch apps, a flinch
  // at a reload, a stretch of reading while nothing is happening. It sits
  // under speech (a message's own face still wins while it shows) and over
  // the base face, and it ends on its own.
  glance(state, ms = 1600) {
    if (this.asleep || !state) return;
    this.glanceState = state;
    this.glanceUntil = Date.now() + ms;
    clearTimeout(this.glanceTimer);
    this.glanceTimer = setTimeout(() => { this.glanceState = null; this.emit(); }, ms);
    this.emit();
  }

  // Called on a slow tick. Expires stale messages and moves things along.
  tick() {
    const now = Date.now();
    let dirty = false;
    for (const band of this.bands) {
      const before = band.length;
      // An unshown message that timed out is dropped, not delayed.
      for (let i = band.length - 1; i >= 0; i--) if (band[i].expires < now) band.splice(i, 1);
      if (band.length !== before) dirty = true;
    }
    if (this.showing && this.showing.until <= now) {
      this.showing = null;
      dirty = true;
    }
    if (dirty || this.pending()) this.advance();
  }

  pending() {
    return this.bands.some((b) => b.length);
  }

  advance() {
    const now = Date.now();
    // Highest band first.
    let next = null, fromBand = -1;
    for (let p = BANDS - 1; p >= 0; p--) {
      if (this.bands[p].length) { next = this.bands[p][0]; fromBand = p; break; }
    }

    if (this.showing) {
      const done = this.showing.until <= now;
      const outranked = next && next.priority > this.showing.priority;
      if (!done && !outranked) return;
      // Interruption is not destruction: the displaced message goes back to
      // the head of its own band and will be said when the shouting stops.
      if (!done && outranked && !this.showing.spent) {
        this.bands[this.showing.priority].unshift({ ...this.showing, spent: true });
      }
      this.showing = null;
    }

    if (!next) {
      this.emit();
      return;
    }
    this.bands[fromBand].shift();
    const dwell = Math.max(MIN_SHOW_MS, Math.min(12000, next.text.length * READ_MS_PER_CHAR));
    this.showing = { ...next, until: now + dwell };
    this.emit();
  }

  emit() {
    const glancing = this.glanceState && this.glanceUntil > Date.now() ? this.glanceState : null;
    // Quiet hours drowse him only when nothing else claims his face.
    const resting = this.quiet && this.baseState === "idle" ? "sleepy" : this.baseState;
    this.onChange({
      state: this.asleep ? "sleeping" : (this.showing?.state || glancing || resting),
      text: this.asleep ? null : (this.showing?.text || null),
      priority: this.showing?.priority ?? 0,
      queued: this.bands.reduce((n, b) => n + b.length, 0),
      asleep: this.asleep,
      quiet: this.quiet,
    });
  }

  setBase(state) {
    this.baseState = state || "idle";
    this.emit();
  }

  sleep(on) {
    if (this.asleep === !!on) return;
    this.asleep = !!on;
    if (this.asleep) this.showing = null;
    this.emit();
  }

  // Called on unlock/resume. One sentence for everything that mattered, not
  // one per event — the whole point of holding them.
  digest() {
    const items = this.missed.splice(0, this.missed.length);
    if (!items.length) return null;
    const worst = Math.max(...items.map((i) => i.priority));
    const text = items.length === 1
      ? `While you were away — ${items[0].text}`
      : `While you were away — ${items.length} things, the loudest: ${items[0].text}`;
    return this.push({ key: "digest", priority: worst, text, state: worst >= 3 ? "alert" : "idle" });
  }

  setQuiet(on) {
    this.quiet = !!on;
    this.emit();
  }
}

module.exports = { Companion, LINES, pick };
