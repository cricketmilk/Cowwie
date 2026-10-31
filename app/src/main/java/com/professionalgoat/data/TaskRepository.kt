package com.professionalgoat.data

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.LocalDate
import java.util.UUID

/**
 * A follow-up: one small promise. "Call Dana back about the offer letter",
 * due on a day (or not), optionally about someone in People.
 */
data class Task(
    val id: String,
    val text: String,
    /** Due day as an epoch day (LocalDate.toEpochDay), or null for "whenever". */
    val dueEpochDay: Long?,
    val personId: String?,
    val done: Boolean,
    val createdAt: Long,
    val doneAt: Long?,
) {
    val due: LocalDate? get() = dueEpochDay?.let { LocalDate.ofEpochDay(it) }
    fun isOverdue(today: LocalDate): Boolean = !done && due?.isBefore(today) == true
    fun isDueOn(today: LocalDate): Boolean = !done && due == today
}

/** Follow-ups as a small JSON file in the app's private files dir. On-device only. */
class TaskRepository(private val context: Context) {

    private val file = File(context.filesDir, "tasks.json")

    fun load(): List<Task> {
        if (!file.exists()) return emptyList()
        return try {
            val array = JSONArray(file.readText())
            (0 until array.length()).map { i ->
                val o = array.getJSONObject(i)
                Task(
                    id = o.getString("id"),
                    text = o.getString("text"),
                    dueEpochDay = if (o.isNull("due")) null else o.getLong("due"),
                    personId = if (o.isNull("person")) null else o.getString("person"),
                    done = o.optBoolean("done", false),
                    createdAt = o.optLong("createdAt"),
                    doneAt = if (o.isNull("doneAt")) null else o.getLong("doneAt"),
                )
            }.sortedWith(ordering)
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** What the dashboard shows: open, overdue first, then today, then dated, then undated. */
    fun open(): List<Task> = load().filterNot { it.done }

    fun add(text: String, due: LocalDate?, personId: String? = null): Task {
        val task = Task(
            id = UUID.randomUUID().toString(),
            text = text.trim(),
            dueEpochDay = due?.toEpochDay(),
            personId = personId,
            done = false,
            createdAt = System.currentTimeMillis(),
            doneAt = null,
        )
        save(load() + task)
        return task
    }

    fun setDone(id: String, done: Boolean) {
        save(load().map {
            if (it.id == id) it.copy(done = done, doneAt = if (done) System.currentTimeMillis() else null) else it
        })
    }

    fun update(id: String, text: String, due: LocalDate?, personId: String?) {
        save(load().map {
            if (it.id == id) it.copy(text = text.trim(), dueEpochDay = due?.toEpochDay(), personId = personId) else it
        })
    }

    fun delete(id: String) = save(load().filterNot { it.id == id })

    /** Done items older than a month are not worth a scroll. */
    fun clearOldDone(olderThanDays: Int = 30) {
        val cutoff = System.currentTimeMillis() - olderThanDays * 86_400_000L
        save(load().filterNot { it.done && (it.doneAt ?: 0L) < cutoff })
    }

    private fun save(tasks: List<Task>) {
        val array = JSONArray()
        tasks.forEach { t ->
            array.put(
                JSONObject()
                    .put("id", t.id)
                    .put("text", t.text)
                    .put("due", t.dueEpochDay ?: JSONObject.NULL)
                    .put("person", t.personId ?: JSONObject.NULL)
                    .put("done", t.done)
                    .put("createdAt", t.createdAt)
                    .put("doneAt", t.doneAt ?: JSONObject.NULL)
            )
        }
        file.writeText(array.toString())
    }

    private val ordering = compareBy<Task>({ it.done }, { it.dueEpochDay ?: Long.MAX_VALUE }, { it.createdAt })
}
