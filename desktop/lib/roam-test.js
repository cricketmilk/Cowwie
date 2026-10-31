// The Wilds' memory, unit-tested without booting a window.
//
// Everything worth getting wrong in a browser that isn't a view lives in
// lib/roam.js: what the omnibox does with what you typed, what the history
// remembers, what the suggestion list puts first. All of it is pure or
// file-backed, so all of it is testable here rather than by clicking.
//
//   node lib/roam-test.js

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Roam, resolve, search, prettyHost } = require("./roam");

let bad = 0;
const ok = (label, cond, extra = "") => {
  if (!cond) bad++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${label}${extra ? "  — " + extra : ""}`);
};
const eq = (label, got, want) => ok(label, got === want, got === want ? "" : `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

// ------------------------------------------------------- the omnibox rule
console.log("\nomnibox — address or search");

eq("bare host becomes https", resolve("example.com").url, "https://example.com");
eq("host with path keeps the path", resolve("example.com/a/b?c=1").url, "https://example.com/a/b?c=1");
eq("an explicit scheme is left alone", resolve("http://example.com").url, "http://example.com");
eq("protocol-relative becomes https", resolve("//example.com").url, "https://example.com");
eq("file: is navigable", resolve("file:///C:/x.html").url, "file:///C:/x.html");

// The one that every naive has-a-dot rule gets wrong.
eq("localhost with a port is a host, not a search", resolve("localhost:5173").url, "http://localhost:5173");
eq("a LAN address is a host", resolve("192.168.0.20:8080").url, "http://192.168.0.20:8080");
ok("a bare port-less single label searches", resolve("wiki").searched);

// Spaces mean prose, whatever punctuation is in them.
ok("a sentence with a dot in it searches", resolve("the site is down again. still?").searched);
ok("plain words search", resolve("how do i center a div").searched);
eq("the query is preserved", resolve("cheese").query, "cheese");

// A version number is not a domain.
ok("1.2.3 searches rather than navigating", resolve("1.2.3").searched);

// Script injection dressed as an address.
const js = resolve("javascript:alert(document.cookie)");
ok("javascript: is never navigated to", js.searched && !js.url.startsWith("javascript:"));
ok("javascript: is escaped into the query, not the path", js.url.includes("javascript%3A"));

eq("a custom search template is honoured",
  resolve("cats", "https://search.marginalia.nu/search?query=%s").url,
  "https://search.marginalia.nu/search?query=cats");
eq("a template with no %s falls back rather than producing a dead URL",
  resolve("cats", "https://broken.example").url.startsWith("https://duckduckgo.com/"), true);

eq("empty input goes nowhere", resolve("   ").url, "");
eq("a query is encoded", search("a b&c"), "https://duckduckgo.com/?q=a%20b%26c");

eq("prettyHost drops www", prettyHost("https://www.example.com/a"), "example.com");
eq("prettyHost names a local file", prettyHost("file:///C:/x.html"), "local file");
eq("prettyHost survives nonsense", prettyHost("not a url"), "");

// --------------------------------------------------------------- the store
console.log("\nhistory, pins and the session");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roam-test-"));
const r = new Roam(dir);

r.visit({ url: "https://a.example/one", title: "One", persona: "roam" });
r.visit({ url: "https://b.example/two", title: "Two", persona: "curio" });
r.visit({ url: "https://a.example/one", title: "One", persona: "roam" });

eq("revisiting does not add a row", r.state.history.length, 2);
eq("revisiting counts", r.state.history.find((e) => e.url.includes("one")).n, 2);
eq("the most recent is first", r.state.history[0].url, "https://a.example/one");

r.visit({ url: "file:///C:/thing.html", title: "local" });
eq("file: urls are not places you have been", r.state.history.length, 2);

r.retitle("https://b.example/two", "Two, renamed");
eq("a late title updates the row", r.state.history.find((e) => e.url.includes("two")).title, "Two, renamed");
eq("retitling does not count as a visit", r.state.history.find((e) => e.url.includes("two")).n, 1);

// Pins outrank history in the suggestion list, because you chose them.
r.pin({ url: "https://b.example/two", title: "Two, renamed" });
r.pin({ url: "https://b.example/two" });
eq("pinning twice pins once", r.state.pins.length, 1);
ok("isPinned agrees", r.isPinned("https://b.example/two"));

const s = r.suggest("example");
eq("the pin is first", s[0].kind, "pin");
eq("no duplicate row for the pinned url", s.filter((x) => x.url === "https://b.example/two").length, 1);
eq("both places are offered", s.length, 2);
eq("an empty query lists recent history", r.suggest("").length, 2);
eq("a miss suggests nothing", r.suggest("zzzz").length, 0);

r.unpin("https://b.example/two");
ok("unpinning works", !r.isPinned("https://b.example/two"));

// A pin may name the jar it belongs in. Without that, a pinned board you are
// signed into reopens signed out, and the four registry entries these
// replaced would have been a downgrade rather than a simplification.
r.pin({ url: "https://board.example", title: "Board", persona: "curio" });
eq("a pin remembers its jar", r.state.pins.find((p) => p.url === "https://board.example").persona, "curio");
r.pin({ url: "https://board.example", persona: "workshop" });
eq("re-pinning corrects the jar rather than duplicating",
  r.state.pins.filter((p) => p.url === "https://board.example").length, 1);
eq("and the correction takes", r.state.pins.find((p) => p.url === "https://board.example").persona, "workshop");
eq("the jar survives into the suggestion list",
  (r.suggest("board").find((x) => x.kind === "pin") || {}).persona, "workshop");

// Seeding: the registry declares pins, the browser takes each one once.
const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "roam-seed-"));
const s1 = new Roam(seedDir);
const DECLARED = [
  { url: "https://www.pinterest.com", title: "Pinterest", persona: "curio" },
  { url: "https://giphy.com", title: "Giphy", persona: "curio" },
];
eq("seeding takes the registry's pins", s1.seed(DECLARED), 2);
eq("with their jars", s1.state.pins.every((p) => p.persona === "curio"), true);
eq("seeding again adds nothing", s1.seed(DECLARED), 0);

