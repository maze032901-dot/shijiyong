package cn.hermes.capture

data class CaptureRecord(
    val timestamp: Long,
    val trigger: String,
    val outcome: String,
    val link: String? = null
)

/** A durable local save event. A later sync worker will use eventId for idempotency. */
data class SavedLink(
    val eventId: String,
    val timestamp: Long,
    val trigger: String,
    val link: String,
    val syncState: String = "local_saved",
    val syncAttempts: Int = 0
)
