# Tech Stack

- Native Android app (Cowwie): Kotlin, Gradle Kotlin DSL, Java 17, AGP 8.7, Kotlin 2.1, minSdk 26, compileSdk/targetSdk 35.
- UI is Jetpack Compose with Material 3 (`androidx.activity:activity-compose`). Activities only host `setContent`; screens live in `app/src/main/java/com/cowwie/ui/`.
- Async work uses Kotlin coroutines (`kotlinx-coroutines-android`). UI state is Compose state (`remember` / `mutableStateOf`), not ViewModel or a DI framework.
- Calendar data comes from the device `CalendarContract` via `ContentResolver` in `data/CalendarRepository.kt`. Do not add Google Calendar, Outlook, or other remote calendar SDKs.
- Small persistent settings (API key, model id) use `SharedPreferences` in `data/Settings.kt`. Do not add DataStore, Room, or a database unless the user asks for structured local storage beyond that.
- Optional AI digests use the Anthropic Java SDK (`com.anthropic:anthropic-java`) in `summary/ClaudeSummarizer.kt`, called on `Dispatchers.IO`. Always keep `LocalSummarizer` as the offline fallback.
- Day/time math uses `java.time` (`LocalDate`, `ZoneId`, `DateTimeFormatter`). Do not use `java.util.Calendar` or Joda-Time.
- Dependencies are declared only in `app/build.gradle.kts`, versions via the Compose BOM where it applies. Do not add a second module or a `libs.versions.toml` unless asked.

# Library Rules

- UI: Jetpack Compose + Material 3 only. No XML layouts, ViewBinding, Fragments, or third-party UI kits (no Compose Destinations, Accompanist, Coil unless image loading is explicitly requested).
- Theming: keep the pure-black OLED `CowwieTheme` in `ui/Theme.kt`. Do not introduce a light theme or dynamic Material You colors for the always-on dashboard.
- Navigation: start new screens as a `ComponentActivity` plus a `@Composable` screen, launched with an `Intent`. Do not add Navigation-Compose or a router library for this small app.
- Permissions and activity results: `ActivityResultContracts` and `ContextCompat`, not the deprecated `requestPermissions` / `startActivityForResult`.
- Files and photos: AndroidX `FileProvider` and the system camera intent. Do not add a camera SDK. Use `androidx.exifinterface` only when reading EXIF (for example orientation).
- Networking: only the Anthropic Java SDK. Do not add OkHttp, Retrofit, Ktor, or another HTTP client. Do not log or hardcode API keys.
- Storage of people/photos stays in the app's private files directory. Do not upload photos or calendar contents anywhere except the optional Claude summary request.
- Icons and simple drawings: Compose Canvas / vector drawables. Do not pull in an icon font or image CDN.
- Tests, if added: JUnit for pure Kotlin (`LocalSummarizer`, time formatting). Do not add Espresso or screenshot tooling unless asked.
- Strings shown to the user can live in Compose for short dashboard copy; reusable labels go in `res/values/strings.xml`.
