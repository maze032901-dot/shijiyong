package cn.hermes.capture

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class CaptureStore(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun add(record: CaptureRecord) {
        val state = readState()
        val records = state.getJSONArray(KEY_RECORDS)
        records.put(record.toJson())
        trim(records, MAX_RECORDS)
        writeState(state)
    }

    @Synchronized
    fun saveLink(timestamp: Long, trigger: String, outcome: String, link: String): SavedLink {
        val state = readState()
        val savedLink = SavedLink(
            eventId = UUID.randomUUID().toString(),
            timestamp = timestamp,
            trigger = trigger,
            link = link
        )
        state.getJSONArray(KEY_SAVED_LINKS).put(savedLink.toJson())
        trim(state.getJSONArray(KEY_SAVED_LINKS), MAX_SAVED_LINKS)

        state.getJSONArray(KEY_RECORDS).put(
            CaptureRecord(
                timestamp = timestamp,
                trigger = trigger,
                outcome = outcome,
                link = link
            ).toJson()
        )
        trim(state.getJSONArray(KEY_RECORDS), MAX_RECORDS)
        writeState(state)
        return savedLink
    }

    @Synchronized
    fun records(): List<CaptureRecord> {
        val array = readState().getJSONArray(KEY_RECORDS)
        return buildList {
            for (index in 0 until array.length()) {
                val value = array.optJSONObject(index) ?: continue
                add(
                    CaptureRecord(
                        timestamp = value.optLong("timestamp"),
                        trigger = value.optString("trigger"),
                        outcome = value.optString("outcome"),
                        link = value.optString("link").takeIf { it.isNotBlank() }
                    )
                )
            }
        }
    }

    @Synchronized
    fun savedLinks(): List<SavedLink> {
        val array = readState().getJSONArray(KEY_SAVED_LINKS)
        return buildList {
            for (index in 0 until array.length()) {
                val value = array.optJSONObject(index) ?: continue
                val link = value.optString("link")
                val eventId = value.optString("event_id")
                if (link.isBlank() || eventId.isBlank()) continue
                add(
                    SavedLink(
                        eventId = eventId,
                        timestamp = value.optLong("timestamp"),
                        trigger = value.optString("trigger"),
                        link = link,
                        syncState = value.optString("sync_state", "local_saved"),
                        syncAttempts = value.optInt("sync_attempts", 0)
                    )
                )
            }
        }
    }

    @Synchronized
    fun pendingSync(): List<SavedLink> = savedLinks().filter { it.syncState == "local_saved" || it.syncState == "retryable" }

    @Synchronized
    fun updateSyncState(eventId: String, syncState: String, incrementAttempts: Boolean) {
        val state = readState()
        val savedLinks = state.getJSONArray(KEY_SAVED_LINKS)
        for (index in 0 until savedLinks.length()) {
            val saved = savedLinks.optJSONObject(index) ?: continue
            if (saved.optString("event_id") != eventId) continue
            saved.put("sync_state", syncState)
            if (incrementAttempts) saved.put("sync_attempts", saved.optInt("sync_attempts", 0) + 1)
            writeState(state)
            return
        }
    }

    @Synchronized
    fun clear() {
        preferences.edit().remove(KEY_STATE).remove(KEY_LEGACY_RECORDS).commit()
    }

    @Synchronized
    fun exportJson(): String {
        return JSONObject()
            .put("schema", "hermes/android-capture/v2")
            .put("exported_at", System.currentTimeMillis())
            .put(
                "device",
                JSONObject()
                    .put("manufacturer", Build.MANUFACTURER)
                    .put("model", Build.MODEL)
                    .put("android", Build.VERSION.RELEASE)
                    .put("sdk", Build.VERSION.SDK_INT)
            )
            .put("saved_links", readState().getJSONArray(KEY_SAVED_LINKS))
            .put("records", readState().getJSONArray(KEY_RECORDS))
            .toString(2)
    }

    private fun readState(): JSONObject {
        val raw = preferences.getString(KEY_STATE, null)
        if (raw != null) {
            try {
                val state = JSONObject(raw)
                if (state.has(KEY_RECORDS) && state.has(KEY_SAVED_LINKS)) return state
            } catch (_: Exception) {
                // Fall through to an empty, recoverable state.
            }
        }

        val legacyRecords = readLegacyRecords()
        val migratedLinks = JSONArray()
        for (index in 0 until legacyRecords.length()) {
            val record = legacyRecords.optJSONObject(index) ?: continue
            val outcome = record.optString("outcome")
            val link = record.optString("link")
            if (link.isBlank() || (outcome != "captured" && outcome != "captured_direct")) continue
            migratedLinks.put(
                SavedLink(
                    eventId = "legacy-${record.optLong("timestamp")}-${index}",
                    timestamp = record.optLong("timestamp"),
                    trigger = record.optString("trigger"),
                    link = link
                ).toJson()
            )
        }
        return JSONObject()
            .put(KEY_RECORDS, legacyRecords)
            .put(KEY_SAVED_LINKS, migratedLinks)
    }

    private fun readLegacyRecords(): JSONArray {
        val raw = preferences.getString(KEY_LEGACY_RECORDS, null) ?: return JSONArray()
        return try {
            JSONArray(raw)
        } catch (_: Exception) {
            JSONArray()
        }
    }

    private fun writeState(state: JSONObject) {
        // One synchronous commit keeps the capture event and local queue in the same durable state.
        preferences.edit().putString(KEY_STATE, state.toString()).commit()
    }

    private fun trim(array: JSONArray, limit: Int) {
        while (array.length() > limit) array.remove(0)
    }

    private fun CaptureRecord.toJson(): JSONObject = JSONObject()
        .put("timestamp", timestamp)
        .put("trigger", trigger)
        .put("outcome", outcome)
        .apply { link?.let { put("link", it) } }

    private fun SavedLink.toJson(): JSONObject = JSONObject()
        .put("event_id", eventId)
        .put("timestamp", timestamp)
        .put("trigger", trigger)
        .put("link", link)
        .put("sync_state", syncState)
        .put("sync_attempts", syncAttempts)

    companion object {
        // Keep the original preference file so upgrading the diagnostic APK preserves prior records.
        private const val PREFERENCES_NAME = "hermes_capture_diagnostics"
        private const val KEY_STATE = "state_v2"
        private const val KEY_LEGACY_RECORDS = "records"
        private const val KEY_RECORDS = "records"
        private const val KEY_SAVED_LINKS = "saved_links"
        private const val MAX_RECORDS = 50
        private const val MAX_SAVED_LINKS = 1_000
    }
}
