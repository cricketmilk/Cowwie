package com.professionalgoat

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.professionalgoat.ui.GoatTheme
import com.professionalgoat.ui.TasksScreen

/** Follow-ups: the day's small promises, typed or spoken, optionally about someone in People. */
class TasksActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefill = intent.getStringExtra(EXTRA_PREFILL)
        val personId = intent.getStringExtra(EXTRA_PERSON_ID)
        setContent {
            GoatTheme {
                TasksScreen(
                    onBack = { finish() },
                    initialPrefill = prefill,
                    initialPersonId = personId,
                )
            }
        }
    }

    companion object {
        /** Opens the add dialog with this text already typed. */
        const val EXTRA_PREFILL = "prefill"
        /** Opens the add dialog already about this person. */
        const val EXTRA_PERSON_ID = "person_id"
    }
}
