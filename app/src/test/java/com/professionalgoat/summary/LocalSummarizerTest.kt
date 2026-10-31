package com.professionalgoat.summary

import com.professionalgoat.data.CalendarEvent
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

class LocalSummarizerTest {

    private val zone = ZoneId.of("America/Chicago")
    private val day = LocalDate.of(2026, 10, 30)
    private fun at(h: Int, m: Int = 0) = day.atTime(LocalTime.of(h, m)).atZone(zone).toInstant().toEpochMilli()
    private fun ev(title: String, from: Int, to: Int) = CalendarEvent(title, at(from), at(to), false, 0)

    @Test
    fun `empty day`() {
        assertEquals("Nothing on the calendar today.", LocalSummarizer.summarize(emptyList(), at(9), zone = zone))
    }

    @Test
    fun `mid-day with events left and follow-ups`() {
        val events = listOf(ev("Standup", 9, 10), ev("Interview", 13, 14), ev("1:1", 15, 16))
        assertEquals(
            "2 of 3 events left · free after 4:00 PM · 2 follow-ups",
            LocalSummarizer.summarize(events, at(11), openFollowUps = 2, zone = zone),
        )
    }

    @Test
    fun `overdue follow-ups win the tail`() {
        val events = listOf(ev("Standup", 9, 10))
        assertEquals(
            "1 event today, all done. Evening is yours. · 1 overdue follow-up",
            LocalSummarizer.summarize(events, at(17), openFollowUps = 3, overdueFollowUps = 1, zone = zone),
        )
    }

    @Test
    fun `all-day only`() {
        val allDay = CalendarEvent("Open enrollment", at(0), at(23), true, 0)
        assertEquals("No timed events today, just 1 all-day item.", LocalSummarizer.summarize(listOf(allDay), at(9), zone = zone))
    }
}
