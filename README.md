# Cowwie 🐄📅

An always-on calendar face for Android — the [Inku](https://inkboard.ink/) desk calendar, but on a phone you already own, and better.

Prop an old (or current) phone on a charging stand and Cowwie turns it into a glanceable desk calendar: a big clock, today's agenda from every calendar account synced to the phone, and a short friendly digest of the day ("3 events left · free after 4:00 PM"). Optionally, an Anthropic API key upgrades that digest into an AI-written summary via Claude.

## Features

- **Always-on dashboard** — keeps the screen awake while the app is in the foreground, full-screen and immersive.
- **Screensaver mode** — registers as an Android screen saver (daydream), so the calendar appears automatically whenever the phone is docked or charging. Enable it under **Settings → Display → Screen saver → Cowwie**.
- **Reads every synced calendar** — uses the phone's native calendar store (`CalendarContract`), so Google, Outlook, iCloud-via-sync, and anything else already on the phone shows up with no API keys or sign-in.
- **Day digest** — an instant offline one-liner ("2 of 5 events left · free after 4:00 PM"), optionally replaced by a warmer AI summary from Claude.
- **Burn-in protection** — pure-black OLED-friendly theme (off pixels can't burn in) plus a subtle pixel shift of the whole layout every 5 minutes.

## Setup

1. Open the project in Android Studio (or run `./gradlew assembleDebug`) and install on the phone.
2. Grant calendar access on first launch.
3. Optional AI summaries: **long-press anywhere** on the dashboard, paste an Anthropic API key, and save. The model defaults to `claude-opus-5`; swap in another model ID if you prefer.
4. For dock/charging mode: **Settings → Display → Screen saver**, choose Cowwie, and set it to start while charging or docked.

## Notes

- Keep the phone plugged in for always-on use — an awake screen drains battery quickly otherwise.
- The AI summary refreshes only when the day's events actually change, so API usage is a handful of small requests per day.
- With no API key set, the app is fully offline.

## Project layout

```
app/src/main/java/com/cowwie/
├── MainActivity.kt              # always-on activity: wake lock, immersive mode, permission flow
├── data/
│   ├── CalendarRepository.kt    # today's events via CalendarContract.Instances
│   └── Settings.kt              # API key + model in SharedPreferences
├── summary/
│   ├── LocalSummarizer.kt       # offline "free after 4pm" one-liner
│   └── ClaudeSummarizer.kt      # AI digest via the Anthropic Java SDK (optional)
├── ui/
│   ├── DashboardScreen.kt       # clock, digest, agenda list, pixel-shift
│   ├── SettingsDialog.kt        # long-press settings
│   └── Theme.kt                 # pure-black OLED theme
└── dream/
    └── CalendarDreamService.kt  # screensaver (daydream) hosting the same UI
```
