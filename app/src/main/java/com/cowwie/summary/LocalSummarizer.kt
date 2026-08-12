package com.cowwie.summary

import com.cowwie.data.CalendarEvent
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Instant, offline "3 events today · free after 4:00 PM" one-liner. */
object LocalSummarizer {

    private val timeFormat = DateTimeFormatter.ofPattern("h:mm a")

    fun summarize(events: List<CalendarEvent>, nowMillis: Long): String {
        val timed = events.filter { !it.allDay }
        if (timed.isEmpty()) {
            return if (events.isEmpty()) "Nothing on the calendar today."
            else "No timed events today — just ${events.size} all-day ${plural(events.size, "item")}."
        }

        val remaining = timed.count { it.endMillis > nowMillis }
        val lastEnd = timed.maxOf { it.endMillis }
        val freeAfter = Instant.ofEpochMilli(lastEnd).atZone(ZoneId.systemDefault()).format(timeFormat)

        return when {
            remaining == 0 -> "${timed.size} ${plural(timed.size, "event")} today, all done. Evening is yours."
            lastEnd <= nowMillis -> "$remaining ${plural(remaining, "event")} left today."
            else -> "$remaining of ${timed.size} ${plural(timed.size, "event")} left · free after $freeAfter"
        }
    }

    private fun plural(n: Int, word: String) = if (n == 1) word else "${word}s"
}
