package com.professionalgoat.desk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DeskLinkTest {

    @Test
    fun `deep link carries host and token`() {
        val p = DeskLink.parse("goat://pair?token=abc123&host=192.168.0.12%3A8793")!!
        assertEquals("http://192.168.0.12:8793", p.api)
        assertEquals("abc123", p.token)
        assertEquals(emptyList<String>(), p.alts)
    }

    @Test
    fun `intent link as Chrome prints it`() {
        val p = DeskLink.parse("intent://pair?token=t0k&host=10.0.0.5:8803#Intent;scheme=goat;package=com.cowwie;end")!!
        assertEquals("http://10.0.0.5:8803", p.api)
        assertEquals("t0k", p.token)
    }

    @Test
    fun `pair page link with alternates in the fragment`() {
        val p = DeskLink.parse("http://192.168.0.12:8793/pair?token=k#alt=100.64.1.2:8793,10.0.0.5:8803")!!
        assertEquals("http://192.168.0.12:8793", p.api)
        assertEquals(listOf("http://100.64.1.2:8793", "http://10.0.0.5:8803"), p.alts)
        assertEquals("k", p.token)
    }

    @Test
    fun `older root link with token and no port defaults the port`() {
        val p = DeskLink.parse("http://desk.local/?token=k2")!!
        assertEquals("http://desk.local:8793", p.api)
    }

    @Test
    fun `a bare token is refused`() {
        assertNull(DeskLink.parse("abc123"))
        assertNull(DeskLink.parse(""))
        assertNull(DeskLink.parse(null))
    }

    @Test
    fun `a link without a token is refused`() {
        assertNull(DeskLink.parse("http://192.168.0.12:8793/pair"))
        assertNull(DeskLink.parse("goat://pair?host=192.168.0.12:8793"))
    }
}
