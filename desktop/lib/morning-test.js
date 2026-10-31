// The morning brief on a fake clock and a fake Lookout.
//
//   node lib/morning-test.js
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Morning, parseTime } = require("./morning");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (e !== undefined ? "  -> " + JSON.stringify(e) : "")); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "morning-"));
let clock = new Date(2026, 10, 2, 7, 0);      // Monday 2 Nov 2026, 07:00 local
const filed = [];
let lookout = [];                               // what the fake Lookout answers
let lookoutUp = true;
const notes = [];
const fakeFetch = async (url) => {
  if (!lookoutUp) throw new Error("ECONNREFUSED");
  return { ok: true, json: async () => lookout };
};
const make = () => new Morning({ dir, file: (b) => { filed.push(b); return { ok: true, id: "x" }; }, notes: () => notes, now: () => clock, fetch: fakeFetch });

(async () => {
  let M = make();
  ok("the default is 07:30 on weekdays", M.state.time === "07:30" && M.state.days.join() === "1,2,3,4,5");
  ok("parseTime rejects nonsense", parseTime("25:00") === null && parseTime("x") === null && parseTime("7:05").h === 7);

  ok("not due before the time", !M.due());
  clock = new Date(2026, 10, 2, 7, 30);
  ok("due at the time", M.due());
  await M.tick();
  ok("one brief filed", filed.length === 1 && /Morning brief/.test(filed[0].title));
  ok("it says Lookout saw nothing", /nothing changed/.test(filed[0].body), filed[0].body);
  ok("titled with the weekday", /Monday/.test(filed[0].title));
  clock = new Date(2026, 10, 2, 9, 0);
  await M.tick();
  ok("never twice in a day", filed.length === 1);

  // A missed morning: the shell comes up at noon the next day.
  clock = new Date(2026, 10, 3, 12, 5);
  lookout = [
    { id: "f1", watchId: "w1", watch: "OIG exclusions", when: new Date(2026, 10, 3, 3, 0).toISOString(), score: 82, acked: false },
    { id: "f2", watchId: "w2", watch: "CMS newsroom", when: new Date(2026, 10, 3, 4, 0).toISOString(), score: 45, acked: false },
    { id: "f3", watchId: "w3", watch: "old one", when: new Date(2026, 10, 1, 4, 0).toISOString(), score: 90, acked: false },
    { id: "f4", watchId: "w4", watch: "seen", when: new Date(2026, 10, 3, 5, 0).toISOString(), score: 75, acked: true },
  ];
  notes.push({ id: "n1", text: "ask about the November schedule", when: clock.getTime() - 3600_000 });
  await M.tick();
  ok("a missed morning is filed at the first tick after", filed.length === 2);
  const b = filed[1];
  ok("counts only fresh, unacked findings", /2 changes/.test(b.body), b.body);
  ok("names the top ones with scores", /OIG exclusions \(82\), CMS newsroom \(45\)/.test(b.body), b.body);
  ok("a high score makes it urgent", b.level === "urgent");
  ok("links to Lookout", b.url === "apps/lookout/index.html");
  ok("carries the phone's notes", /1 note from the phone: "ask about the November schedule"/.test(b.body), b.body);

  // Weekend: nothing.
  clock = new Date(2026, 10, 7, 9, 0);   // Saturday
  await M.tick();
  ok("not on a weekend", filed.length === 2);

  // The schedule is configurable and survives a restart.
  M.configure({ time: "06:15", days: [0, 6] });
  M = make();
  ok("the schedule persists", M.state.time === "06:15" && M.state.days.join() === "0,6");
  ok("and so does the last run", M.state.lastRun === "2026-11-03");
  await M.tick();
  ok("a Saturday after 06:15 is now due", filed.length === 3);

  // Lookout down: said plainly.
  lookoutUp = false;
  const c = await M.compose(new Date(2026, 10, 9, 8, 0));
  ok("Lookout down is said, not guessed", /not running/.test(c.body) && c.level === "normal" && c.url === undefined);

  // runNow files regardless of schedule.
  clock = new Date(2026, 10, 9, 2, 0);
  await M.runNow();
  ok("runNow files off-schedule", filed.length === 4);

  // A bad saved file falls back to defaults.
  fs.writeFileSync(path.join(dir, "morning.json"), "{not json");
  ok("a corrupt file means defaults", make().state.time === "07:30");

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
