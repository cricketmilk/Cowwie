package com.cowwie.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Pure-black background: OLED pixels stay off, which saves power and can't burn in.
private val CowwieColors = darkColorScheme(
    primary = Color(0xFFFFB74D),
    onPrimary = Color(0xFF1A1200),
    background = Color(0xFF000000),
    onBackground = Color(0xFFE6E1D9),
    surface = Color(0xFF0D0D0D),
    onSurface = Color(0xFFE6E1D9),
    secondary = Color(0xFF8A8578),
    onSecondary = Color(0xFF000000),
)

@Composable
fun CowwieTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = CowwieColors, content = content)
}
