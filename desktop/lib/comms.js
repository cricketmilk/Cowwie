// The phone's notifications, as the laptop hears them — and the replies it
// sends back.
//
// Auri's phone app runs a NotificationListenerService. Every notification the
// phone shows (SMS, Signal, Discord, a missed call) is posted here as an item;
// every one the phone clears is posted as `removed`. This module keeps the
// phone's CURRENT notifications, decides which deserve a card (triage), and
// holds an outbox of replies that the phone takes and sends through the
// notification's own Reply action — so a reply to any messaging app works
// without that app's API, a login, or a second copy of the conversation.
//
// THE RULES, each of which is a promise to you rather than a feature:
//   * Delivered once, where you are. A notification you clear on the phone
//     settles its card here (`removed`), and while you are away from the
//     laptop nothing becomes a card at all — it waits in the drawer for when
//     you come back, and the phone in your pocket has already told you.
//   * One-time codes never cross. The phone drops them before posting; this
//     drops them again, because a bank's "your code is 482913" sitting in a
//     laptop's memory is exactly what nobody should have to think about.
//   * The words are untrusted. Anyone who can text you can put text in front
//     of whatever reads it, so nothing here ever hands a message to a model:
//     the herald displays it, and a reply is always a person's keystrokes.
//   * Memory only. Nothing is written to disk. These are other people's
//     words, and the archive (the Trove) is for what you choose to keep.

const MAX_ITEMS = 50;          // per post
const MAX_LIVE = 300;          // notifications the phone is showing right now
const OUTBOX_TTL_MS = 10 * 60 * 1000;
const REPLY_WAIT_MS = 8000;    // how long a card waits to hear the reply went

// "Your code is 482913", "482913 is your verification code", "G-482913".
// Deliberately broad: a false positive costs you one card you would have
// seen on the phone anyway; a false negative puts a code on the laptop.
const OTP = /\b(?:code|otp|passcode|pass code|verification|verify|2fa|two[- ]factor|one[- ]time|security|login|sign[- ]in|pin|token)\b[^\n]{0,60}?(?:\b[A-Z]-)?\b\d{4,8}\b|(?:\b[A-Z]-)?\b\d{4,8}\b[^\n]{0,60}?\b(?:code|otp|passcode|verification|verify|one[- ]time|security|log[- ]?in|sign[- ]in|pin|authenticat\w*)\b/i;

function sensitive(it) {
  return OTP.test(`${it.title}\n${it.text}`);
}

const str = (v, n) => (v === undefined || v === null ? "" : String(v)).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, n);

function clean(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = str(raw.key, 300);
  if (!key) return null;
  return {
    key,
    removed: !!raw.removed,
    pkg: str(raw.pkg, 120),
    app: str(raw.app, 60) || str(raw.pkg, 60),
    title: str(raw.title, 80),
    text: str(raw.text, 600),
    thread: str(raw.thread, 120),         // conversation title for group chats
    category: str(raw.category, 24),
    canReply: !!raw.canReply,
    ongoing: !!raw.ongoing,
    // What the phone was already showing when the bridge connected, and the
    // app echoing your own reply ("You: ..."): both are filed, neither is news.
    quiet: !!raw.snapshot || !!raw.mine,
    when: Number.isFinite(raw.when) ? raw.when : null,
  };
}

/**
 * What a notification becomes on the laptop: a herald card's input, or null
 * for "nothing" (it stays on the phone). Pure, so the rules are testable.
 *
 * @param {object} it      a cleaned item
 * @param {object} o
 * @param {string[]} o.people  names whose messages are "your people" (band 3)
 * @param {boolean} o.away     nobody at the laptop: everything to the drawer
 */
function triage(it, { people = [], away = false } = {}) {
  const who = it.title || it.app;
  const lc = `${it.title} ${it.thread}`.toLowerCase();
  const yours = people.some((p) => p && lc.includes(String(p).toLowerCase()));
  const base = {
    who, chan: it.thread && it.thread !== it.title ? `${it.app} · ${it.thread}` : it.app,
    body: it.text,
    // One card per conversation, so a burst of texts is one card with x5.
    key: `comms:${it.pkg}:${it.thread || it.title || it.key}`,
    meta: { comms: it.key },
  };
  const cap = (band) => (away ? 1 : band);
  if (it.category === "call") {
    return { ...base, kind: "call", band: cap(3), body: it.text || "Calling.", acts: ["dismiss"], key: `comms:call:${it.pkg}` };
  }
  if (it.category === "missed_call" || /^missed (voice |video )?call/i.test(it.title) || /^missed (voice |video )?call/i.test(it.text)) {
    return { ...base, kind: "missed", band: cap(2), acts: ["later", "dismiss"] };
  }
  if (it.category === "msg" || it.canReply) {
    const acts = it.canReply ? ["reply", "later", "mute", "dismiss"] : ["later", "mute", "dismiss"];
    return yours ? { ...base, kind: "love", band: cap(3), acts } : { ...base, kind: "message", band: cap(2), acts };
  }
  if (yours) return { ...base, kind: "love", band: cap(2), acts: ["later", "dismiss"] };
  // Everything else — a shipping update, a game's "your energy is full" — is
  // the drawer's business, never a card.
  if (it.ongoing) return null;
  return { ...base, kind: "look", band: 1, acts: ["dismiss"] };
}

