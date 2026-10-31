# CLAUDE.md

Context for Claude Code working in `desktop/`. Read this before changing
anything — several constraints here are not discoverable from the code alone.

## What this is

This is **Ifreglen**, the desktop shell: an Electron window that houses a
healthcare HR professional's work apps (Lookout, Credentials, Onboarding), an
in-shell browser (The Wilds), a clip archive (the Trove) and a herald (Auri's
cards), and runs the phone bridge that **Professional Goat** (the Android app
at the repo root, package `com.cowwie`) talks to. It is a stripped fork of the
Xixoxis platform; the `window.roost` / `roostChrome` API names are kept on
purpose, because every hosted app is written against them.

**Unlike Xixoxis, Ifreglen's own apps live in this repo, under `apps/`.** The
registry reaches them as `${SHELL}/apps/<id>` (`lib/roots.js`; `SHELL` is this
folder). Kenoma (`C:\Forge`) and Haruspex (`C:\haruspex`) are still outside
projects beside `${ROOST}`, registered by path and never copied in. A static
app whose `index.html` is not on disk yet gets the offline notice in its tile
and a warning at boot, never a crash — the apps are built here concurrently
and may lag the registry.

## Layout

```
desktop/             the shell. Electron main, preloads, renderer, lib/, apps/
  apps.config.json     the registry — one entry per app
  main.js              main process: windows, capabilities, The Wilds, herald, bridge wiring
  apps/                Lookout, Credentials, Onboarding, Drafts; _shared/ is the UI kit they all load
  renderer/lounge      the home screen: art/sanctum.jpg with the signposts as hotspots (legacy.html is the old tile page)
  renderer/herald      Auri's cards — approvals, questions, crashes, briefs, notes
  renderer/roam        The Wilds — the browser's own bar and its blank page
  renderer/trove       the clip archive; its Apps tab holds the phone's two QR codes
  renderer/beside      the chat docked down the right
  lib/                 mutsync (the bridge), briefs, comms, herald, clip, watch, forge, roam, netpolicy
  wilds-mcp.mjs        the browser's doorway for agents, spoken as MCP
  data/                runtime state (gitignored): trove, briefs.jsonl, notes.jsonl, apps/<id>, services.json
```

## Commands

```bash
cd desktop && npm install && npm start      # 13 packages; never `npm audit fix --force`

node test.js                 # the shell against real Electron (once: npm i --no-save playwright)
node lib/watch-test.js       # the watcher
npm run test:roots           # ${ROOST}/${SHELL} resolution
node lib/roam-test.js        # the omnibox rule, history, pins
npm run test:herald          # the queue on a fake clock, then against Electron
npm run test:comms           # the bridge's rules, then the emulator part (skips with no device)
npm run test:trove           # the Venture tab compiled into the archive
npm run test:beside          # the docked chat
npm run test:mutsync         # the bridge: auth, loopback, briefs, notes, errands
npm run test:briefs          # lib/briefs.js on its own
```

`npm run test:egress` starts Haruspex and `cartridgetest.js`/`wildsmcptest.js`
want Kenoma or the network; run them only when you mean to.

## The briefs / notes contract (what the phone and the apps rely on)

**A brief** is a thing an app wants the person to know wherever they are.
`POST /briefs` on the bridge (loopback only, bearer) with
`{source, title, body?, level?, url?, when?}` → `{ok, id}`. A hosted app that
cannot hold the bearer publishes `briefs.file` on the bus with the same body
minus `source` — main.js sets `source` to the publishing app's id and never
trusts the payload's. `lib/briefs.js` bounds every field, keeps 200 in
memory, appends each to `data/briefs.jsonl`, and answers `GET /briefs?since=`
(bearer, any address — the phone) newest first, max 50, as
`{id, source, title, body, level, url, when, read}`. `POST /briefs/ack {ids}`
marks them read (an ack is its own JSONL line, `{id, ack, t}`). `level` is
`quiet | normal | urgent`; anything else is `normal`.

**A note** is the other direction: `POST /notes {text, when?}` from the phone
(bearer, any address) → appended to `data/notes.jsonl`, raised as a band-2
card "Professional Goat · note", open/dismiss. `GET /notes` (loopback) is the
last 100.

**A brief is also a card.** `briefFile()` in main.js raises it at band 2 with
`open`/`dismiss` only, unless `level` is `quiet`. Only main.js may raise an
approval (`notify(item, {internal:true})`), and a brief or note never is one:
nothing the phone or an app files can carry an answer back to anyone.

