package com.professionalgoat.desk

/**
 * What must never leave the phone: one-time codes. Dropped here AND on the
 * desk, because a bank's "your code is 482913" sitting in a laptop's memory
 * is exactly what nobody should have to think about.
 *
 * "Your code is 482913", "482913 is your verification code", "G-482913".
 * Deliberately broad: a false positive costs you one card you would have seen
 * on the phone anyway; a false negative puts a code on the desk. Pure Kotlin
 * so the rule is unit-tested (SensitiveTest), not discovered on a phone.
 */
object Sensitive {
    val OTP = Regex(
        """\b(?:code|otp|passcode|pass code|verification|verify|2fa|two[- ]factor|one[- ]time|security|login|sign[- ]in|pin|token)\b[^\n]{0,60}?(?:\b[A-Z]-)?\b\d{4,8}\b""" +
            """|(?:\b[A-Z]-)?\b\d{4,8}\b[^\n]{0,60}?\b(?:code|otp|passcode|verification|verify|one[- ]time|security|log[- ]?in|sign[- ]in|pin|authenticat\w*)\b""",
        RegexOption.IGNORE_CASE,
    )

    fun test(title: String, text: String): Boolean = OTP.containsMatchIn("$title\n$text")
}
