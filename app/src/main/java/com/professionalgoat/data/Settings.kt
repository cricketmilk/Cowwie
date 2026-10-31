package com.professionalgoat.data

import android.content.Context
import org.json.JSONArray

/**
 * Tiny persistent settings store: the optional AI key, and the pairing with
 * the desk (Ifreglen). The preferences file keeps its original name so an
 * install over the old Cowwie build keeps its settings.
 */
class Settings(context: Context) {

    private val prefs = context.getSharedPreferences("cowwie", Context.MODE_PRIVATE)

    // ---------------------------------------------------------------- AI digest

    var apiKey: String
        get() = prefs.getString(KEY_API_KEY, "") ?: ""
        set(value) = prefs.edit().putString(KEY_API_KEY, value.trim()).apply()

    var model: String
        get() = prefs.getString(KEY_MODEL, DEFAULT_MODEL) ?: DEFAULT_MODEL
        set(value) = prefs.edit().putString(KEY_MODEL, value.trim().ifBlank { DEFAULT_MODEL }).apply()

    // ---------------------------------------------------------------- desk link

    /** Base URL that answered last, e.g. `http://192.168.0.12:8793`. */
    var deskApi: String
        get() = prefs.getString(KEY_DESK_API, "") ?: ""
        set(value) = prefs.edit().putString(KEY_DESK_API, value.trim().trimEnd('/')).apply()

    /** The desk's other addresses from the pairing link, tried when the first is silent. */
    var deskAlts: List<String>
        get() = try {
            val arr = JSONArray(prefs.getString(KEY_DESK_ALTS, "[]"))
            (0 until arr.length()).map { arr.getString(it) }.filter { it.isNotBlank() }
        } catch (_: Exception) {
            emptyList()
        }
        set(value) = prefs.edit().putString(KEY_DESK_ALTS, JSONArray(value).toString()).apply()

    var deskToken: String
        get() = prefs.getString(KEY_DESK_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_DESK_TOKEN, value.trim()).apply()

    val deskLinked: Boolean get() = deskApi.isNotBlank() && deskToken.isNotBlank()

    /** Every address the desk is known by, the last responder first. */
    val deskEndpoints: List<String>
        get() = (listOf(deskApi) + deskAlts).filter { it.isNotBlank() }.distinct()

    /**
     * Bumped on every pairing change. A request that started under an older
     * pairing and failed must not back off: the failure was against the old
     * address, and the new one has not been tried yet.
     */
    val pairingGen: Int get() = prefs.getInt(KEY_PAIR_GEN, 0)

    fun pair(api: String, alts: List<String>, token: String) {
        prefs.edit()
            .putString(KEY_DESK_API, api.trim().trimEnd('/'))
            .putString(KEY_DESK_ALTS, JSONArray(alts).toString())
            .putString(KEY_DESK_TOKEN, token.trim())
            .putInt(KEY_PAIR_GEN, pairingGen + 1)
            .apply()
    }

    fun unpair() {
        prefs.edit()
            .remove(KEY_DESK_API).remove(KEY_DESK_ALTS).remove(KEY_DESK_TOKEN)
            .putInt(KEY_PAIR_GEN, pairingGen + 1)
            .apply()
    }

    /** The notification bridge. On unless switched off: granting notification access is the opt-in. */
    var bridgeEnabled: Boolean
        get() = prefs.getBoolean(KEY_BRIDGE, true)
        set(value) = prefs.edit().putBoolean(KEY_BRIDGE, value).apply()

    /** Newest brief already shown, so the dashboard asks only for what is new. */
    var lastBriefAt: Long
        get() = prefs.getLong(KEY_LAST_BRIEF, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_BRIEF, value).apply()

    // Bridge diagnostics, flags and timestamps only: never a message's words.
    var lastCommsPostAt: Long
        get() = prefs.getLong(KEY_COMMS_POST, 0L)
        set(value) = prefs.edit().putLong(KEY_COMMS_POST, value).apply()

    var lastCommsError: String
        get() = prefs.getString(KEY_COMMS_ERR, "") ?: ""
        set(value) = prefs.edit().putString(KEY_COMMS_ERR, value.take(200)).apply()

    fun bump(key: String, by: Int = 1) {
        prefs.edit().putInt(key, prefs.getInt(key, 0) + by).apply()
    }

    fun count(key: String): Int = prefs.getInt(key, 0)

    companion object {
        private const val KEY_API_KEY = "api_key"
        private const val KEY_MODEL = "model"
        private const val KEY_DESK_API = "desk_api"
        private const val KEY_DESK_ALTS = "desk_alts"
        private const val KEY_DESK_TOKEN = "desk_token"
        private const val KEY_PAIR_GEN = "desk_gen"
        private const val KEY_BRIDGE = "bridge_enabled"
        private const val KEY_LAST_BRIEF = "last_brief_at"
        private const val KEY_COMMS_POST = "comms_post_at"
        private const val KEY_COMMS_ERR = "comms_error"
        const val COUNT_SENT = "comms_sent"
        const val COUNT_REPLIES = "comms_replies"
        const val COUNT_DROPPED = "comms_dropped"
        const val DEFAULT_MODEL = "claude-opus-5"
    }
}
