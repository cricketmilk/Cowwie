package com.cowwie.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.dp
import com.cowwie.data.Settings

/** Long-press settings: paste an Anthropic API key to enable AI summaries. */
@Composable
fun SettingsDialog(settings: Settings, onDismiss: () -> Unit) {
    var apiKey by remember { mutableStateOf(settings.apiKey) }
    var model by remember { mutableStateOf(settings.model) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Cowwie settings") },
        text = {
            Column {
                Text("Optional: an Anthropic API key turns the one-line summary into an AI digest of your day. Leave blank to stay fully offline.")
                Spacer(Modifier.height(16.dp))
                OutlinedTextField(
                    value = apiKey,
                    onValueChange = { apiKey = it },
                    label = { Text("Anthropic API key") },
                    singleLine = true,
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = model,
                    onValueChange = { model = it },
                    label = { Text("Model") },
                    placeholder = { Text(Settings.DEFAULT_MODEL) },
                    singleLine = true,
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
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
