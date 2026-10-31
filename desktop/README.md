# Ifreglen — the desktop shell

Ifreglen is an Electron shell that houses a healthcare HR professional's work
apps in one window and talks to their phone (**Professional Goat**, the Android
app at the root of this repo). It is a rebranded, stripped-down fork of the
Xixoxis platform: same rail, same in-shell browser (The Wilds), same clip
archive (the Trove), same herald (Auri's cards), same Kenoma and Haruspex
integration — with the experiment, capture, GPU-node, hoard-following and
companion machinery removed.

The `window.roost` / `roostChrome` API names are kept deliberately: renaming
them would break every hosted app for zero functional gain. Treat "roost" in
code as the API's name, and Ifreglen as the platform's.

## Run

```bash
cd desktop
npm install          # ~13 packages: electron + qrcode. Never `npm audit fix --force`.
npm start
```

Flags: `--data-dir=<dir>` moves the shell's runtime state (Trove, briefs,
notes, ui-state, the browser's memory); `--user-data-dir=<dir>` moves
Chromium's profile; `--sync-port=<n>` moves the phone bridge off 8793;
`--no-egress` browses direct instead of through Haruspex; `--no-pull` is
accepted and ignored (there is no hoard to follow any more); `--app=<id>` boots
straight into one app; `--devtools` opens the rail's devtools.

Secrets live in gitignored `secrets.json` (`${NAME}` placeholders in the
registry resolve from the environment, then that file). The bridge's bearer,
`MUT_SYNC_TOKEN`, is minted on first boot. Machine-specific roots live in
gitignored `roots.json` (`${ROOST}`, `${SHELL}`, `${HOME}`; `IFREGLEN_ROOST=…`
overrides for one run, and the old `XIXOXIS_*` names are still read).

## The registry (`apps.config.json`)

| id | name | kind | where |
|---|---|---|---|
| `launcher` | Ifreglen | static | `renderer/lounge` — the home screen: the painting with the signposts. Arrows/WASD or a controller walk them, Enter opens, M mutes |
| `roam` | The Wilds | browser | the open web, in-shell; tabs per cookie jar |
| `lookout` | Lookout | local | `apps/lookout`, `node server.js` → :8812 |
| `credentials` | Credentials | static | `apps/credentials/index.html`, fs root `data/apps/credentials` |
| `onboarding` | Onboarding | static | `apps/onboarding/index.html`, fs root `data/apps/onboarding` |
| `drafts` | Drafts | local | `apps/drafts`, `node server.js` → :8815; letters and emails from templates, written by Kenoma |
| `haruspex` | Haruspex | local | `${ROOST}/haruspex`, starts with the shell, Egress Guard on :8789 (win32 only) |
| `trove` | The Trove | static | `renderer/trove`, fs root `data/trove` |
| `forge` | Kenoma | local | `${ROOST}/Forge`, `node server.js` → :8890 |

Unlike Xixoxis, Ifreglen's own apps live **in this repo**, under `apps/`
(`${SHELL}/apps/...`). Kenoma and Haruspex stay outside projects beside
`${ROOST}`. A static app whose `index.html` is not on disk yet shows the
offline notice in its tile and a warning at boot; it never takes the shell down.

## The phone bridge (`lib/mutsync.js`)

One HTTP server, `0.0.0.0:8793` (walks to 8803+ if taken; `--sync-port` pins
it). Every route except `/ping`, `/test`, `/install`, `/pair`, `/goat.apk` and
`/mut.apk` wants `Authorization: Bearer <MUT_SYNC_TOKEN>`. Routes marked
**loopback** also refuse any request not addressed to `localhost`/`127.0.0.1`
from this machine. Where it listens is written to `data/services.json` and
exported to children as `IFREGLEN_PORT` (and `XIXOXIS_PORT`).

| route | who | what |
|---|---|---|
| `GET /ping` | anyone | `{ok:true, who:"ifreglen", port, app:"Professional Goat"}` |
| `GET /install` | anyone | install page; carries the pairing link **only when asked for from this machine** |
| `GET /pair?token=…` | anyone | pair page with an `intent://pair?token=…&host=…#Intent;scheme=goat;package=com.cowwie;S.browser_fallback_url=…;end` button; prints only the token in its own address |
| `GET /goat.apk` (`/mut.apk` alias) | anyone | `../app/build/outputs/apk/debug/app-debug.apk` (`GOAT_APK_PATH` overrides); 404 until built |
| `POST /briefs` | **loopback**, bearer | body `{source, title, body?, level?: "quiet"\|"normal"\|"urgent", url?, when?}` → `{ok:true, id}`; 400 `{error}` |
| `GET /briefs?since=<ms>` | bearer, any address | `{ok:true, briefs:[{id, source, title, body, level, url, when, read}]}` newest first, max 50 |
| `POST /briefs/ack` | bearer, any address | `{ids:[…]}` → `{ok:true, acked:n}` |
| `POST /notes` | bearer, any address | `{text, when?}` → `{ok:true, id}`; appended to `data/notes.jsonl`, raised as a band-2 card "Professional Goat · note" |
| `GET /notes` | **loopback**, bearer | `{ok:true, notes:[{id, text, when, from:"phone"}]}` last 100, newest first |
| `POST /mut/comms`, `GET /mut/comms/outbox`, `POST /mut/comms/ack` | bearer, any address | the phone's notifications in, replies out (`lib/comms.js`) |
| `GET /errands/next`, `POST /errands/<id>`, `GET /errands/status` | bearer, any address | the phone takes and answers single-URL fetches |
| `POST /errands`, `GET /errands/<id>` | **loopback**, bearer | Kenoma files and reads an errand |
| `POST /mut/forge/ask`, `/voice`, `/abort`, `GET /mut/forge/approvals`, `POST /mut/forge/approve` | bearer, any address | relayed to Kenoma on :8890 |
| `POST /wilds/<verb>` | **loopback**, bearer | drive The Wilds (`wilds-mcp.mjs` turns this into MCP) |
| `POST /herald/notify`, `/task`, `/reload`, `/state` | **loopback**, bearer | file a card, report a task, read the queue |
| `GET /bus/stream?topics=…` | **loopback**, bearer | the bus as Server-Sent Events |
| `GET /compute` | **loopback**, bearer | always `{t, nodes:[]}` here |
| `GET /mut/sync/hello` | bearer | `{ok, who:"ifreglen", app, have:[]}` — a greeting, nothing to reconcile |

A brief is also one of Auri's cards (band 2, open/dismiss only) unless its
`level` is `"quiet"`. Hosted apps that cannot hold the bearer publish
`briefs.file` on the bus with `{title, body?, level?, url?, when?}`; the shell
sets `source` to the publishing app's id. Briefs are kept in memory (200) and
appended to `data/briefs.jsonl`; acks are appended as `{id, ack:<briefId>, t}`.

## Tests

```bash
node test.js                 # the shell against real Electron (once: npm i --no-save playwright)
node lib/watch-test.js
npm run test:roots
node lib/roam-test.js
npm run test:herald          # lib/herald-test.js, then heraldtest.js against Electron
npm run test:comms           # lib/comms-test.js, then the emulator part (skips with no device)
npm run test:trove
npm run test:beside
npm run test:mutsync
npm run test:briefs
```

`npm run test:egress` starts Haruspex and `cartridgetest.js` wants Kenoma; run
them only when you mean to.

## The morning brief (`lib/morning.js`)

Once a working day, at a time you set (default 07:30, Monday to Friday), the
desk files one brief: Lookout's unacknowledged changes since yesterday (the
top three by score, urgent if any scored 70+) and the notes the phone sent.
It lands on the phone and as one of Auri's cards. A morning the shell was
closed through is filed at the first tick after it opens, once, never twice.

- `POST /morning` (loopback, bearer): file it now.
- `GET /morning/schedule` → `{time, days}`; `POST /morning/schedule {time:"06:45", days:[1,3,5]}` sets it (days 0–6, Sunday 0). Kept in `data/morning.json`.

## Drafts (`apps/drafts`)

Ten templates for the messages HR writes every week (leave decision, policy
reminder, schedule change, meeting recap, performance note, welcome, complaint
acknowledgment, benefits reminder, announcement, reply). The form takes the
facts; Kenoma (`KENOMA_URL`, default :8890, session `drafts`) writes the
finished text, in a chosen tone and length. When Kenoma is down or busy the
plain template is filled instead and the page says so. Nothing is sent from
the app: you copy the draft into your mail. History in `data/drafts.jsonl`.
Kenoma writes with whatever model it is configured for, an outside service,
so keep patient information out of the forms.
