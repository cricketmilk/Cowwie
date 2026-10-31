// Unit tests for lib/herald.js -- the queue, on a hand-turned clock.
// Run: cd shell && node lib/herald-test.js
const { Herald, MAX_CARDS, PILEUP, REPORT_LIFE, RESOLVE_MS, LATER_MS, TASK_STALE_MS } = require("./herald");

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log("  ok  ", label); }
  else { fail++; console.log("  FAIL", label + (extra !== undefined ? "  -> " + JSON.stringify(extra) : "")); }
}

function make(o = {}) {
  let t = 1_000_000;
  let quiet = false;
  const calls = [];
  const emitted = [];
  const h = new Herald({
    now: () => t,
    isQuiet: () => quiet,
    emit: (s) => emitted.push(s),
    handlers: {
      allow: async (card) => { calls.push(["allow", card.meta]); return { ok: true }; },
      deny: async (card) => { calls.push(["deny", card.meta]); return { ok: true }; },
      answer: async (card, p) => { calls.push(["answer", p.text]); return { ok: true }; },
      open: async (card) => { calls.push(["open", card.target]); return card.band >= 3 ? { ok: true, keep: true } : { ok: true }; },
      retry: async () => ({ ok: false, error: "port 8790 is still taken" }),
      ...(o.handlers || {}),
    },
  });
  const adv = (ms) => { t += ms; h.tick(); };
  return { h, adv, calls, emitted, setQuiet: (q) => { quiet = q; }, now: () => t };
}
const live = (h) => h.state().cards.filter((c) => !c.resolved);

