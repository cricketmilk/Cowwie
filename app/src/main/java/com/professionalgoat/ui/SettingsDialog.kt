package com.professionalgoat.ui

import android.content.Intent
import android.provider.Settings as SystemSettings
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.professionalgoat.data.Settings
import com.professionalgoat.desk.DeskClient
import com.professionalgoat.desk.DeskLink
import com.professionalgoat.desk.DeskNotificationListener
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Long-press settings. Three parts: the desk link (pair with Ifreglen), the
 * notification bridge (an Android permission, not ours to grant), and the
 * optional AI digest. Pairing applies at once; the key and model on Save.
 */
@Composable
fun SettingsDialog(settings: Settings, onDismiss: () -> Unit, onDeskChanged: () -> Unit = {}) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var apiKey by remember { mutableStateOf(settings.apiKey) }
    var model by remember { mutableStateOf(settings.model) }
    var pairText by remember { mutableStateOf("") }
    var linked by remember { mutableStateOf(settings.deskLinked) }
    var deskStatus by remember { mutableStateOf(if (settings.deskLinked) "Linked to ${settings.deskApi.removePrefix("http://")}" else "Not linked") }
    var bridge by remember { mutableStateOf(settings.bridgeEnabled) }
    val accessGranted = DeskNotificationListener.accessGranted(context)

    fun test() {
        scope.launch {
            deskStatus = "Checking…"
            val who = withContext(Dispatchers.IO) { DeskClient(settings).ping(settings.deskApi) }
            deskStatus = if (who != null) "Linked · ${settings.deskApi.removePrefix("http://")} answers as $who"
            else "Linked, but ${settings.deskApi.removePrefix("http://")} is not answering. Same Wi-Fi? Is Ifreglen running?"
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Professional Goat") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Section("Desk link · Ifreglen")
                Text(deskStatus, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (linked) {
                    Row {
                        TextButton(onClick = { test() }) { Text("Test") }
                        TextButton(onClick = {
                            settings.unpair()
                            linked = false
                            deskStatus = "Not linked"
                            onDeskChanged()
                        }) { Text("Unlink") }
                    }
                }
                OutlinedTextField(
                    value = pairText,
                    onValueChange = { pairText = it },
                    label = { Text(if (linked) "Pair with another desk" else "Pairing link") },
                    placeholder = { Text("http://192.168.0.12:8793/pair?token=…") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                TextButton(onClick = {
                    val pairing = DeskLink.parse(pairText)
                    if (pairing == null) {
                        deskStatus = "Paste the whole link from Ifreglen: the Trove → Apps → Professional Goat, or the /pair page."
                    } else {
                        settings.pair(pairing.api, pairing.alts, pairing.token)
                        linked = true
                        pairText = ""
                        DeskNotificationListener.kick()
                        onDeskChanged()
                        test()
                    }
                }, enabled = pairText.isNotBlank()) { Text("Pair") }
                Text(
                    "On the desk, scan the pairing QR with the phone's camera and choose Open in Professional Goat, or paste the link here.",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.secondary,
                )

                Spacer(Modifier.height(16.dp))
                Section("Notification bridge")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "Show this phone's messages and calls as cards on the desk, and type the desk's replies back.",
                        fontSize = 14.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(Modifier.width(8.dp))
                    Switch(checked = bridge, onCheckedChange = {
                        bridge = it
                        settings.bridgeEnabled = it
                        if (it) DeskNotificationListener.resync()
                    })
                }
                if (!accessGranted) {
                    TextButton(onClick = {
                        context.startActivity(Intent(SystemSettings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                    }) { Text("Allow notification access…") }
                } else {
                    val err = settings.lastCommsError
                    Text(
                        "Access granted · ${if (DeskNotificationListener.isBound()) "running" else "not running yet"} · " +
                            "sent ${settings.count(Settings.COUNT_SENT)} · replies ${settings.count(Settings.COUNT_REPLIES)} · " +
                            "codes kept off the desk ${settings.count(Settings.COUNT_DROPPED)}" +
                            if (err.isNotBlank()) "\nLast problem: $err" else "",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                }
                Text(
                    "One-time codes never leave the phone. Message text is shown on the desk and never stored or sent to a model.",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.secondary,
                )

                Spacer(Modifier.height(16.dp))
                Section("AI digest (optional)")
                Text(
                    "An Anthropic API key turns the one-line summary into an AI digest of your day. Leave blank to stay fully offline. Only event titles and times are sent, never People or messages.",
                    fontSize = 14.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = apiKey,
                    onValueChange = { apiKey = it },
                    label = { Text("Anthropic API key") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = model,
                    onValueChange = { model = it },
                    label = { Text("Model") },
                    placeholder = { Text(Settings.DEFAULT_MODEL) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                settings.apiKey = apiKey
                settings.model = model
                onDismiss()
            }) { Text("Save") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Close") }
        },
    )
}

@Composable
private fun Section(title: String) {
    Text(
        text = title.uppercase(),
        fontSize = 12.sp,
        letterSpacing = 1.5.sp,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.height(22.dp),
    )
}
