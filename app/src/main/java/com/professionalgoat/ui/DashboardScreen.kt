package com.professionalgoat.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.speech.RecognizerIntent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.professionalgoat.PeopleActivity
import com.professionalgoat.TasksActivity
import com.professionalgoat.data.CalendarEvent
import com.professionalgoat.data.CalendarRepository
import com.professionalgoat.data.Person
import com.professionalgoat.data.PersonRepository
import com.professionalgoat.data.Settings
import com.professionalgoat.data.Task
import com.professionalgoat.data.TaskRepository
import com.professionalgoat.desk.Brief
import com.professionalgoat.desk.DeskClient
import com.professionalgoat.summary.ClaudeSummarizer
import com.professionalgoat.summary.LocalSummarizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.random.Random

private val clockFormat = DateTimeFormatter.ofPattern("HH:mm")
private val dateFormat = DateTimeFormatter.ofPattern("EEEE, MMMM d")
private val timeFormat = DateTimeFormatter.ofPattern("h:mm a")

/** Whether the desk can be reached right now. Drives the small dot in the corner. */
enum class DeskState { Unlinked, Reachable, Silent }

/**
 * The always-on face: big clock, the goat, a one-line digest, what the desk
 * sent over, today's follow-ups, and today's agenda. [interactive] enables the
 * long-press settings and the action bar (activity only; the screensaver
 * renders the same screen without them, and must not create activity-result
 * launchers, which a DreamService cannot host).
 *
 * [deskKey] changes when the pairing does, restarting the desk loop.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun DashboardScreen(
    interactive: Boolean,
    deskKey: Int = 0,
    onDeskChanged: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val repository = remember { CalendarRepository(context) }
    val tasksRepo = remember { TaskRepository(context) }
    val peopleRepo = remember { PersonRepository(context) }
    val settings = remember { Settings(context) }
    val desk = remember { DeskClient(settings) }
    val scope = rememberCoroutineScope()

    var now by remember { mutableStateOf(LocalDateTime.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = LocalDateTime.now()
            delay(1_000)
        }
    }

    // Coming back from People or Follow-ups: reload what they may have changed.
    var resumeTick by remember { mutableIntStateOf(0) }
    LifecycleResumeEffect(Unit) {
        resumeTick++
        onPauseOrDispose { }
    }

    var events by remember { mutableStateOf(listOf<CalendarEvent>()) }
    LaunchedEffect(Unit) {
        while (true) {
            events = withContext(Dispatchers.IO) { repository.todaysEvents() }
            delay(60_000)
        }
    }

    var tasks by remember { mutableStateOf(listOf<Task>()) }
    var people by remember { mutableStateOf(listOf<Person>()) }
    LaunchedEffect(resumeTick, now.toLocalDate()) {
        tasks = withContext(Dispatchers.IO) { tasksRepo.open() }
        people = withContext(Dispatchers.IO) { peopleRepo.load() }
    }
    fun refreshTasks() { tasks = tasksRepo.open() }

    val today = now.toLocalDate()
    val dueTasks = tasks.filter { it.isOverdue(today) || it.isDueOn(today) }
    val overdueCount = tasks.count { it.isOverdue(today) }

    val localSummary = remember(events, now.minute, tasks) {
        LocalSummarizer.summarize(events, System.currentTimeMillis(), tasks.size, overdueCount)
    }

    // Refreshes only when the event list actually changes (structural equality),
    // not on every 60s poll.
    var aiSummary by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(events) {
        val key = settings.apiKey
        aiSummary = if (key.isBlank()) null else ClaudeSummarizer.summarize(key, settings.model, events)
    }

    // ------------------------------------------------------------ the desk
    var deskState by remember { mutableStateOf(DeskState.Unlinked) }
    var briefs by remember { mutableStateOf(listOf<Brief>()) }
    LaunchedEffect(deskKey) {
        if (!settings.deskLinked) { deskState = DeskState.Unlinked; briefs = emptyList(); return@LaunchedEffect }
        while (true) {
            try {
                val fresh = withContext(Dispatchers.IO) { desk.briefs(settings.lastBriefAt) }
                deskState = DeskState.Reachable
                if (fresh.isNotEmpty()) {
                    val known = briefs.map { it.id }.toSet()
                    briefs = (fresh.filterNot { it.id in known } + briefs).take(12)
                }
            } catch (_: Exception) {
                deskState = DeskState.Silent
            }
            // The screen is on anyway; thirty seconds is prompt enough for a brief.
            delay(30_000)
        }
    }

    fun dismissBrief(b: Brief) {
        briefs = briefs.filterNot { it.id == b.id }
        if (b.whenMillis > settings.lastBriefAt) settings.lastBriefAt = b.whenMillis
        scope.launch(Dispatchers.IO) { try { desk.ackBriefs(listOf(b.id)) } catch (_: Exception) {} }
    }

    // Burn-in protection: nudge the whole layout a few pixels every 5 minutes.
    val shift = remember(now.minute / 5, now.hour) {
        IntOffset(Random.nextInt(-8, 9), Random.nextInt(-8, 9))
    }

    var showSettings by remember { mutableStateOf(false) }

    Box(
        modifier = modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .then(
                if (interactive) {
                    Modifier.combinedClickable(onClick = {}, onLongClick = { showSettings = true })
                } else Modifier
            )
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .offset { shift },
            contentPadding = PaddingValues(start = 28.dp, end = 28.dp, top = 40.dp, bottom = if (interactive) 88.dp else 40.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            item {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = now.format(clockFormat),
                        fontSize = 96.sp,
                        fontWeight = FontWeight.Light,
                        color = MaterialTheme.colorScheme.onBackground,
                    )
                    Text(
                        text = now.format(dateFormat),
                        fontSize = 20.sp,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                    Spacer(Modifier.height(20.dp))
                    GoatAvatar()
                    Spacer(Modifier.height(16.dp))
                    Text(
                        text = aiSummary ?: localSummary,
                        fontSize = 18.sp,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                }
            }

            if (briefs.isNotEmpty()) {
                item { SectionLabel("From Ifreglen", MaterialTheme.colorScheme.tertiary) }
                items(briefs.take(3), key = { "b-${it.id}" }) { b ->
                    BriefCard(b, onDismiss = { dismissBrief(b) })
                    Spacer(Modifier.height(8.dp))
                }
                if (briefs.size > 3) {
                    item {
                        Text(
                            "+${briefs.size - 3} more on the desk",
                            fontSize = 13.sp,
                            color = MaterialTheme.colorScheme.secondary,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }

            if (dueTasks.isNotEmpty()) {
                item { SectionLabel("Follow-ups", if (overdueCount > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary) }
                items(dueTasks.take(5), key = { "t-${it.id}" }) { t ->
                    TaskRow(
                        task = t,
                        people = people,
                        today = today,
                        accent = if (t.isOverdue(today)) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                        onToggle = { if (interactive) { tasksRepo.setDone(t.id, true); refreshTasks() } },
                        onEdit = { if (interactive) context.startActivity(Intent(context, TasksActivity::class.java)) },
                        onDelete = {},
                    )
                }
            }

            item {
                Spacer(Modifier.height(8.dp))
                SectionLabel("Today", MaterialTheme.colorScheme.secondary)
            }
            if (events.isEmpty()) {
                item {
                    Text(
                        text = "No events found on this phone's calendar. Check that your work calendar account is synced (Settings → Passwords & accounts).",
                        fontSize = 14.sp,
                        color = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
            items(events) { event ->
                EventRow(event = event, nowMillis = System.currentTimeMillis())
                Spacer(Modifier.height(12.dp))
            }
        }

        if (interactive) {
            DashboardActions(
                deskState = deskState,
                desk = desk,
                settings = settings,
                tasksRepo = tasksRepo,
                onTasksChanged = { refreshTasks() },
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
    }

    if (showSettings) {
        SettingsDialog(
            settings = settings,
            onDismiss = { showSettings = false },
            onDeskChanged = onDeskChanged,
        )
    }
}

/** The bottom bar: People, Follow-ups, a spoken note to the desk, and the desk's dot. */
@Composable
private fun DashboardActions(
    deskState: DeskState,
    desk: DeskClient,
    settings: Settings,
    tasksRepo: TaskRepository,
    onTasksChanged: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    val noteSpeech = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val heard = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim().orEmpty()
        if (heard.isBlank()) return@rememberLauncherForActivityResult
        if (settings.deskLinked) {
            scope.launch {
                val ok = withContext(Dispatchers.IO) { try { desk.postNote(heard) } catch (_: Exception) { false } }
                if (ok) {
                    Toast.makeText(context, "Sent to Ifreglen", Toast.LENGTH_SHORT).show()
                } else {
                    // The desk is away: keep the thought here rather than lose it.
                    tasksRepo.add(heard, LocalDate.now())
                    onTasksChanged()
                    Toast.makeText(context, "Desk not answering. Saved as a follow-up for today.", Toast.LENGTH_LONG).show()
                }
            }
        } else {
            tasksRepo.add(heard, LocalDate.now())
            onTasksChanged()
            Toast.makeText(context, "Saved as a follow-up for today (no desk linked)", Toast.LENGTH_LONG).show()
        }
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 20.dp, vertical = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        DeskDot(deskState)
        Spacer(Modifier.weight(1f))
        ActionText("👥 People") { context.startActivity(Intent(context, PeopleActivity::class.java)) }
        Spacer(Modifier.width(18.dp))
        ActionText("☑ Follow-ups") { context.startActivity(Intent(context, TasksActivity::class.java)) }
        Spacer(Modifier.width(18.dp))
        ActionText("🎤 Note") {
            try {
                noteSpeech.launch(
                    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                        .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                        .putExtra(RecognizerIntent.EXTRA_PROMPT, if (settings.deskLinked) "Note for the desk" else "Note to self"),
                )
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(context, "No speech recognizer on this phone", Toast.LENGTH_SHORT).show()
            }
        }
    }
}

