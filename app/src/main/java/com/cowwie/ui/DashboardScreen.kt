package com.cowwie.ui

import android.content.Intent
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cowwie.PeopleActivity
import com.cowwie.data.CalendarEvent
import com.cowwie.data.CalendarRepository
import com.cowwie.data.Settings
import com.cowwie.summary.ClaudeSummarizer
import com.cowwie.summary.LocalSummarizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlin.random.Random

private val clockFormat = DateTimeFormatter.ofPattern("HH:mm")
private val dateFormat = DateTimeFormatter.ofPattern("EEEE, MMMM d")
private val timeFormat = DateTimeFormatter.ofPattern("h:mm a")

/**
 * The always-on face: big clock, date, day summary, and today's agenda.
 * [interactive] enables the long-press settings dialog (activity only —
 * the screensaver renders the same screen non-interactively).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun DashboardScreen(interactive: Boolean, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val repository = remember { CalendarRepository(context) }
    val settings = remember { Settings(context) }

    var now by remember { mutableStateOf(LocalDateTime.now()) }
    LaunchedEffect(Unit) {
        while (true) {
            now = LocalDateTime.now()
            delay(1_000)
        }
    }

    var events by remember { mutableStateOf(listOf<CalendarEvent>()) }
    LaunchedEffect(Unit) {
        while (true) {
            events = withContext(Dispatchers.IO) { repository.todaysEvents() }
            delay(60_000)
        }
    }

    val localSummary = remember(events, now.minute) {
        LocalSummarizer.summarize(events, System.currentTimeMillis())
    }

    // Refreshes only when the event list actually changes (structural equality),
    // not on every 60s poll.
    var aiSummary by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(events) {
        val key = settings.apiKey
        aiSummary = if (key.isBlank()) null else ClaudeSummarizer.summarize(key, settings.model, events)
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
        Column(
            modifier = Modifier
                .fillMaxSize()
                .offset { shift }
                .padding(horizontal = 32.dp, vertical = 40.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
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

            CowAvatar()

            Spacer(Modifier.height(16.dp))

            Text(
                text = aiSummary ?: localSummary,
                fontSize = 18.sp,
                color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.fillMaxWidth(),
            )

            if (events.isEmpty()) {
                Spacer(Modifier.height(8.dp))
                Text(
                    text = "No events found on this phone's calendar — check that your calendar account is synced (Settings → Passwords & accounts).",
                    fontSize = 14.sp,
                    color = MaterialTheme.colorScheme.secondary,
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            Spacer(Modifier.height(24.dp))

            LazyColumn(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(events) { event ->
                    EventRow(event = event, nowMillis = System.currentTimeMillis())
                }
            }
        }

        if (interactive) {
            Text(
                text = "👥",
                fontSize = 26.sp,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(24.dp)
                    .alpha(0.6f)
                    .clickable { context.startActivity(Intent(context, PeopleActivity::class.java)) },
            )
        }
    }

    if (showSettings) {
        SettingsDialog(settings = settings, onDismiss = { showSettings = false })
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
