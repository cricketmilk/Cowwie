package com.cowwie

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.cowwie.ui.CowwieTheme
import com.cowwie.ui.PeopleScreen

/** Photo + spoken-name capture: quickly save who you met, browse them later. */
class PeopleActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            CowwieTheme {
                PeopleScreen(onBack = { finish() })
            }
        }
    }
}
