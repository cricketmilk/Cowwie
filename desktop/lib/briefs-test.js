// Briefs and notes, on their own: bounds, order, acks, what survives a restart.
//
//   node lib/briefs-test.js
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { Briefs, KEEP, PAGE, NOTES_KEEP } = require("./briefs");

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log("  ok   " + n); } else { fail++; console.log("  FAIL " + n + (e !== undefined ? "  -> " + JSON.stringify(e) : "")); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "briefs-"));
let B = new Briefs(dir);

// --- filing ---
let r = B.file({ source: "lookout", title: "Board moved", body: "The state board posted a rule change.", url: "https://example.org/rule", level: "normal" });
ok("a brief is filed", r.ok && r.brief.id && r.brief.read === false, r);
ok("with its source, title, body and url", r.brief.source === "lookout" && r.brief.title === "Board moved" && r.brief.url === "https://example.org/rule");
ok("a level it does not know becomes normal", B.file({ source: "x", title: "t", level: "loud" }).brief.level === "normal");
ok("quiet and urgent are kept", B.file({ source: "x", title: "t", level: "quiet" }).brief.level === "quiet" && B.file({ source: "x", title: "t", level: "urgent" }).brief.level === "urgent");
ok("no source is refused", !!B.file({ title: "t" }).error);
ok("no title is refused", !!B.file({ source: "x" }).error);
ok("a non-object is refused", !!B.file("hello").error && !!B.file(null).error);
ok("a javascript: url is dropped", B.file({ source: "x", title: "t", url: "javascript:alert(1)" }).brief.url === null);
ok("a relative url (an app path) is kept", B.file({ source: "x", title: "t", url: "apps/credentials/index.html#r1" }).brief.url === "apps/credentials/index.html#r1");
const long = B.file({ source: "x".repeat(200), title: "y".repeat(500), body: "z".repeat(5000) }).brief;
ok("source, title and body are bounded", long.source.length === 60 && long.title.length === 200 && long.body.length === 2000);
ok("control characters are stripped", B.file({ source: "x", title: "a\u0000b\u0007c" }).brief.title === "abc");
ok("a given `when` is kept, a missing one is now", B.file({ source: "x", title: "t", when: 1700000000000 }).brief.when === 1700000000000 && Math.abs(B.file({ source: "x", title: "t" }).brief.when - Date.now()) < 2000);
ok("it lands in briefs.jsonl", fs.readFileSync(path.join(dir, "briefs.jsonl"), "utf8").split("\n").filter(Boolean).length >= 10);

// --- listing ---
let list = B.list();
ok("the list is newest first", list.length >= 2 && list[0].when >= list[list.length - 1].when);
ok("since filters by when", B.list(Date.now() + 60000).length === 0 && B.list(1).length === list.length);
for (let i = 0; i < KEEP + 30; i++) B.file({ source: "flood", title: "n" + i });
ok(`memory keeps at most ${KEEP}`, B.items.length === KEEP);
ok(`a page is at most ${PAGE}`, B.list().length === PAGE);
ok("and the oldest are what fell off", !B.items.some((b) => b.title === "Board moved"));

// --- acks ---
const target = B.items[3];
r = B.ack([target.id, "nope", 42]);
ok("ack marks what it names and counts it", r.ok && r.acked === 1 && B.items[3].read === true, r);
ok("acking again counts nothing", B.ack([target.id]).acked === 0);
ok("a non-array is harmless", B.ack("x").acked === 0 && B.ack(null).acked === 0);

// --- notes ---
r = B.note({ text: "call the pharmacy about the Tuesday starter" });
ok("a note is kept", r.ok && r.note.id && r.note.text.startsWith("call the pharmacy") && r.note.from === "phone", r);
ok("an empty note is refused", !!B.note({ text: "   " }).error && !!B.note(null).error);
ok("a note is bounded", B.note({ text: "q".repeat(9000) }).note.text.length === 4000);
for (let i = 0; i < NOTES_KEEP + 10; i++) B.note({ text: "note " + i });
ok(`notes keep at most ${NOTES_KEEP}, newest first`, B.notes().length === NOTES_KEEP && B.notes()[0].text === "note " + (NOTES_KEEP + 9));
ok("notes land in notes.jsonl", fs.existsSync(path.join(dir, "notes.jsonl")));

// --- a restart ---
const B2 = new Briefs(dir);
ok("briefs come back from disk after a restart", B2.items.length === KEEP && B2.items[0].title === B.items[0].title);
ok("and the ack came back with them", B2.items.find((b) => b.id === target.id)?.read === true);
ok("notes come back too", B2.notes().length === NOTES_KEEP && B2.notes()[0].text === B.notes()[0].text);

// --- a missing data dir is made, a bad file is survived ---
const fresh = path.join(dir, "deeper", "still");
const B3 = new Briefs(fresh);
ok("an empty store lists nothing", B3.list().length === 0 && B3.notes().length === 0);
ok("filing creates the folder", B3.file({ source: "x", title: "t" }).ok && fs.existsSync(path.join(fresh, "briefs.jsonl")));
fs.appendFileSync(path.join(fresh, "briefs.jsonl"), "{not json\n");
ok("a torn last line is skipped on reload", new Briefs(fresh).items.length === 1);

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
