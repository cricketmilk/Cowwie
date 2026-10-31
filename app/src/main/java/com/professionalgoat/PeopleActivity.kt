package com.professionalgoat

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.professionalgoat.ui.GoatTheme
import com.professionalgoat.ui.PeopleScreen

/** Photo + spoken-name capture: quickly save who you met, browse them later. */
class PeopleActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            GoatTheme {
                PeopleScreen(onBack = { finish() })
            }
        }
    }
}