**The morning brief is a scheduled brief.** `lib/morning.js` keeps a clock in
the shell (not a cron: the shell is what is up when the laptop is) and files
one brief per working day with Lookout's fresh findings and the phone's notes;
`data/morning.json` holds the schedule and the last day filed, so a missed
morning is filed once at the next tick and never twice. `POST /morning` and
`GET|POST /morning/schedule` are loopback-only on the bridge. `lib/morning-test.js`
runs it on a fake clock and a fake Lookout.

**Drafts uses Kenoma as a writer, not a coder.** `apps/drafts/server.js` posts
to Kenoma's `/chat` with `sessionId: "drafts"`, `interactive: false`, and a
prompt that forbids tools; it joins the `text` events and stops at `done`. A
409 means Kenoma is mid-turn and the plain template answers. Kenoma's model is
an outside service: the page says so and asks for no patient information.

`/ping` answers `{ok, who:"ifreglen", port, app:"Professional Goat"}`; the
phone checks `who`. The install page serves `GET /goat.apk` from
`../app/build/outputs/apk/debug/app-debug.apk` and the pair page's deep link
is `intent://pair?token=…&host=…#Intent;scheme=goat;package=com.cowwie;…`.
The secret's name stays `MUT_SYNC_TOKEN` and every route PATH is unchanged
from Xixoxis (`/mut/comms`, `/errands/*`, `/mut/forge/*`, `/wilds/*`,
`/herald/*`, `/bus/stream`, `/compute`), so the phone client and Kenoma keep
working. `/compute` always answers an empty roster here.

## Non-obvious constraints

**The chrome is a left-rail WebContentsView clipped to the rail's width.**
Anything wider than the rail (236px full, 64px collapsed) is invisible and
unclickable. Overlays (palette, find, discovery sheet) MUST call
`roostChrome.overlay(true)` first — the main process widens the view to the
full window and raises it; `roost:rail` handles fold/unfold. The 46px-toolbar
version of this bug was real and it will recur with any new modal that skips
the overlay call.

**External apps never get `fs`, `apps` or `bus`.** `effectiveCaps()` in
`main.js` strips them all from any app with `kind: "external"`, regardless of
the registry. A remote page with disk access is RCE wearing a config file, and
one that can drive apps or ride the bus can steer the shell. Do not "fix" this
if a config seems to be ignored. Same for `fs` without a declared `root`.
`clip` is deliberately NOT stripped: it exposes nothing to the page and only
tells the shell to offer clip verbs. test.js asserts both.

**`electron . --data-dir=<dir>` moves the shell's runtime state.** DATA is what
the Trove, briefs, notes, `ui-state.json`, `data/apps/<id>` and the browser's
memory all hang off, so one flag gives you a disposable shell. It is the
sibling of `--user-data-dir`, which moves Chromium's profile. Every Electron
suite passes both, which is the only reason a test may assert on clipping at
all: the Trove's index is append-only evidence.

**`electron . --sync-port=<n>` moves the bridge.** `--data-dir` and
`--user-data-dir` are not enough for a second shell: without this the parallel
instance collides on 8793, silently loses its own server to EADDRINUSE, and
then answers on the FIRST shell's — which presents as "my new routes 404". The
default port walks (8793, then 8803+); a typed one does not.

**A test shell passes `--no-egress`.** It routes direct instead of through
Haruspex, so a suite does not depend on Haruspex being installed and up, or on
the network's category. `--no-pull` is accepted for the old harnesses' sake and
does nothing: the hoard-following is gone.

**The browser is the shell's own machinery, not a second one.** A tab in The
Wilds (`kind: "browser"`, id `roam`) is a `WebContentsView` built by
`createView()` from a synthesized config of `kind: "external"`. That word is
load-bearing: it is what makes `effectiveCaps` strip `fs`, `apps` and `bus`
from a web page by the same code path as any other remote site. Do not give
tabs their own capability logic. Tabs are NOT in `views`; that map means
"hosted apps", and `roamLayout()` stands in for the zeroing loop.

**Links out of a hosted app go to The Wilds, not to Chrome.** `openWeb()` is
the one place that decides. `shell.openExternal` is reserved for non-web
schemes and for the explicit "open in system browser" verbs.

**Beside is a chat docked down the right, and the app area ends where it
begins.** Ctrl+J opens it and puts the page in front into the chat's box as
the distillate; it never presses send. In `layout()` and `roamLayout()`,
`width` is the window less Beside's column: anything new that floats or pins
to the right edge must lay out against that.

