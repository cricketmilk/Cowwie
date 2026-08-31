package com.cowwie.data

import android.content.Context

/** Tiny persistent settings store for the API key and model choice. */
class Settings(context: Context) {

    private val prefs = context.getSharedPreferences("cowwie", Context.MODE_PRIVATE)

    var apiKey: String
        get() = prefs.getString(KEY_API_KEY, "") ?: ""
        set(value) = prefs.edit().putString(KEY_API_KEY, value.trim()).apply()

    var model: String
        get() = prefs.getString(KEY_MODEL, DEFAULT_MODEL) ?: DEFAULT_MODEL
        set(value) = prefs.edit().putString(KEY_MODEL, value.trim().ifBlank { DEFAULT_MODEL }).apply()

    companion object {
        private const val KEY_API_KEY = "api_key"
        private const val KEY_MODEL = "model"
        const val DEFAULT_MODEL = "claude-opus-5"
    }
}
