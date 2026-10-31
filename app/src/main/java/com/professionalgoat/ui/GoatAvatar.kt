package com.professionalgoat.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// Pixel palette. '.' is transparent (the pure-black background shows through).
// The launcher icon (res/drawable/ic_launcher_foreground.xml) is generated
// from this same grid, so the goat on the tile is the goat on the screen.
private val PALETTE = mapOf(
    'W' to Color(0xFFF2EFE8), // cream face
    'G' to Color(0xFF9A948A), // ears
    'P' to Color(0xFFE8A9B0), // pink muzzle
    'D' to Color(0xFFB56570), // nostrils
    'E' to Color(0xFF141414), // eyes
    'H' to Color(0xFF8B7355), // horns
    'B' to Color(0xFFD9D4C7), // beard
)

// 16x15 pixel goat, eyes open.
private val EYES_OPEN = listOf(
    "..H..........H..",
    ".HH..........HH.",
    "..HH........HH..",
    "G..WWWWWWWWWW..G",
    "GG.WWWWWWWWWW.GG",
    ".GWWWWWWWWWWWWG.",
    ".WWEEWWWWWWEEWW.",
    ".WWEEWWWWWWEEWW.",
    ".WWWWWWWWWWWWWW.",
    "..WWWWWWWWWWWW..",
    "...WWPPPPPPWW...",
    "...WWPDPPDPWW...",
    "....WWWWWWWW....",
    ".....BBBBBB.....",
    "......BBBB......",
)

// Blink frame: eyes become a closed line.
private val EYES_CLOSED = EYES_OPEN.toMutableList().apply {
    this[6] = ".WWWWWWWWWWWWWW."
}

/** The resident pixel goat: blinks every few seconds and gently bobs. */
@Composable
fun GoatAvatar(modifier: Modifier = Modifier, pixel: Dp = 7.dp) {
    val transition = rememberInfiniteTransition(label = "goat")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(3600, easing = LinearEasing)),
        label = "phase",
    )

    val sprite = if (phase > 0.92f) EYES_CLOSED else EYES_OPEN
    val bobbed = phase >= 0.45f && phase < 0.9f

    Canvas(modifier = modifier.size(pixel * 16, pixel * 16)) {
        val px = pixel.toPx()
        val yOffset = if (bobbed) px else 0f
        sprite.forEachIndexed { y, row ->
            row.forEachIndexed { x, ch ->
                PALETTE[ch]?.let { color ->
                    drawRect(
                        color = color,
                        topLeft = Offset(x * px, y * px + yOffset),
                        size = Size(px, px),
                    )
                }
            }
        }
    }
}
