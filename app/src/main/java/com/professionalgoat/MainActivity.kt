package com.professionalgoat

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.professionalgoat.data.Settings
import com.professionalgoat.desk.DeskLink
import com.professionalgoat.desk.DeskNotificationListener
import com.professionalgoat.ui.DashboardScreen
import com.professionalgoat.ui.GoatTheme

class MainActivity : ComponentActivity() {

    /** Bumped when the pairing changes so the dashboard restarts its desk loop. */
    private var deskKey by mutableIntStateOf(0)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Always-on: keep the screen awake while the app is in the foreground.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Immersive: hide status and navigation bars.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        handlePairing(intent)

        setContent {
            GoatTheme {
                var hasPermission by remember { mutableStateOf(hasCalendarPermission()) }
                val launcher = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestPermission()
                ) { granted -> hasPermission = granted }

                if (hasPermission) {
                    DashboardScreen(
                        interactive = true,
                        deskKey = deskKey,
                        onDeskChanged = { deskKey++ },
                    )
                } else {
                    PermissionScreen(onRequest = { launcher.launch(Manifest.permission.READ_CALENDAR) })
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handlePairing(intent)
    }

    override fun onResume() {
        super.onResume()
        // After a force-stop Android does not rebind the listener on its own.
        DeskNotificationListener.rebind(this)
    }

    /** `goat://pair?token=...&host=...` from the desk's /pair page or its QR. */
    private fun handlePairing(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "goat") return
        val pairing = DeskLink.parse(data.toString())
        if (pairing == null) {
            Toast.makeText(this, "That pairing link carries no key.", Toast.LENGTH_LONG).show()
            return
        }
        Settings(this).pair(pairing.api, pairing.alts, pairing.token)
        DeskNotificationListener.kick()
        deskKey++
        Toast.makeText(this, "Paired with Ifreglen at ${pairing.api.removePrefix("http://")}", Toast.LENGTH_LONG).show()
        // Consume it: a rotation must not re-pair.
        intent.data = null
    }

    private fun hasCalendarPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALENDAR) ==
            PackageManager.PERMISSION_GRANTED
}

@Composable
private fun PermissionScreen(onRequest: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            "Professional Goat shows your day on an always-on display. It needs to read the phone's calendar.",
            color = MaterialTheme.colorScheme.onBackground,
        )
        Button(onClick = onRequest) { Text("Grant calendar access") }
    }
}
