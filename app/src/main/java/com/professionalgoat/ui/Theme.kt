package com.professionalgoat.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Pure-black background: OLED pixels stay off, which saves power and can't burn in.
private val GoatColors = darkColorScheme(
    primary = Color(0xFFE0B458),      // goat gold
    onPrimary = Color(0xFF1A1200),
    background = Color(0xFF000000),
    onBackground = Color(0xFFE6E1D9),
    surface = Color(0xFF0D0D0D),
    onSurface = Color(0xFFE6E1D9),
    surfaceVariant = Color(0xFF141414),
    onSurfaceVariant = Color(0xFFB8B2A6),
    secondary = Color(0xFF8A8578),
    onSecondary = Color(0xFF000000),
    tertiary = Color(0xFF7FD6A8),     // desk link / "fresh" green
    error = Color(0xFFD98B7A),
)

@Composable
fun GoatTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = GoatColors, content = content)
}
