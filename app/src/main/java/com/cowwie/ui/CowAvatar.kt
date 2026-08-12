package com.cowwie.ui

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
private val PALETTE = mapOf(
    'W' to Color(0xFFF2EFE8), // cream face
    'G' to Color(0xFF7A7A7A), // gray patch
    'P' to Color(0xFFE8A9B0), // pink muzzle
    'D' to Color(0xFFB56570), // nostrils
    'E' to Color(0xFF141414), // eyes
    'H' to Color(0xFFD9C58A), // horns
)

// 16x13 pixel cow, eyes open.
private val EYES_OPEN = listOf(
    "..HH........HH..",
    "..HH........HH..",
    ".WWWWWWWWWWWWWW.",
    "WWWWWWWWWWGGGWWW",
    "WWWWWWWWWWGGGWWW",
    ".WWEEWWWWWWEEWW.",
    ".WWEEWWWWWWEEWW.",
    ".WWWWWWWWWWWWWW.",
    ".WPPPPPPPPPPPPW.",
    ".PPPDDPPPPDDPPP.",
    ".PPPDDPPPPDDPPP.",
    "..PPPPPPPPPPPP..",
    "................",
)

// Blink frame: eyes become a closed line.
private val EYES_CLOSED = listOf(
    "..HH........HH..",
    "..HH........HH..",
    ".WWWWWWWWWWWWWW.",
    "WWWWWWWWWWGGGWWW",
    "WWWWWWWWWWGGGWWW",
    ".WWWWWWWWWWWWWW.",
    ".WWEEWWWWWWEEWW.",
    ".WWWWWWWWWWWWWW.",
    ".WPPPPPPPPPPPPW.",
    ".PPPDDPPPPDDPPP.",
    ".PPPDDPPPPDDPPP.",
    "..PPPPPPPPPPPP..",
    "................",
)

/** The resident pixel cow: blinks every few seconds and gently bobs. */
@Composable
fun CowAvatar(modifier: Modifier = Modifier, pixel: Dp = 7.dp) {
    val transition = rememberInfiniteTransition(label = "cow")
    val phase by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(3600, easing = LinearEasing)),
        label = "phase",
    )

    val sprite = if (phase > 0.92f) EYES_CLOSED else EYES_OPEN
    val bobbed = phase >= 0.45f && phase < 0.9f

    Canvas(modifier = modifier.size(pixel * 16, pixel * 14)) {
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
