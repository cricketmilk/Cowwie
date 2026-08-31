package com.cowwie.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import androidx.exifinterface.media.ExifInterface
import com.cowwie.data.Person
import com.cowwie.data.PersonRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Snap a photo of someone, say their name, and it's saved for later:
 * add → system camera → voice prompt ("Say their name") → done.
 * Tap a person to rename (typed or spoken); long-press to delete.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun PeopleScreen(onBack: () -> Unit) {
    val context = LocalContext.current
    val repository = remember { PersonRepository(context) }
    var people by remember { mutableStateOf(repository.load()) }

    var pendingPhoto by remember { mutableStateOf<File?>(null) }
    var renameTarget by remember { mutableStateOf<Person?>(null) }
    var renameText by remember { mutableStateOf("") }
    var deleteTarget by remember { mutableStateOf<Person?>(null) }

    // Names the photo that was just captured.
    val captureSpeechLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val heard = result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
            ?.trim()
            .orEmpty()
        val photo = pendingPhoto
        pendingPhoto = null
        if (photo != null && photo.exists()) {
            val person = repository.add(heard.ifBlank { "Unnamed" }, photo)
            people = repository.load()
            if (heard.isBlank()) {
                // Voice cancelled or not understood — offer typing instead.
                renameText = ""
                renameTarget = person
            }
        }
    }

    val cameraLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.TakePicture()
    ) { success ->
        val photo = pendingPhoto
        if (success && photo != null) {
            try {
                captureSpeechLauncher.launch(speechIntent())
            } catch (_: ActivityNotFoundException) {
                // No speech recognizer on this device — save and type the name.
                pendingPhoto = null
                val person = repository.add("Unnamed", photo)
                people = repository.load()
                renameText = ""
                renameTarget = person
            }
        } else {
            photo?.delete()
            pendingPhoto = null
        }
    }

    // Voice input inside the rename dialog.
    val renameSpeechLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        result.data
            ?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
            ?.firstOrNull()
            ?.trim()
            ?.takeIf { it.isNotBlank() }
            ?.let { renameText = it }
    }

    fun capture() {
        val file = repository.newPhotoFile()
        pendingPhoto = file
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        cameraLauncher.launch(uri)
    }

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
                text = "People",
                fontSize = 28.sp,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = { capture() }) { Text("＋ Add") }
        }

        Spacer(Modifier.height(16.dp))

        if (people.isEmpty()) {
            Text(
                text = "Tap Add: take their picture, then say their name — that's it. " +
                    "Everyone you save shows up here so you can put names to faces later.",
                fontSize = 16.sp,
                color = MaterialTheme.colorScheme.secondary,
            )
        } else {
            LazyVerticalGrid(
                columns = GridCells.Adaptive(minSize = 110.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                contentPadding = PaddingValues(bottom = 24.dp),
            ) {
                items(people, key = { it.id }) { person ->
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.combinedClickable(
                            onClick = {
                                renameText = person.name
                                renameTarget = person
                            },
                            onLongClick = { deleteTarget = person },
                        ),
                    ) {
                        PersonPhoto(person.photoFile, modifier = Modifier.fillMaxWidth())
                        Spacer(Modifier.height(6.dp))
                        Text(
                            text = person.name,
                            fontSize = 15.sp,
                            color = MaterialTheme.colorScheme.onBackground,
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }

    renameTarget?.let { person ->
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text("Who is this?") },
            text = {
                Column {
                    OutlinedTextField(
                        value = renameText,
                        onValueChange = { renameText = it },
                        label = { Text("Name") },
                        singleLine = true,
                    )
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = {
                        try {
                            renameSpeechLauncher.launch(speechIntent())
                        } catch (_: ActivityNotFoundException) {
                            // No recognizer — typing it is.
                        }
                    }) { Text("🎤 Say it instead") }
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    repository.rename(person.id, renameText.trim().ifBlank { "Unnamed" })
                    people = repository.load()
                    renameTarget = null
                }) { Text("Save") }
            },
            dismissButton = {
                TextButton(onClick = { renameTarget = null }) { Text("Cancel") }
            },
        )
    }

    deleteTarget?.let { person ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = { Text("Remove ${person.name}?") },
            text = { Text("The photo will be deleted from this phone.") },
            confirmButton = {
                TextButton(onClick = {
                    repository.delete(person.id)
                    people = repository.load()
                    deleteTarget = null
                }) { Text("Delete") }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) { Text("Cancel") }
            },
        )
    }
}

private fun speechIntent(): Intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
        .putExtra(
            RecognizerIntent.EXTRA_LANGUAGE_MODEL,
            RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
        )
        .putExtra(RecognizerIntent.EXTRA_PROMPT, "Say their name")

@Composable
private fun PersonPhoto(file: File, modifier: Modifier = Modifier) {
    val bitmap by produceState<ImageBitmap?>(initialValue = null, file) {
        value = withContext(Dispatchers.IO) { decodePhoto(file, targetPx = 512) }
    }
    val shape = RoundedCornerShape(14.dp)
    val current = bitmap
    if (current != null) {
        Image(
            bitmap = current,
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = modifier
                .aspectRatio(1f)
                .clip(shape),
        )
    } else {
        Box(
            modifier = modifier
                .aspectRatio(1f)
                .clip(shape)
                .background(MaterialTheme.colorScheme.surface),
        )
    }
}

/** Downsampled decode with EXIF rotation (camera JPEGs are usually rotated). */
private fun decodePhoto(file: File, targetPx: Int): ImageBitmap? = try {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= targetPx && bounds.outHeight / (sample * 2) >= targetPx) {
        sample *= 2
    }
    val opts = BitmapFactory.Options().apply { inSampleSize = sample }
    val raw = BitmapFactory.decodeFile(file.absolutePath, opts)
    if (raw == null) null
    else {
        val rotation = when (
            ExifInterface(file).getAttributeInt(
                ExifInterface.TAG_ORIENTATION,
                ExifInterface.ORIENTATION_NORMAL,
            )
        ) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90f
            ExifInterface.ORIENTATION_ROTATE_180 -> 180f
            ExifInterface.ORIENTATION_ROTATE_270 -> 270f
            else -> 0f
        }
        val upright = if (rotation != 0f) {
            val matrix = Matrix().apply { postRotate(rotation) }
            Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, matrix, true)
        } else raw
        upright.asImageBitmap()
    }
} catch (_: Exception) {
    null
}
