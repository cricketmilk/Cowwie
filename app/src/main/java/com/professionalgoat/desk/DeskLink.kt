package com.professionalgoat.desk

import java.net.URI
import java.net.URLDecoder

/** A parsed pairing link: where the desk is, and the key it wants. */
data class DeskPairing(val api: String, val alts: List<String>, val token: String)

/**
 * Reads the desk's pairing link in every shape it comes in. Pure, so the
 * shapes are unit-tested (DeskLinkTest) rather than discovered on a phone.
 *
 *   goat://pair?token=T&host=192.168.0.12:8793            the deep link
 *   intent://pair?token=T&host=...#Intent;scheme=goat;...  the same, as Chrome prints it
 *   http://192.168.0.12:8793/pair?token=T#alt=10.0.0.5:8793,...  the QR / copied link
 *   http://192.168.0.12:8793/?token=T                      the older web form
 *
 * A bare token is refused: without an address there is nothing to pair with,
 * and guessing the laptop's IP is how a key ends up posted to a stranger.
 */
object DeskLink {

    const val DEFAULT_PORT = 8793

    fun parse(raw: String?): DeskPairing? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        return try {
            val uri = URI(text.replace(" ", "%20"))
            val scheme = uri.scheme?.lowercase()
            val query = params(uri.rawQuery)
            val token = query["token"]?.trim().orEmpty()
            if (token.isEmpty()) return null

            val hosts = mutableListOf<String>()
            when (scheme) {
                "goat", "intent" -> {
                    query["host"]?.let { hosts += it }
                    query["alt"]?.split(',')?.forEach { hosts += it }
                }
                "http", "https" -> {
                    val port = if (uri.port > 0) uri.port else DEFAULT_PORT
                    if (!uri.host.isNullOrBlank()) hosts += "${uri.host}:$port"
                    // The fragment carries the laptop's other addresses: `#alt=a:p,b:p`.
                    uri.rawFragment?.removePrefix("alt=")?.split(',')?.forEach { hosts += it }
                }
                else -> return null
            }
            val bases = hosts.map { it.trim() }.filter { it.isNotEmpty() }.map(::base).distinct()
            if (bases.isEmpty()) null else DeskPairing(bases.first(), bases.drop(1), token)
        } catch (_: Exception) {
            null
        }
    }

    /** `host[:port]` to `http://host:port`. */
    fun base(hostPort: String): String {
        val hp = hostPort.removePrefix("http://").removePrefix("https://").trimEnd('/')
        return if (hp.contains(':')) "http://$hp" else "http://$hp:$DEFAULT_PORT"
    }

    private fun params(rawQuery: String?): Map<String, String> =
        rawQuery.orEmpty().split('&').filter { it.contains('=') }.associate { kv ->
            val i = kv.indexOf('=')
            URLDecoder.decode(kv.substring(0, i), "UTF-8") to URLDecoder.decode(kv.substring(i + 1), "UTF-8")
        }
}