// The one that matters: an unpin has to stick across a restart, or the
// registry would quietly undo the user's choice on every boot.
s1.unpin("https://giphy.com");
s1.flush();
const s2 = new Roam(seedDir);
eq("an unpinned seed stays unpinned after a restart", s2.seed(DECLARED), 0);
eq("and it is really gone", s2.state.pins.some((p) => p.url === "https://giphy.com"), false);

// …while a newly declared one still arrives.
eq("a pin added to the registry later is still seeded",
  s2.seed([...DECLARED, { url: "https://tenor.com", title: "Tenor", persona: "curio" }]), 1);
fs.rmSync(seedDir, { recursive: true, force: true });

// Forgetting is per-jar, which is the point of having jars.
eq("forget by persona removes only that jar's rows", r.forget({ persona: "curio" }), 1);
eq("the other jar's row survives", r.state.history.length, 1);
r.forget({ all: true });
eq("forget all empties it", r.state.history.length, 0);

r.remember([
  { url: "https://a.example/one", persona: "roam", title: "One" },
  { url: "about:blank", persona: "roam" },          // not a place
  { url: "https://b.example/two", persona: "curio" },
]);
eq("the session keeps only real pages", r.session().length, 2);

// Durability: a restart must find the same browser.
r.flush();
const again = new Roam(dir);
eq("the session survives a restart", again.session().length, 2);
eq("the session keeps its jars", again.session()[1].persona, "curio");

// A truncated file must not stop the browser from starting.
fs.writeFileSync(path.join(dir, "state.json"), '{"history": [{"url"');
const broken = new Roam(dir);
eq("a corrupt state file yields an empty browser, not a crash", broken.state.history.length, 0);
ok("and it can still be written back", (broken.pin({ url: "https://c.example" }), broken.flush(), new Roam(dir).state.pins.length === 1));

fs.rmSync(dir, { recursive: true, force: true });

console.log(bad ? `\n${bad} failed` : "\nall passed");
process.exit(bad ? 1 : 0);
