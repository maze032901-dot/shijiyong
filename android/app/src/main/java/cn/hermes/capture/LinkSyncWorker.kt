package cn.hermes.capture

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class LinkSyncWorker(appContext: Context, workerParams: WorkerParameters) : Worker(appContext, workerParams) {
    override fun doWork(): Result {
        return if (LinkSyncExecutor.syncOnce(applicationContext)) Result.retry() else Result.success()
    }
}

private object LinkSyncExecutor {
    /** Returns true only when Android should retry later. */
    fun syncOnce(context: Context): Boolean {
        val config = ReceiverConfigStore(context).read()
        val store = CaptureStore(context)
        if (!config.isComplete) {
            store.add(CaptureRecord(System.currentTimeMillis(), "同步诊断：没有保存后端地址或密钥", "sync_config_missing"))
            return false
        }
        val pending = store.pendingSync()
        store.add(CaptureRecord(System.currentTimeMillis(), "同步诊断：准备上传 ${pending.size} 条", "sync_started"))
        for (saved in pending) {
            when (val result = send(config, saved)) {
                is SendResult.Accepted -> {
                    store.updateSyncState(saved.eventId, "server_queued", incrementAttempts = true)
                    store.add(CaptureRecord(System.currentTimeMillis(), "同步诊断：云端已接收（HTTP ${result.code}）", "sync_accepted", saved.link))
                }
                is SendResult.Retry -> {
                    store.updateSyncState(saved.eventId, "retryable", incrementAttempts = true)
                    store.add(CaptureRecord(System.currentTimeMillis(), "同步诊断：${result.detail}", "sync_retry", saved.link))
                    return true
                }
                is SendResult.Rejected -> {
                    store.updateSyncState(saved.eventId, "sync_rejected", incrementAttempts = true)
                    store.add(CaptureRecord(System.currentTimeMillis(), "同步诊断：HTTP ${result.code}，请检查密钥或链接", "sync_rejected", saved.link))
                }
            }
        }
        return false
    }

    private fun send(config: ReceiverConfig, saved: SavedLink): SendResult {
        return try {
            val connection = (URL("${config.baseUrl}/api/intake").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Authorization", "Bearer ${config.token}")
            }
            val body = JSONObject()
                .put("event_id", saved.eventId)
                .put("source_url", saved.link)
                .put("trigger", saved.trigger)
                .put("saved_at", saved.timestamp)
                .toString()
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val responseCode = connection.responseCode
            connection.disconnect()
            when (responseCode) {
                200, 202 -> SendResult.Accepted(responseCode)
                400, 401, 403 -> SendResult.Rejected(responseCode)
                else -> SendResult.Retry("HTTP $responseCode")
            }
        } catch (error: Exception) {
            SendResult.Retry("${error.javaClass.simpleName}: ${error.message ?: "未提供错误信息"}")
        }
    }

    private sealed interface SendResult {
        data class Accepted(val code: Int) : SendResult
        data class Rejected(val code: Int) : SendResult
        data class Retry(val detail: String) : SendResult
    }

    private const val CONNECT_TIMEOUT_MS = 8_000
    private const val READ_TIMEOUT_MS = 8_000
}

object LinkSyncScheduler {
    private const val UNIQUE_WORK_NAME = "hermes-link-sync"

    fun enqueue(context: Context) {
        val request = OneTimeWorkRequestBuilder<LinkSyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE_WORK_NAME, ExistingWorkPolicy.REPLACE, request)
    }

    /** User-initiated saves should try now; WorkManager is only the fallback. */
    fun syncNow(context: Context) {
        Thread {
            val shouldRetry = LinkSyncExecutor.syncOnce(context.applicationContext)
            if (shouldRetry) enqueue(context.applicationContext)
        }.start()
    }
}
