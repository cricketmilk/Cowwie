package com.professionalgoat.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.professionalgoat.data.Person
import com.professionalgoat.data.PersonRepository
import com.professionalgoat.data.Task
import com.professionalgoat.data.TaskRepository
import java.time.LocalDate
import java.time.format.DateTimeFormatter

private val dueFormat = DateTimeFormatter.ofPattern("EEE d MMM")

/** A due day as a person says it. */
fun dueLabel(due: LocalDate?, today: LocalDate): String = when {
    due == null -> ""
    due.isBefore(today) -> "overdue · ${due.format(dueFormat)}"
    due == today -> "today"
    due == today.plusDays(1) -> "tomorrow"
    else -> due.format(dueFormat)
}

/**
 * Follow-ups, grouped by when: overdue, today, later, someday, done. Add by
 * typing or speaking; a follow-up can be about someone in People, so "call
 * Dana back" remembers which Dana.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TasksScreen(
    onBack: () -> Unit,
    initialPrefill: String? = null,
    initialPersonId: String? = null,
) {
    val context = LocalContext.current
    val tasks = remember { TaskRepository(context) }
    val peopleRepo = remember { PersonRepository(context) }
    val people = remember { peopleRepo.load() }
    var all by remember { mutableStateOf(tasks.load()) }
    val today = LocalDate.now()

    // null = closed; a Task with blank id = adding.
    var editing by remember {
        mutableStateOf(
            if (initialPrefill != null || initialPersonId != null) {
                Task("", initialPrefill.orEmpty(), today.toEpochDay(), initialPersonId, false, 0L, null)
            } else null
        )
    }
    var deleteTarget by remember { mutableStateOf<Task?>(null) }
    var showDone by remember { mutableStateOf(false) }

    fun refresh() { all = tasks.load() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .padding(horizontal = 20.dp, vertical = 24.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("‹ Back", fontSize = 16.sp) }
            Spacer(Modifier.width(8.dp))
            Text(
                text = "Follow-ups",
                fontSize = 28.sp,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = { editing = Task("", "", today.toEpochDay(), null, false, 0L, null) }) { Text("＋ Add") }
        }

        Spacer(Modifier.height(12.dp))

        val open = all.filterNot { it.done }
        val done = all.filter { it.done }
        val overdue = open.filter { it.isOverdue(today) }
        val dueToday = open.filter { it.isDueOn(today) }
        val later = open.filter { it.due != null && it.due!!.isAfter(today) }
        val someday = open.filter { it.due == null }
        // Colours are read here, in composition: a LazyColumn's content lambda is not composable.
        val errorColor = MaterialTheme.colorScheme.error
        val primaryColor = MaterialTheme.colorScheme.primary
        val secondaryColor = MaterialTheme.colorScheme.secondary

        if (all.isEmpty()) {
            Text(
                text = "Nothing to chase yet. Tap Add and say it: \"send Dana the offer letter Friday\". " +
                    "Follow-ups due today show on the dashboard.",
                fontSize = 16.sp,
                color = MaterialTheme.colorScheme.secondary,
            )
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                section("Overdue", overdue, people, today, errorColor,
                    onToggle = { tasks.setDone(it.id, !it.done); refresh() },
                    onEdit = { editing = it }, onDelete = { deleteTarget = it })
                section("Today", dueToday, people, today, primaryColor,
                    onToggle = { tasks.setDone(it.id, !it.done); refresh() },
                    onEdit = { editing = it }, onDelete = { deleteTarget = it })
                section("Later", later, people, today, secondaryColor,
                    onToggle = { tasks.setDone(it.id, !it.done); refresh() },
                    onEdit = { editing = it }, onDelete = { deleteTarget = it })
                section("Someday", someday, people, today, secondaryColor,
                    onToggle = { tasks.setDone(it.id, !it.done); refresh() },
                    onEdit = { editing = it }, onDelete = { deleteTarget = it })
                if (done.isNotEmpty()) {
                    item {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            TextButton(onClick = { showDone = !showDone }) {
                                Text(if (showDone) "Hide done (${done.size})" else "Show done (${done.size})")
                            }
                            Spacer(Modifier.weight(1f))
                            TextButton(onClick = { tasks.clearOldDone(0); refresh() }) { Text("Clear done") }
                        }
                    }
                    if (showDone) {
                        items(done, key = { it.id }) { t ->
                            TaskRow(t, people, today, Color.Transparent,
                                onToggle = { tasks.setDone(t.id, false); refresh() },
                                onEdit = {}, onDelete = { deleteTarget = t })
                        }
                    }
                }
            }
        }
    }

    editing?.let { task ->
        TaskEditDialog(
            task = task,
            people = people,
            today = today,
            onDismiss = { editing = null },
            onSave = { text, due, personId ->
                if (task.id.isBlank()) tasks.add(text, due, personId)
                else tasks.update(task.id, text, due, personId)
                refresh()
                editing = null
            },
        )
    }

    deleteTarget?.let { task ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("Delete this follow-up?") },
            text = { Text(task.text) },
            confirmButton = {
                TextButton(onClick = { tasks.delete(task.id); refresh(); deleteTarget = null }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleteTarget = null }) { Text("Cancel") } },
        )
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.section(
    title: String,
    list: List<Task>,
    people: List<Person>,
    today: LocalDate,
    accent: Color,
    onToggle: (Task) -> Unit,
    onEdit: (Task) -> Unit,
    onDelete: (Task) -> Unit,
) {
    if (list.isEmpty()) return
    item(key = "h-$title") {
        Text(
            text = title.uppercase(),
            fontSize = 12.sp,
            letterSpacing = 1.5.sp,
            color = accent,
            modifier = Modifier.padding(top = 14.dp, bottom = 4.dp),
        )
    }
    items(list, key = { it.id }) { t ->
        TaskRow(t, people, today, accent, onToggle = { onToggle(t) }, onEdit = { onEdit(t) }, onDelete = { onDelete(t) })
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TaskRow(
    task: Task,
    people: List<Person>,
    today: LocalDate,
    accent: Color,
    onToggle: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val person = task.personId?.let { id -> people.find { it.id == id } }
    val sub = listOfNotNull(dueLabel(task.due, today).ifBlank { null }, person?.name).joinToString(" · ")
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .combinedClickable(onClick = onEdit, onLongClick = onDelete)
            .padding(vertical = 8.dp, horizontal = 4.dp)
            .alpha(if (task.done) 0.45f else 1f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        DoneCircle(done = task.done, accent = accent, onClick = onToggle)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = task.text,
                fontSize = 17.sp,
                color = MaterialTheme.colorScheme.onBackground,
                textDecoration = if (task.done) TextDecoration.LineThrough else null,
            )
            if (sub.isNotBlank()) {
                Text(text = sub, fontSize = 13.sp, color = MaterialTheme.colorScheme.secondary)
            }
        }
    }
}

/** The tap target that completes a follow-up: an empty ring, or a filled one. */
@Composable
fun DoneCircle(done: Boolean, accent: Color, onClick: () -> Unit) {
    val ring = if (accent == Color.Transparent) MaterialTheme.colorScheme.secondary else accent
    Box(
        modifier = Modifier
            .size(26.dp)
            .clip(CircleShape)
            .border(2.dp, ring, CircleShape)
            .background(if (done) ring else Color.Transparent)
            .clickable(onClick = onClick),
    )
}

