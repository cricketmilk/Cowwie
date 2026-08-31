package com.cowwie.data

import android.content.ContentUris
import android.content.Context
import android.provider.CalendarContract
import java.time.LocalDate
import java.time.ZoneId

data class CalendarEvent(
    val title: String,
    val startMillis: Long,
    val endMillis: Long,
    val allDay: Boolean,
    val color: Int,
)

/** Reads today's events from every calendar account synced to the phone. */
class CalendarRepository(private val context: Context) {

    fun todaysEvents(): List<CalendarEvent> {
        val zone = ZoneId.systemDefault()
        val startOfDay = LocalDate.now(zone).atStartOfDay(zone).toInstant().toEpochMilli()
        val endOfDay = LocalDate.now(zone).plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()

        val uriBuilder = CalendarContract.Instances.CONTENT_URI.buildUpon()
        ContentUris.appendId(uriBuilder, startOfDay)
        ContentUris.appendId(uriBuilder, endOfDay)

        val projection = arrayOf(
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.DISPLAY_COLOR,
        )

        val events = mutableListOf<CalendarEvent>()
        try {
            context.contentResolver.query(
                uriBuilder.build(),
                projection,
                null,
                null,
                "${CalendarContract.Instances.BEGIN} ASC",
            )?.use { cursor ->
                while (cursor.moveToNext()) {
                    events.add(
                        CalendarEvent(
                            title = cursor.getString(0)?.takeIf { it.isNotBlank() } ?: "(untitled)",
                            startMillis = cursor.getLong(1),
                            endMillis = cursor.getLong(2),
                            allDay = cursor.getInt(3) == 1,
                            color = cursor.getInt(4),
                        )
                    )
                }
            }
        } catch (_: SecurityException) {
            // Permission revoked mid-session; caller shows the permission screen.
        }
        return events
    }
}
