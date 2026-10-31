# Professional Goat 🐐 + Ifreglen

A phone and a desk that work the same day job: healthcare HR.

- **Professional Goat** (`app/`) is the Android app. Prop the phone on a stand and
  it is an always-on work face: a big clock, today's agenda from every calendar
  account on the phone, the day's follow-ups, faces-to-names for everyone you
  meet, and whatever the desk sent over. Formerly Cowwie; installs over it.
- **Ifreglen** (`desktop/`) is the desktop platform: an Electron shell with a
  real browser (The Wilds), a clip archive (the Trove), the Kenoma coding agent,
  Haruspex guarding the network, and four HR apps built for it: **Lookout**
  (monitoring and research bot), **Drafts** (letters and emails written by
  Kenoma from templates), **Credentials** (licence and certification
  compliance), and **Onboarding** (new-hire pipeline). Every working morning
  the desk files a brief of what changed overnight. See `desktop/README.md`.

The two are paired over the LAN with one QR code. The desk's briefs land on the
phone's dashboard; a spoken note on the phone lands as a card on the desk; the
phone's messages and calls show as cards on the desk and the desk's replies are
typed back into them.

## The phone

### What it does

- **Always-on dashboard**: keeps the screen awake while in the foreground,
  full-screen, pure-black OLED theme with a pixel shift every five minutes.
- **Screensaver mode**: registers as an Android screen saver, so the dashboard
  appears whenever the phone is docked or charging (Settings → Display → Screen
  saver → Professional Goat).
- **Every synced calendar**: reads the phone's native calendar store, so the
  work Outlook/Google account already on the phone shows up with no sign-in.
- **Day digest**: an instant offline line ("2 of 5 events left · free after
  4:00 PM · 3 follow-ups"), optionally an AI digest via Claude with an API key.
- **Follow-ups**: typed or spoken, due today/tomorrow/next week, optionally
  about someone in People. Overdue and today's show on the dashboard; tap the
  ring to complete.
- **People**: take a picture, say their name, add role, department and a note.
  New hires at orientation, candidates, the charge nurse you met once. Share or
  save a photo, or start a follow-up about them.
- **Desk link**: pair with Ifreglen; see its briefs; send a spoken note; bridge
  notifications (opt-in via Android's notification access).

### Setup

1. Build: `./gradlew assembleDebug` with `JAVA_HOME` pointed at Android
   Studio's `jbr`, then install `app/build/outputs/apk/debug/app-debug.apk`.
   Ifreglen also serves the latest build at `/goat.apk`.
2. Grant calendar access on first launch.
3. **Pair with the desk**: long-press the dashboard → Desk link. Scan the
   pairing QR (Ifreglen → Trove → Apps → Professional Goat) with the camera
   and choose *Open in Professional Goat*, or paste the link.
4. **Notification bridge** (optional): in the same dialog, *Allow notification
   access*. One-time codes never leave the phone; message text is shown on the
   desk and never stored or sent to a model.
5. **AI digest** (optional): paste an Anthropic API key. Only event titles and
   times are ever sent.
6. Dock mode: Settings → Display → Screen saver → Professional Goat.

### Project layout

```
app/src/main/java/com/professionalgoat/
├── MainActivity.kt              # always-on activity, permission flow, goat://pair deep link
├── PeopleActivity.kt            # hosts PeopleScreen
├── TasksActivity.kt             # hosts TasksScreen (follow-ups)
├── data/
│   ├── CalendarRepository.kt    # today's events via CalendarContract.Instances
│   ├── PersonRepository.kt      # photo + name + role/dept/note, JSON index
│   ├── TaskRepository.kt        # follow-ups, JSON file
│   └── Settings.kt              # API key, model, desk pairing, bridge flags
├── desk/
│   ├── DeskLink.kt              # parses every pairing-link shape (unit-tested)
│   ├── DeskClient.kt            # HttpURLConnection + bearer: /ping /briefs /notes /mut/comms
│   ├── DeskNotificationListener.kt  # the notification bridge (a system-bound service)
│   └── Sensitive.kt             # the one-time-code filter (unit-tested)
├── summary/
│   ├── LocalSummarizer.kt       # offline digest line (unit-tested)
│   └── ClaudeSummarizer.kt      # optional AI digest via the Anthropic Java SDK
├── ui/
│   ├── DashboardScreen.kt       # clock, goat, digest, briefs, follow-ups, agenda, action bar
│   ├── TasksScreen.kt           # follow-ups list and editor
│   ├── PeopleScreen.kt          # faces grid, details, follow up, share
│   ├── SettingsDialog.kt        # desk link, notification bridge, AI digest
│   ├── GoatAvatar.kt            # the pixel goat (also the launcher icon's source)
│   └── Theme.kt                 # pure-black OLED theme
└── dream/
    └── CalendarDreamService.kt  # screensaver hosting the same dashboard
```

## The desk

`desktop/` holds Ifreglen. `cd desktop && npm install && npm start`. Its own
`README.md` covers the registry, the apps, the phone protocol and the tests;
its `CLAUDE.md` holds the constraints that are not discoverable from the code.

## Notes

- Keep the phone plugged in for always-on use.
- Nothing leaves the phone except: the optional Claude request (event titles
  and times), and traffic to the paired desk on your own network.
- The AI digest refreshes only when the day's events change, so API usage is a
  handful of small requests per day.