**The browser's bar is a view 76px tall, so its dropdown must grow it first.**
`roostRoam.expand(true)` widens the bar view over the page area. The rail's
overlay rule rotated ninety degrees; it recurs with every new modal.

**An agent may drive the browser, through one door, in its own jar.**
`wildsControl()` in main.js is the whole surface; `lib/mutsync.js` exposes it
as `POST /wilds/<verb>` (loopback, bearer), and `wilds-mcp.mjs` turns that into
MCP (`mcp_discover {label: "wilds", command: "node <desktop>/wilds-mcp.mjs"}`).
Agent tabs default to the `agent` persona, a jar with no logins in it; any
other jar must be named explicitly. `wilds_read` fences what it returns as
untrusted data.

**A read is distilled in the page, not dumped.** `lib/distill.js` is a real
function stringified by `distillJs()`, so it must stay self-contained: no
closures, no requires, it runs in the page's world. `readPage()` falls back to
innerText when the distillate is nearly empty against a page that has text.

**Every MCP payload is escaped to pure ASCII before framing.** Kenoma's client
measures `Content-Length` in BYTES but slices its buffer as a STRING, so one em
dash desynchronises its parser. `wildsmcptest.js` reproduces the mismatch.

**`act {do:"key"}` presses a real key** through Chromium's input pipeline
rather than dispatching a KeyboardEvent, because a dispatched one carries
`isTrusted:false` and chat boxes and login forms check it.

**A wall means stop.** The chat verb checks for an anti-automation page before
it sends and returns `blocked`. Nothing here ever tries to get past one.

**On Windows, `127.0.0.1:N` binds beside `0.0.0.0:N` and then wins every
loopback connection.** Linux refuses the second bind; Windows does not. The
bridge binds `0.0.0.0` and walks off a port something else holds; anything new
that binds loopback should probe first.

**The pairing code is printed on the LAN address, and carries the others.**
`addresses()` in `lib/mutsync.js` ranks private ranges first and 100.64/10
last: a VPN's WireGuard interface can come up before Wi-Fi and the code once
pointed the phone at an address only the VPN could reach. The rest ride in the
QR's fragment (`#alt=host:port,...`); the phone tries them when the first does
not answer.

**The install page keeps the key in the house.** `/install` carries the
pairing link only when asked for from this machine (`fromThisMachine`: a
loopback socket AND a `Host` of localhost). It used to print the server's own
token to anyone on the wifi, and that token drives The Wilds, the bus and
Kenoma. `/pair` prints only the token in its own address. The phone pairs from
the Trove's "Professional Goat — pair" code, shown on the laptop's own screen.

**The phone runs errands.** `/errands` is a queue of single-URL fetches: Kenoma
files one (loopback), the phone takes it on its poll and answers from its own
connection. A fetch and nothing else; the phone never runs a command.

**Müt is gone; Auri carries his lines.** `lib/companion.js` still runs as a
mind with no body: its quiet-hours clock is what the herald's `isQuiet` reads,
and what he would have said at priority 2+ becomes one of Auri's cards (`who:
"Ifreglen"`). `mutRetired()` is always true. There is no `renderer/mut`, no
`preload-mut.js`, no `roost:mut` IPC; Ctrl+M summons Auri.

**Only main.js can raise an approval.** `notify(item, {internal: true})` is the
only way a card gets `allow`/`deny`/`answer` buttons or carries `meta`,
because only main's own code can take the answer back to whoever asked.
POST /herald/* (a process on this machine, behind the bearer) may be loud
(band 3) but its approvals are turned into plain cards; an app on the bus is
held to band 2 with open/dismiss/later/mute only. heraldtest.js runs with
`FORGE_PORT` pointed at nothing: it presses Allow.

**Her view is sized to what she draws, and zero means hidden.** A transparent
WebContentsView still swallows every click inside its bounds, so her page
reports its own height and width (`roost:herald` "bounds"). With nothing to
say she RESTS as a framed portrait in the corner, about 100 px square. New
floating views go through `raiseFloats()`.

**The keyboard reaches her only on Ctrl+\`.** Her single-letter keys work only
after `heraldSummon()` focuses her view; Ctrl+\` again, Esc on an empty corner,
or answering the last card gives the keys back (`focusActive`).

**The phone's notifications reach the laptop, and live only in its memory.**
Professional Goat's `DeskNotificationListener` posts every notification to
`POST /mut/comms` and types replies from `GET /mut/comms/outbox` into each
notification's own Reply action. `lib/comms.js` triages them into cards,
settles a card when the notification is cleared on the phone, and holds
everything in the drawer while you are away. One-time codes are dropped on the
phone AND here. Message text is untrusted: displayed, never handed to a model,
never put on the bus, never written to disk. Briefs and notes, by contrast,
ARE written (JSONL) — they are the person's own work, not other people's words.

**The Wilds' traffic goes through Haruspex's Egress Guard; it fails over to
direct only on a VPN off public networks.** `applyEgressProxy` gives every
session `http://127.0.0.1:8789`, plus `,direct://` only while
`lib/netpolicy.js` says so. `updateEgressState` must call
`forceReloadProxyConfig`. The shell learns Haruspex is up by watching 8789
(`whenEgressListens`) and reloads pages that failed only because the proxy was
not listening yet. Entries with `platforms` are dropped elsewhere at
`loadConfig()`. Haruspex is `startWithShell` and the shell is its only
supervisor: with `XIXOXIS_SHELL` set (the shell sets both it and
`IFREGLEN_SHELL`) it starts no watchdog of its own. `doEnsureLocal` spawns with
`windowsHide`.

