package com.professionalgoat.desk

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SensitiveTest {

    @Test
    fun `one-time codes are caught in every common phrasing`() {
        assertTrue(Sensitive.test("Bank", "Your code is 482913"))
        assertTrue(Sensitive.test("", "482913 is your verification code"))
        assertTrue(Sensitive.test("Google", "G-482913 is your Google verification code."))
        assertTrue(Sensitive.test("", "Use 7731 to sign in"))
        assertTrue(Sensitive.test("Okta", "Your one-time passcode: 55512345"))
    }

    @Test
    fun `ordinary work messages pass`() {
        assertFalse(Sensitive.test("Dana", "Can you send the offer letter by Friday?"))
        assertFalse(Sensitive.test("Scheduling", "Orientation moved to room 204 at 9"))
        assertFalse(Sensitive.test("Missed call", "Missed call from 555-0134"))
    }
}