/**
 * @param {object} o
 * @param {(ev:{type:string,item?:object,reply?:object})=>void} [o.onEvent]
 * @param {()=>number} [o.now]
 */
function createComms({ onEvent = () => {}, onPost = () => {}, now = () => Date.now() } = {}) {
  const live = new Map();     // key -> item, the phone's notifications right now
  const outbox = [];          // { id, key, text, at, taken, done, ok, error }
  const waiters = new Map();  // reply id -> resolve
  let seq = 0;
  let phoneSeen = 0;
  let dropped = 0;

  function prune() {
    const t = now();
    for (let i = outbox.length - 1; i >= 0; i--) {
      const r = outbox[i];
      if (t - r.at > OUTBOX_TTL_MS) {
        outbox.splice(i, 1);
        const w = waiters.get(r.id);
        if (w) { waiters.delete(r.id); w({ ok: false, error: "the phone never took it" }); }
      }
    }
  }

  // What the phone may take: replies it has not sent yet, oldest first. A
  // reply taken but not acked within a minute is offered again — the phone
  // may have been killed between taking and sending.
  function pending() {
    const t = now();
    return outbox.filter((r) => !r.done && (!r.taken || t - r.taken > 60000)).map((r) => {
      r.taken = t;
      return { id: r.id, key: r.key, text: r.text };
    });
  }

  return {
    /** POST /mut/comms: a batch from the phone. Answers with its outbox. */
    ingest(body) {
      phoneSeen = now();
      const items = Array.isArray(body && body.items) ? body.items.slice(0, MAX_ITEMS) : [];
      let accepted = 0;
      for (const raw of items) {
        const it = clean(raw);
        if (!it) continue;
        if (it.removed) {
          const had = live.get(it.key);
          live.delete(it.key);
          if (had) onEvent({ type: "removed", item: had });
          continue;
        }
        if (sensitive(it)) { dropped++; continue; }
        const prev = live.get(it.key);
        live.set(it.key, it);
        if (live.size > MAX_LIVE) live.delete(live.keys().next().value);
        accepted++;
        if (it.quiet) continue;
        // Android re-posts a notification to update a progress bar or a
        // timestamp; the same words again are not news.
        if (prev && prev.text === it.text && prev.title === it.title) continue;
        onEvent({ type: "arrived", item: it });
      }
      prune();
      // Every post, news or not: the drawer's "phone last heard" line.
      try { onPost(); } catch {}
      return { ok: true, accepted, outbox: pending() };
    },

    /** GET /mut/comms/outbox: replies waiting for the phone. */
    take() {
      phoneSeen = now();
      prune();
      return { ok: true, outbox: pending() };
    },

    /** POST /mut/comms/ack: the phone sent it, or could not. */
    ack(body) {
      const r = outbox.find((x) => x.id === str(body && body.id, 40));
      if (!r) return { ok: false, error: "no such reply" };
      r.done = true;
      r.ok = !!body.ok;
      r.error = body.ok ? null : str(body.error, 200) || "the phone could not send it";
      outbox.splice(outbox.indexOf(r), 1);
      const w = waiters.get(r.id);
      if (w) { waiters.delete(r.id); w({ ok: r.ok, error: r.error }); }
      onEvent({ type: "replied", reply: { id: r.id, key: r.key, ok: r.ok, error: r.error } });
      return { ok: true };
    },

    /**
     * Queue a reply to the notification `key`. Resolves when the phone says
     * it went, or after a few seconds with `queued` — a phone asleep in a
     * pocket sends it when it next checks in, and the card should not hang.
     */
    reply(key, text) {
      const it = live.get(key);
      const words = str(text, 2000);
      if (!words) return Promise.resolve({ ok: false, error: "nothing to send" });
      if (!it) return Promise.resolve({ ok: false, error: "the phone no longer shows that message" });
      if (!it.canReply) return Promise.resolve({ ok: false, error: `${it.app} offers no reply from a notification` });
      const r = { id: "r" + now().toString(36) + (++seq).toString(36), key, text: words, at: now(), taken: 0, done: false };
      outbox.push(r);
      return new Promise((resolve) => {
        waiters.set(r.id, resolve);
        setTimeout(() => {
          if (!waiters.has(r.id)) return;
          waiters.delete(r.id);
          resolve({ ok: true, queued: true });
        }, REPLY_WAIT_MS).unref?.();
      });
    },

    status() {
      return { live: live.size, outbox: outbox.length, phoneSeen, dropped };
    },
    has(key) { return live.has(key); },
  };
}

module.exports = { createComms, triage, clean, sensitive, OTP };
