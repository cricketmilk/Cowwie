package com.professionalgoat.desk

import com.professionalgoat.data.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/** A note the desk sent this way: a Lookout finding, an expiring licence, an overdue hire. */
data class Brief(
    val id: String,
    val source: String,
    val title: String,
    val body: String,
    val level: String,
    val url: String,
    val whenMillis: Long,
)

/** `unpaired` means the desk rejected the key: pair again rather than retry. */
class DeskException(message: String, val unpaired: Boolean = false) : Exception(message)

/**
 * The phone's side of the desk protocol (Ifreglen's `lib/mutsync.js`): plain
 * HTTP on the LAN, one bearer token, JSON bodies. Blocking; callers run it on
 * Dispatchers.IO or the listener's own thread. No HTTP library on purpose:
 * `HttpURLConnection` is in the platform and this is a handful of routes.
 */
class DeskClient(private val settings: Settings) {

    /** Unauthenticated reachability check: `GET /ping` → `{ok, who}`. */
    fun ping(base: String): String? = try {
        val h = (URL("$base/ping").openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"; connectTimeout = 3000; readTimeout = 4000
        }
        try {
            if (h.responseCode != 200) null
            else JSONObject(read(h.inputStream)).optString("who", "desk")
        } finally {
            h.disconnect()
        }
    } catch (_: Exception) {
        null
    }

    // ------------------------------------------------------------------ briefs

    fun briefs(sinceMillis: Long): List<Brief> {
        val r = call("GET", "/briefs?since=$sinceMillis", null)
        val arr = r.optJSONArray("briefs") ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val o = arr.optJSONObject(i) ?: return@mapNotNull null
            Brief(
                id = o.optString("id"),
                source = o.optString("source"),
                title = o.optString("title"),
                body = o.optString("body"),
                level = o.optString("level", "normal"),
                url = o.optString("url"),
                whenMillis = o.optLong("when", 0L),
            )
        }.filter { it.id.isNotBlank() && !(it.title.isBlank() && it.body.isBlank()) }
    }

    fun ackBriefs(ids: List<String>) {
        if (ids.isEmpty()) return
        call("POST", "/briefs/ack", JSONObject().put("ids", JSONArray(ids)))
    }

    // ------------------------------------------------------------------- notes

    /** A spoken or typed note from the phone: lands as a card on the desk. */
    fun postNote(text: String): Boolean {
        val r = call("POST", "/notes", JSONObject().put("text", text).put("when", System.currentTimeMillis()))
        return r.optBoolean("ok", true)
    }

    // ------------------------------------------------------------------- comms

    /** A batch of this phone's notifications. The answer carries the desk's replies. */
    fun postComms(items: List<JSONObject>): JSONArray? {
        val body = JSONObject().put("items", JSONArray(items))
        return call("POST", "/mut/comms", body).optJSONArray("outbox")
    }

    fun commsOutbox(): JSONArray? = call("GET", "/mut/comms/outbox", null).optJSONArray("outbox")

    fun ackComms(id: String, ok: Boolean, error: String?) {
        val body = JSONObject().put("id", id).put("ok", ok)
        if (error != null) body.put("error", error)
        call("POST", "/mut/comms/ack", body)
    }

    // ---------------------------------------------------------------- the wire

    /**
     * One request, trying each address the desk is known by and remembering
     * the one that answered. Returns the parsed reply or throws with words a
     * person could act on.
     */
    fun call(method: String, path: String, body: JSONObject?): JSONObject {
        val token = settings.deskToken
        if (token.isEmpty()) throw DeskException("not paired with the desk", unpaired = true)
        var last: Exception = DeskException("the desk is not answering")
        for (base in settings.deskEndpoints) {
            var h: HttpURLConnection? = null
            try {
                h = (URL(base + path).openConnection() as HttpURLConnection).apply {
                    requestMethod = method
                    connectTimeout = 4000
                    readTimeout = 8000
                    setRequestProperty("Authorization", "Bearer $token")
                }
                if (body != null) {
                    val bytes = body.toString().toByteArray(StandardCharsets.UTF_8)
                    h.doOutput = true
                    h.setRequestProperty("Content-Type", "application/json")
                    h.setFixedLengthStreamingMode(bytes.size)
                    h.outputStream.use { it.write(bytes) }
                }
                val code = h.responseCode
                if (code == 401) throw DeskException("the desk does not know this key any more. Pair again.", unpaired = true)
                if (code == 503) throw DeskException("the desk's phone bridge is off")
                val text = read(if (code < 400) h.inputStream else h.errorStream)
                if (code >= 400) throw DeskException("the desk said $code")
                if (base != settings.deskApi) settings.deskApi = base
                return if (text.isEmpty()) JSONObject() else JSONObject(text)
            } catch (e: Exception) {
                last = e
                // A wrong key is wrong at every address; do not try the rest.
                if (e is DeskException && e.unpaired) throw e
            } finally {
                h?.disconnect()
            }
        }
        throw last
    }

    private fun read(input: InputStream?): String {
        if (input == null) return ""
        val out = ByteArrayOutputStream()
        input.use { it.copyTo(out) }
        return out.toString("UTF-8")
    }
}
