// Unit tests for lib/comms.js -- the phone's notifications on the laptop.
// Run: cd shell && node lib/comms-test.js
const { createComms, triage, clean, sensitive } = require("./comms");

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log("  ok  ", label); }
  else { fail++; console.log("  FAIL", label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}
const sms = (over = {}) => ({ key: "0|com.google.android.apps.messaging|7|null|10", pkg: "com.google.android.apps.messaging",
  app: "Messages", title: "Mom", text: "are you coming sunday?", category: "msg", canReply: true, ...over });

(async () => {
  // ---- what never crosses ------------------------------------------------------
  for (const t of ["Your verification code is 482913", "482913 is your Google verification code", "G-482913 is your code",
    "Use 7731 to sign in", "Your login PIN: 99120", "Chase: one-time passcode 552310. Don't share it."]) {
    ok(`a one-time code never crosses: "${t}"`, sensitive(clean(sms({ text: t }))));
  }
  for (const t of ["see you at 1930", "call me at 555-0142", "the 2024 tour was wild", "room 4021 at 3pm"]) {
    ok(`ordinary numbers are not codes: "${t}"`, !sensitive(clean(sms({ text: t }))));
  }

  // ---- triage --------------------------------------------------------------------
  const m = triage(clean(sms()));
  ok("a text becomes a message card", m.kind === "message" && m.band === 2 && m.acts.includes("reply"), m);
  ok("keyed by conversation, so a burst is one card", m.key === "comms:com.google.android.apps.messaging:Mom");
  ok("carrying the phone's key to reply through", m.meta.comms === sms().key);
  ok("someone on your list is band 3", triage(clean(sms()), { people: ["mom"] }).kind === "love"
    && triage(clean(sms()), { people: ["mom"] }).band === 3);
  ok("an app with no Reply action gets no Reply button", !triage(clean(sms({ canReply: false }))).acts.includes("reply"));
  ok("a ringing phone is a call card", triage(clean(sms({ category: "call", title: "Dee", text: "Incoming call", canReply: false, ongoing: true }))).kind === "call");
  ok("a missed call is a missed card", triage(clean(sms({ category: "missed_call", title: "Missed call", text: "Dee", canReply: false }))).kind === "missed");
  ok("a shipping update goes to the drawer", triage(clean(sms({ pkg: "com.amazon", app: "Amazon", category: "status", canReply: false, title: "Delivered" }))).band === 1);
  ok("a media player's ongoing notice is nothing", triage(clean(sms({ category: "transport", canReply: false, ongoing: true }))) === null);
  ok("away from the laptop, even your people wait in the drawer", triage(clean(sms()), { people: ["mom"], away: true }).band === 1);
  const group = triage(clean(sms({ pkg: "com.discord", app: "Discord", title: "goblin house", thread: "#art", text: "lmao" })));
  ok("a group chat names the room", group.chan === "Discord · #art" && group.key === "comms:com.discord:#art", group);

  // ---- the round trip ------------------------------------------------------------
  {
    const events = [];
    const c = createComms({ onEvent: (e) => events.push(e) });
    const r = c.ingest({ items: [sms(), sms({ key: "otp", text: "Your code is 123456" })] });
    ok("a batch is accepted, minus the code", r.accepted === 1 && c.status().dropped === 1, r);
    ok("and heard once", events.filter((e) => e.type === "arrived").length === 1);
    c.ingest({ items: [sms()] });
    ok("the same words re-posted are not news", events.filter((e) => e.type === "arrived").length === 1);
    c.ingest({ items: [sms({ text: "also bring the good bread" })] });
    ok("new words in the same conversation are", events.filter((e) => e.type === "arrived").length === 2);

    const sent = c.reply(sms().key, "yes! bringing the sourdough");
    const took = c.take();
    ok("a reply waits in the outbox for the phone", took.outbox.length === 1 && took.outbox[0].text === "yes! bringing the sourdough", took);
    ok("and is not handed out twice at once", c.take().outbox.length === 0);
    c.ack({ id: took.outbox[0].id, ok: true });
    const res = await sent;
    ok("the phone's ack answers the card that asked", res.ok === true && !res.queued, res);
    ok("and the room hears it went", events.some((e) => e.type === "replied" && e.reply.ok));

    const failed = c.reply(sms().key, "again");
    const t2 = c.take();
    c.ack({ id: t2.outbox[0].id, ok: false, error: "RemoteInput gone" });
    const fr = await failed;
    ok("a reply the phone could not send says why", fr.ok === false && /RemoteInput/.test(fr.error), fr);

    c.ingest({ items: [{ key: sms().key, removed: true }] });
    ok("clearing it on the phone is heard here", events.some((e) => e.type === "removed" && e.item.key === sms().key));
    const gone = await c.reply(sms().key, "too late");
    ok("and it can no longer be replied to", gone.ok === false && /no longer/.test(gone.error), gone);
  }
  {
    let t = 1_000_000;
    const c = createComms({ now: () => t });
    c.ingest({ items: [sms()] });
    const p = c.reply(sms().key, "hello?");
    c.take();
    t += 61_000;
    ok("a reply taken and never acked is offered again", c.take().outbox.length === 1);
    const cant = await c.reply(sms().key, "");
    ok("an empty reply is refused", cant.ok === false);
    const noReply = createComms();
    noReply.ingest({ items: [sms({ canReply: false })] });
    ok("so is one to an app that offers none", (await noReply.reply(sms().key, "hi")).ok === false);
    t += 11 * 60_000;
    c.take();
    const old = await p;
    ok("a reply nobody took in ten minutes fails instead of hanging", old.ok === false, old);
  }
  {
    const events = [];
    const c = createComms({ onEvent: (e) => events.push(e) });
    c.ingest({ items: [sms({ snapshot: true }), sms({ key: "k2", title: "Dee", snapshot: true })] });
    ok("what the phone already showed is filed without a card", events.length === 0 && c.status().live === 2);
    ok("and can still be replied to", c.has(sms().key));
    c.ingest({ items: [sms({ text: "You: yes!", mine: true })] });
    ok("your own reply echoed by the app is not news", events.length === 0);
    c.ingest({ items: [sms({ text: "great, see you then" })] });
    ok("their answer after it is", events.length === 1 && events[0].item.text === "great, see you then");
  }
  ok("a junk batch is harmless", createComms().ingest({ items: [null, 7, {}, { key: "" }] }).accepted === 0);

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