**Browsing history is not the Trove.** `data/roam/state.json` is bounded and
switchable off (`"history": false`). The Trove's index stays append-only and
holds only what you explicitly pointed at.

**No native modules, deliberately.** `better-sqlite3` would need a per-Electron
rebuild. Everything the shell records is JSONL.

**`electron-builder` is not a devDependency.** `npm install` here should stay
at 13 packages / 0 advisories. Never run `npm audit fix --force`.

**Live reload starts on `did-finish-load`, after `activate()` sends `active`.**
Listen for `watch-state`, don't read it once from `active`. Static apps watch
by default, local apps don't, external never.

**Ports are read from dev-server stdout, not guessed.** `ensureLocal()` sniffs
the child process output for a localhost URL when the entry has no `url`.

**Secrets are `${NAME}` placeholders resolved at load.** Tokens live in
gitignored `secrets.json` or the environment, never in the registry. Registry
PATHS use the same syntax against gitignored `roots.json` (`lib/roots.js`;
`ROOST`, `SHELL`, `HOME` always exist). The two need opposite failures: an
unresolved `${TOKEN}` stays literal and complains, an unresolved `${ROOST}`
falls back to `C:\` so a fresh clone boots.

**`data/` is runtime state, not source.** Gitignored on purpose, and it is
real data — it survives a reinstall but nothing regenerates it.

## Left in place but unreachable

`lib/clip.js` still carries `toGlamoire` / `toBrain` / `glamoireCharacters`
fanout helpers and `roost:clip-characters`; nothing in the UI reaches them any
more (the Glamoire submenu and the "ask the Brain" checkbox are gone).
`roost:forge` (`ask`/`abort`/`restart`/`voice`/`speak`) stays on the rail's
preload for the Forge sheet. `lib/companion.js` runs as described above.

## User environment

Windows, Python 3.13 at `C:\Python313`, Node v22. Managed Chrome blocks
unpacked extensions. OneDrive-redirected Desktop, so never hardcode
`C:\Users\<name>\Desktop`.

## Style

Comments explain *why*, especially where a choice looks wrong without context
(JSONL over SQLite, capability stripping, no native modules). Keep them.

**The apps share one look, `apps/_shared/ifreglen-ui.{css,js}`.** The kit owns
colour, type, the plank title bar, buttons, tabs, panels, focus, motion and
the (off by default) click sounds; an app's own `<style>` holds layout only.
Static apps link `../_shared/`; Lookout and Drafts serve the same files at
`/_ifreglen/` from their own servers. Do not copy rules out of the kit into
an app, and do not fetch fonts: it uses Windows' own faces.

**The home page is the game.** Boot (once per session, `sessionStorage`),
lantern glow and ember canvas, mouse parallax, a plaque at the foot of the
painting for the selected sign, an iris-in on open, keyboard, WASD and
gamepad walking, and a synthesiser for the knocks and bells (on by default,
`home:sound` in the launcher's store). Sign hotspots are percentages of the
painting; Drafts has no painted plank, so the page draws one. Sparks are
styled on the `<defs>` original (`#burst`), never through `.sparks`, because
a `<use>` clone takes its paint from there.
