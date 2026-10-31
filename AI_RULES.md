# Tech Stack

Two products in one repo: **Professional Goat**, the Android phone app at the
root (`app/`), and **Ifreglen**, the Electron desktop platform in `desktop/`.
They talk over the phone bridge described in `desktop/README.md`.

## Professional Goat (Android, `app/`)

- Native Android app: Kotlin, Gradle Kotlin DSL, Java 17, AGP 8.7, Kotlin 2.1, minSdk 26, compileSdk/targetSdk 35. Build with `./gradlew assembleDebug` (JAVA_HOME = Android Studio's `jbr`).
- Kotlin package is `com.professionalgoat`; the `applicationId` stays `com.cowwie` on purpose so an install over the old Cowwie build keeps its People photos and settings. Do not change it.
- UI is Jetpack Compose with Material 3 (`androidx.activity:activity-compose`). Activities only host `setContent`; screens live in `app/src/main/java/com/professionalgoat/ui/`.
- Async work uses Kotlin coroutines (`kotlinx-coroutines-android`). UI state is Compose state (`remember` / `mutableStateOf`), not ViewModel or a DI framework. Lifecycle hooks use `androidx.lifecycle:lifecycle-runtime-compose`.
- Calendar data comes from the device `CalendarContract` via `ContentResolver` in `data/CalendarRepository.kt`. Do not add Google Calendar, Outlook, or other remote calendar SDKs.
- Small persistent settings (API key, model id, desk pairing) use `SharedPreferences` in `data/Settings.kt`. People and follow-ups are small JSON files in the private files dir (`PersonRepository`, `TaskRepository`). Do not add DataStore, Room, or a database unless the user asks for structured local storage beyond that.
- Optional AI digests use the Anthropic Java SDK (`com.anthropic:anthropic-java`) in `summary/ClaudeSummarizer.kt`, called on `Dispatchers.IO`. Always keep `LocalSummarizer` as the offline fallback. Only event titles and times are ever sent; never People, follow-ups, or message text.
- The desk bridge (`desk/`) uses `java.net.HttpURLConnection` with a bearer token, plain HTTP on the LAN (`usesCleartextTraffic`). Route paths are Ifreglen's (`/ping`, `/briefs`, `/notes`, `/mut/comms*`); change them in both places or not at all. `DeskLink` parses every pairing-link shape and is unit-tested.
- `desk/DeskNotificationListener` is a `NotificationListenerService`. It never sends one-time codes (`desk/Sensitive.kt`), its own notifications, group summaries, or ongoing notifications except a ringing call. It logs flags and counts, never message words.
- Day/time math uses `java.time` (`LocalDate`, `ZoneId`, `DateTimeFormatter`). Do not use `java.util.Calendar` or Joda-Time.
- Dependencies are declared only in `app/build.gradle.kts`, versions via the Compose BOM where it applies. Do not add a second Gradle module or a `libs.versions.toml` unless asked.

### Library rules (Android)

- UI: Jetpack Compose + Material 3 only. No XML layouts, ViewBinding, Fragments, or third-party UI kits (no Compose Destinations, Accompanist, Coil unless image loading is explicitly requested).
- Theming: keep the pure-black OLED `GoatTheme` in `ui/Theme.kt`. Do not introduce a light theme or dynamic Material You colors for the always-on dashboard.
- Navigation: start new screens as a `ComponentActivity` plus a `@Composable` screen, launched with an `Intent`. Do not add Navigation-Compose or a router library for this small app.
- The dashboard is also rendered by `dream/CalendarDreamService`, which has no activity-result registry: anything that calls `rememberLauncherForActivityResult` must sit behind `interactive == true`.
- Permissions and activity results: `ActivityResultContracts` and `ContextCompat`, not the deprecated `requestPermissions` / `startActivityForResult`.
- Files and photos: AndroidX `FileProvider` and the system camera intent. Do not add a camera SDK. Use `androidx.exifinterface` only when reading EXIF (for example orientation).
- Networking: only the Anthropic Java SDK and `HttpURLConnection`. Do not add OkHttp, Retrofit, Ktor, or another HTTP client. Do not log or hardcode API keys or the desk token.
- Storage of people/photos/follow-ups stays in the app's private files directory. Do not upload photos or calendar contents anywhere except the optional Claude summary request; notes and notifications go only to the paired desk.
- Icons and simple drawings: Compose Canvas / vector drawables. The launcher icon is generated from the pixel grid in `ui/GoatAvatar.kt`; change the grid and regenerate, never hand-edit the path numbers.
- Tests: JUnit 4 under `app/src/test` for pure Kotlin (`DeskLink`, `Sensitive`, `LocalSummarizer`). Do not add Espresso or screenshot tooling unless asked.
- Strings shown to the user can live in Compose for short dashboard copy; reusable labels go in `res/values/strings.xml`.

## Ifreglen (Electron, `desktop/`)

- Read `desktop/CLAUDE.md` before changing anything there. It is a stripped clone of the Xixoxis shell; its constraints (rail overlay rule, capability stripping for external pages, no native modules, `${SHELL}`/`${ROOST}` roots, secrets as `${NAME}` placeholders) still hold.
- Hosted apps live in `desktop/apps/<id>/` (unlike Xixoxis, where apps were sibling repos). Kenoma (`C:\Forge`) and Haruspex (`C:\haruspex`) stay external and are registered by path.
- Zero npm dependencies in `desktop/lib` and `desktop/apps`: Node 22 built-ins only. Never `npm audit fix --force`.