@Composable
private fun TaskEditDialog(
    task: Task,
    people: List<Person>,
    today: LocalDate,
    onDismiss: () -> Unit,
    onSave: (String, LocalDate?, String?) -> Unit,
) {
    var text by remember { mutableStateOf(task.text) }
    var due by remember { mutableStateOf(task.due) }
    var personId by remember { mutableStateOf(task.personId) }
    var personMenu by remember { mutableStateOf(false) }

    val speech = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim()
            ?.takeIf { it.isNotBlank() }?.let { heard -> text = if (text.isBlank()) heard else "$text $heard" }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (task.id.isBlank()) "New follow-up" else "Edit follow-up") },
        text = {
            Column {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text("What") },
                    placeholder = { Text("Call Dana back about the offer") },
                    modifier = Modifier.fillMaxWidth(),
                )
                TextButton(onClick = {
                    try {
                        speech.launch(
                            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                                .putExtra(RecognizerIntent.EXTRA_PROMPT, "What's the follow-up?"),
                        )
                    } catch (_: ActivityNotFoundException) {
                    }
                }) { Text("🎤 Say it instead") }

                Spacer(Modifier.height(8.dp))
                Text("Due", fontSize = 12.sp, color = MaterialTheme.colorScheme.secondary)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    DueChip("None", due == null) { due = null }
                    DueChip("Today", due == today) { due = today }
                    DueChip("Tomorrow", due == today.plusDays(1)) { due = today.plusDays(1) }
                    DueChip("Next week", due == today.plusWeeks(1)) { due = today.plusWeeks(1) }
                }
                if (due != null && due != today && due != today.plusDays(1) && due != today.plusWeeks(1)) {
                    Text(due!!.format(dueFormat), fontSize = 13.sp, color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(top = 4.dp))
                }

                if (people.isNotEmpty()) {
                    Spacer(Modifier.height(10.dp))
                    Box {
                        TextButton(onClick = { personMenu = true }) {
                            Text("About: ${people.find { it.id == personId }?.name ?: "nobody in particular"} ▾")
                        }
                        DropdownMenu(expanded = personMenu, onDismissRequest = { personMenu = false }) {
                            DropdownMenuItem(text = { Text("Nobody in particular") }, onClick = { personId = null; personMenu = false })
                            people.forEach { p ->
                                DropdownMenuItem(
                                    text = { Text(if (p.subtitle.isBlank()) p.name else "${p.name} · ${p.subtitle}") },
                                    onClick = { personId = p.id; personMenu = false },
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { if (text.isNotBlank()) onSave(text.trim(), due, personId) },
            ) { Text("Save") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
private fun DueChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.secondary
    Text(
        text = label,
        fontSize = 13.sp,
        color = if (selected) MaterialTheme.colorScheme.onPrimary else color,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(if (selected) color else Color.Transparent)
            .border(1.dp, color, RoundedCornerShape(50))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 5.dp),
    )
}