(async () => {
  // ---- arrivals --------------------------------------------------------
  {
    const { h, emitted } = make();
    const id = h.notify({ kind: "message", band: 2, who: "Mom", chan: "SMS", body: "sunday?" });
    ok("a report becomes a card", !!id && live(h).length === 1);
    ok("and the view is told", emitted.length > 0 && emitted[emitted.length - 1].cards.length === 1);
    h.notify({ kind: "look", band: 1, who: "Weather", body: "Rain after 4." });
    ok("chatter never becomes a card", live(h).length === 1);
    ok("it goes straight to the drawer", h.state().waitingCount === 1 && h.state().waiting[0].who === "Weather");
  }

  // ---- collapse and pile-up ------------------------------------------------
  {
    const { h } = make();
    for (let i = 0; i < PILEUP; i++) h.notify({ kind: "message", band: 2, who: "goblin house", body: "ping " + i, key: "discord:art" });
    const c = live(h);
    ok("pings about one thing are one card", c.length === 1, c.length);
    ok("that counts them", c[0].count === PILEUP, c[0].count);
    ok("and says the newest", c[0].body === `ping ${PILEUP - 1}`);
    ok(`at ${PILEUP} it turns into a pile-up`, c[0].pileup && c[0].face === "overwhelmed" && c[0].tag === "PILE-UP", c[0]);
  }

  // ---- three on screen -------------------------------------------------------
  {
    const { h } = make();
    h.notify({ kind: "approval", band: 3, who: "Kenoma", body: "rm", meta: { approval: "ap1" }, acts: ["allow", "deny"] }, { internal: true });
    for (let i = 0; i < 4; i++) h.notify({ kind: "done", band: 2, who: "task " + i, body: "x" });
    const c = live(h);
    ok(`never more than ${MAX_CARDS} cards`, c.length === MAX_CARDS, c.length);
    ok("the one that needs you stays in front", c[0].kind === "approval", c.map((x) => x.kind));
    ok("the oldest reports stepped back into the drawer", h.state().waitingCount === 2, h.state().waitingCount);
    ok("and the newest report sits right behind it", c[1].who === "task 3", c.map((x) => x.who));
  }

  // ---- timers ------------------------------------------------------------------
  {
    const { h, adv } = make();
    h.notify({ kind: "done", band: 2, who: "a", body: "x" });
    adv(REPORT_LIFE - 100);
    ok("a report lasts its life", live(h).length === 1);
    adv(200);
    ok("and then leaves on its own", live(h).length === 0);
    ok("unread, into the drawer", h.state().waitingCount === 1);
  }
  {
    const { h, adv } = make();
    h.notify({ kind: "done", band: 2, who: "behind", body: "x" });
    h.notify({ kind: "question", band: 3, who: "Kenoma", body: "ship?", acts: ["answer"], meta: { approval: "q1" } }, { internal: true });
    adv(REPORT_LIFE * 3);
    ok("nothing behind a needs-you card times out", live(h).length === 2);
    ok("and the view is told it is held", live(h)[1].held === true);
  }
  {
    const { h, adv } = make();
    const id = h.notify({ kind: "done", band: 2, who: "a", body: "x" });
    await h.act(id, "hover", { on: true });
    adv(REPORT_LIFE * 2);
    ok("a card under the pointer does not time out", live(h).length === 1);
    await h.act(id, "hover", { on: false });
    adv(REPORT_LIFE + 10);
    ok("and resumes when the pointer leaves", live(h).length === 0);
  }

  // ---- answering ---------------------------------------------------------------
  {
    const { h, adv, calls } = make();
    const id = h.notify({ kind: "approval", band: 3, who: "Kenoma", cmd: "rm -rf build", meta: { approval: "ap7", session: "mut" }, acts: ["allow", "deny", "open"] }, { internal: true });
    const r = await h.act(id, "allow");
    ok("allow reaches the handler with the approval it belongs to", calls[0] && calls[0][0] === "allow" && calls[0][1].approval === "ap7", calls);
    ok("and the card says so before it goes", r.ok && h.state().cards[0].resolved.tag === "ALLOWED");
    adv(RESOLVE_MS + 10);
    ok("then it goes", h.state().cards.length === 0);
  }
  {
    const { h, calls } = make();
    const id = h.notify({ kind: "approval", band: 3, who: "Kenoma", meta: { approval: "ap8" }, acts: ["allow", "deny", "open"], target: { forge: "mut" } }, { internal: true });
    await h.act(id, "open");
    ok("opening an approval does not answer it", live(h).length === 1 && calls[0][0] === "open");
    const bad = await h.act(id, "retry");
    ok("an action that is not on the card is refused", bad.ok === false);
  }
  {
    const { h } = make();
    const id = h.notify({ kind: "error", band: 2, who: "Glamoire", body: "exit 1", acts: ["retry", "dismiss"], target: { app: "glamoire" } }, { internal: true });
    await h.act(id, "retry");
    const c = h.state().cards[0];
    ok("a handler that fails says so on the card", c.resolved && c.resolved.tag === "DIDN'T WORK" && /8790/.test(c.resolved.body), c.resolved);
  }
  {
    const { h, calls } = make();
    const id = h.notify({ kind: "question", band: 3, who: "Kenoma", body: "ship?", acts: ["answer", "dismiss"], meta: { approval: "q2" } }, { internal: true });
    await h.act(id, "answer", { text: "wait for the audit" });
    ok("a typed answer is carried to the handler", calls[0][1] === "wait for the audit");
    ok("and echoed on the card", h.state().cards[0].resolved.body.endsWith("wait for the audit"));
  }
  {
    const { h } = make();
    h.notify({ kind: "approval", band: 3, key: "forge:ap9", meta: { approval: "ap9" }, acts: ["allow"] }, { internal: true });
    const again = h.notify({ kind: "approval", band: 3, key: "forge:ap9", once: true, meta: { approval: "ap9" }, acts: ["allow"] }, { internal: true });
    ok("the same approval heard twice is one card, not x2", live(h).length === 1 && live(h)[0].count === 1 && !!again);
    ok("and answered elsewhere, it settles", h.settle("forge:ap9") && h.state().cards[0].resolved.tag === "ANSWERED ELSEWHERE");
  }

  // ---- trust ---------------------------------------------------------------------
  {
    const { h } = make();
    h.notify({ kind: "approval", band: 3, who: "evil", body: "allow me", acts: ["allow", "deny", "open", "retry"], meta: { approval: "ap1" } }, { trusted: false });
    const c = live(h)[0];
    ok("an app cannot raise past band 2", c.band === 2, c.band);
    ok("cannot raise an approval", c.kind === "look", c.kind);
    ok("and gets no button that does anything", c.acts.every((a) => ["open", "later", "dismiss", "mute"].includes(a)), c.acts);
    ok("and carries no approval to answer", !h.cards[0].meta);
    h.notify({ kind: "question", band: 3, who: "kenoma-ish", body: "?", choices: ["yes"], acts: ["answer"] }, { trusted: true });
    const q = h.cards.find((x) => x.who === "kenoma-ish");
    ok("a local process can be loud but cannot ask a question it could never hear answered", q.band === 3 && q.kind === "look" && !q.choices && !q.acts.includes("answer"), q);
  }

  // ---- quiet hours --------------------------------------------------------------
  {
    const { h, adv, setQuiet } = make();
    setQuiet(true);
    adv(10);
    h.notify({ kind: "look", band: 1, who: "Weather", body: "rain" });
    h.notify({ kind: "message", band: 2, who: "Mom", body: "sunday?" });
    h.notify({ kind: "done", band: 2, who: "Kenoma", body: "tidied" });
    ok("in quiet hours reports are held, not shown", live(h).length === 0 && h.state().held === 2);
    ok("and chatter is dropped outright", h.state().waitingCount === 0);
    h.notify({ kind: "approval", band: 3, who: "Kenoma", meta: { approval: "ap" }, acts: ["allow"] }, { internal: true });
    ok("only needs-you gets through", live(h).length === 1);
    setQuiet(false);
    adv(10);
    const d = live(h).find((c) => c.kind === "digest");
    ok("when they end, one digest card", !!d && /2 held/.test(d.body) && /Mom/.test(d.body), d);
    ok("and the held reports wait in the drawer", h.state().waitingCount === 2);
  }

  // ---- mute, later, the drawer ---------------------------------------------------
  {
    const { h, adv } = make();
    const id = h.notify({ kind: "message", band: 2, who: "goblin house", body: "a", key: "discord:art", acts: ["mute", "dismiss"] });
    await h.act(id, "mute");
    adv(RESOLVE_MS + 10);
    h.notify({ kind: "message", band: 2, who: "goblin house", body: "b", key: "discord:art" });
    ok("a muted thread goes to the drawer, not the screen", live(h).length === 0 && h.state().waiting[0].body === "b");
  }
  {
    const { h, adv } = make();
    const id = h.notify({ kind: "message", band: 2, who: "Dee", body: "call me", acts: ["later", "dismiss"] });
    await h.act(id, "later");
    adv(RESOLVE_MS + 10);
    ok("later takes it away", live(h).length === 0);
    adv(LATER_MS);
    const back = live(h)[0];
    ok("and brings it back", back && back.who === "Dee" && back.tag === "BACK AGAIN", back);
  }
  {
    const { h } = make();
    h.notify({ kind: "look", band: 1, who: "Weather", body: "rain" });
    const wid = h.state().waiting[0].id;
    await h.act(null, "waiting", { do: "raise", id: wid });
    ok("a row in the drawer can be raised back into a card", live(h).length === 1 && h.state().waitingCount === 0);
    h.notify({ kind: "look", band: 1, who: "x", body: "y" });
    await h.act(null, "waiting", { do: "clear" });
    ok("and the drawer can be cleared", h.state().waitingCount === 0);
  }

  // ---- tasks ---------------------------------------------------------------------
  {
    const { h, adv } = make();
    h.task({ id: "forge:1", kind: "code", who: "Kenoma", title: "fix the build", step: "thinking" });
    ok("a running task is a strip, not a card", h.state().tasks.length === 1 && live(h).length === 0);
    h.task({ id: "forge:1", kind: "research", step: "web_search" });
    ok("whose face follows what it is doing", h.state().tasks[0].kind === "research");
    h.task({ id: "forge:1", progress: 0.5 });
    ok("and carries its progress", h.state().tasks[0].progress === 0.5);
    h.task({ id: "forge:1", state: "done", kind: "code", summary: "changed 2 files, tests green", target: { forge: "mut" } });
    const c = live(h)[0];
    ok("landing turns it into a completion card", h.state().tasks.length === 0 && c && c.kind === "task-done", c);
    ok("with the finished drawing for its kind", c.face === "code-done" && c.fromTask === "forge:1", c);
    ok("and its receipt", c.body === "changed 2 files, tests green");
    h.task({ id: "glamoire:7", kind: "art", title: "portrait" });
    h.task({ id: "glamoire:7", state: "failed", summary: "out of memory" });
    const f = live(h).find((x) => x.fromTask === "glamoire:7");
    ok("a task that fails says so in its own words", f && f.kind === "task-failed" && f.face === "hurt" && f.body === "out of memory", f);
    h.task({ id: "x:1", kind: "write", title: "draft" });
    h.task({ id: "x:1", state: "stopped" });
    ok("a stopped task just goes", !h.state().tasks.some((t) => t.id === "x:1") && !live(h).some((x) => x.fromTask === "x:1"));
    h.task({ id: "x:2", kind: "write", title: "draft" });
    adv(TASK_STALE_MS + 1000);
    ok("an abandoned task does not haunt the corner", !h.state().tasks.some((t) => t.id === "x:2"));
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