@Composable
private fun ActionText(label: String, onClick: () -> Unit) {
    Text(
        text = label,
        fontSize = 15.sp,
        color = MaterialTheme.colorScheme.onBackground,
        modifier = Modifier
            .alpha(0.7f)
            .clip(RoundedCornerShape(8.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 8.dp),
    )
}

/** Green: the desk answers. Amber: linked, not answering. Nothing when unlinked. */
@Composable
private fun DeskDot(state: DeskState) {
    if (state == DeskState.Unlinked) return
    val color = if (state == DeskState.Reachable) MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.primary
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(color))
        Spacer(Modifier.width(6.dp))
        Text("Ifreglen", fontSize = 12.sp, color = MaterialTheme.colorScheme.secondary)
    }
}

@Composable
private fun SectionLabel(text: String, color: Color) {
    Text(
        text = text.uppercase(),
        fontSize = 12.sp,
        letterSpacing = 1.5.sp,
        color = color,
        modifier = Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 6.dp),
    )
}

/** What the desk sent: a Lookout finding, an expiring licence, an overdue hire. Tap to clear. */
@Composable
private fun BriefCard(b: Brief, onDismiss: () -> Unit) {
    val zone = ZoneId.systemDefault()
    val stamp = if (b.whenMillis > 0) Instant.ofEpochMilli(b.whenMillis).atZone(zone).format(timeFormat) else ""
    val urgent = b.level.equals("urgent", ignoreCase = true) || b.level.equals("high", ignoreCase = true)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .clickable(onClick = onDismiss)
            .padding(14.dp),
    ) {
        Text(
            text = b.title.ifBlank { b.source },
            fontSize = 16.sp,
            fontWeight = FontWeight.SemiBold,
            color = if (urgent) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onBackground,
        )
        if (b.body.isNotBlank()) {
            Text(
                text = b.body,
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 3,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        Text(
            text = listOf(b.source, stamp).filter { it.isNotBlank() }.joinToString(" · ") + "  ·  tap to clear",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.secondary,
            modifier = Modifier.padding(top = 6.dp),
        )
    }
}

@Composable
private fun EventRow(event: CalendarEvent, nowMillis: Long) {
    val zone = ZoneId.systemDefault()
    val isPast = !event.allDay && event.endMillis <= nowMillis
    val isNow = !event.allDay && event.startMillis <= nowMillis && nowMillis < event.endMillis

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .alpha(if (isPast) 0.35f else 1f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(if (event.color != 0) Color(event.color) else MaterialTheme.colorScheme.primary)
        )
        Spacer(Modifier.size(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = event.title,
                fontSize = 18.sp,
                fontWeight = if (isNow) FontWeight.SemiBold else FontWeight.Normal,
                color = MaterialTheme.colorScheme.onBackground,
            )
            val timeLabel = if (event.allDay) {
                "All day"
            } else {
                val start = Instant.ofEpochMilli(event.startMillis).atZone(zone).format(timeFormat)
                val end = Instant.ofEpochMilli(event.endMillis).atZone(zone).format(timeFormat)
                "$start – $end" + if (isNow) "  ·  now" else ""
            }
            Text(
                text = timeLabel,
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.secondary,
            )
        }
    }
}
