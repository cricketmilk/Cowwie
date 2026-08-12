package com.cowwie.summary

import com.anthropic.client.AnthropicClient
import com.anthropic.client.okhttp.AnthropicOkHttpClient
import com.anthropic.models.messages.MessageCreateParams
import com.cowwie.data.CalendarEvent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Optional AI layer: turns the day's events into a short, friendly digest via Claude.
 * Returns null on any failure so callers can fall back to [LocalSummarizer].
 */
object ClaudeSummarizer {

    private val timeFormat = DateTimeFormatter.ofPattern("h:mm a")

    private var cachedClient: AnthropicClient? = null
    private var cachedKey: String? = null

    private fun client(apiKey: String): AnthropicClient {
        val existing = cachedClient
        if (existing != null && cachedKey == apiKey) return existing
        val fresh = AnthropicOkHttpClient.builder().apiKey(apiKey).build()
        cachedClient = fresh
        cachedKey = apiKey
        return fresh
    }

    suspend fun summarize(
        apiKey: String,
        model: String,
        events: List<CalendarEvent>,
    ): String? = withContext(Dispatchers.IO) {
        try {
            val params = MessageCreateParams.builder()
                .model(model)
                .maxTokens(300L)
                .system(
                    "You are the voice of a small always-on desk calendar. " +
                        "Given today's events, reply with a single short, warm summary of the day " +
                        "(one or two sentences, e.g. \"3 meetings and 1 errand — free after 4pm.\"). " +
                        "Mention when the day frees up if there are timed events. " +
                        "No preamble, no markdown, no emoji."
                )
                .addUserMessage(buildPrompt(events))
                .build()

            val response = client(apiKey).messages().create(params)
            val text = response.content()
                .mapNotNull { block -> block.text().map { it.text() }.orElse(null) }
                .joinToString("")
                .trim()
            // A refusal or empty response yields blank text; treat it as "no AI summary"
            // and let the caller fall back to the local one-liner.
            text.ifBlank { null }
        } catch (_: Exception) {
            null
        }
    }

    private fun buildPrompt(events: List<CalendarEvent>): String {
        val zone = ZoneId.systemDefault()
        return buildString {
            appendLine("Today is ${LocalDate.now(zone)}.")
            if (events.isEmpty()) {
                appendLine("There are no events on the calendar today.")
            } else {
                appendLine("Today's events:")
                events.forEach { event ->
                    if (event.allDay) {
                        appendLine("- ${event.title} (all day)")
                    } else {
                        val start = Instant.ofEpochMilli(event.startMillis).atZone(zone).format(timeFormat)
                        val end = Instant.ofEpochMilli(event.endMillis).atZone(zone).format(timeFormat)
                        appendLine("- ${event.title}: $start to $end")
                    }
                }
            }
        }
    }
}
