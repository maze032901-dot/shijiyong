package cn.hermes.capture

import android.content.Context
import android.content.pm.ApplicationInfo

data class ReceiverConfig(val baseUrl: String, val token: String) {
    val isComplete: Boolean get() = baseUrl.isNotBlank() && token.isNotBlank()
}

class ReceiverConfigStore(private val context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    fun read(): ReceiverConfig = ReceiverConfig(
        baseUrl = preferences.getString(KEY_BASE_URL, "").orEmpty(),
        token = preferences.getString(KEY_TOKEN, "").orEmpty()
    )

    fun save(baseUrl: String, token: String) {
        val debug = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        val normalizedUrl = ServiceBaseUrl.normalize(baseUrl, allowLocalHttp = debug)
        preferences.edit()
            .putString(KEY_BASE_URL, normalizedUrl)
            .putString(KEY_TOKEN, token.trim())
            .commit()
    }

    companion object {
        private const val PREFERENCES_NAME = "hermes_receiver_config"
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_TOKEN = "token"
    }
}
