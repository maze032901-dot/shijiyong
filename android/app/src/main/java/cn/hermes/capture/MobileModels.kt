package cn.hermes.capture

import org.json.JSONArray
import org.json.JSONObject

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
private fun JSONObject.list(name: String): List<JSONObject> = optJSONArray(name)?.objects().orEmpty()

data class TopicItem(val id: String, val title: String, val count: Int)
data class CardField(val label: String, val value: String, val kind: String)
data class CardAction(val label: String, val text: String, val url: String)
data class CardItem(
    val id: String, val sourceId: String, val title: String, val type: String,
    val topics: List<String>, val fields: List<CardField>, val actions: List<CardAction>,
    val paths: List<JSONObject>, val resources: List<JSONObject>, val coverUrl: String,
    val imageUrls: List<String>, val sourceUrl: String, val savedAt: String
) {
    val summary: String get() = fields.firstOrNull { it.label.contains("卡面") || it.label.contains("重点") }?.value
        ?: fields.firstOrNull()?.value.orEmpty()
    val isPrompt: Boolean get() = type.equals("prompt", true) || fields.any { it.label.contains("提示词") }
}
data class JobItem(val eventId: String, val sourceId: String, val title: String, val status: String, val stage: String, val progressStep: Int, val message: String, val savedAt: String)

data class Catalog(val topics: List<TopicItem>, val cards: List<CardItem>) {
    companion object {
        val EMPTY = Catalog(emptyList(), emptyList())
        fun from(raw: JSONObject?): Catalog {
            if (raw == null) return EMPTY
            val topics = raw.list("topics").map { TopicItem(it.optString("id"), it.optString("title"), it.optInt("totalCount")) }
            val cards = raw.list("cards").map { card ->
                val source = card.list("sources").firstOrNull() ?: JSONObject()
                val media = card.optJSONObject("media") ?: JSONObject()
                CardItem(
                    card.optString("id"), card.optString("sourceId"), card.optString("title"), card.optString("type"),
                    card.list("topics").map { it.optString("id") },
                    card.list("content").map { CardField(it.optString("label"), it.optString("value"), it.optString("kind")) },
                    card.list("actions").map { CardAction(it.optString("label"), it.optString("text"), it.optString("url")) },
                    card.list("paths"), card.list("resources"), media.optString("coverUrl"),
                    (media.optJSONArray("imageUrls") ?: JSONArray()).let { array -> (0 until array.length()).map { array.optString(it) }.filter(String::isNotBlank) },
                    source.optString("originalUrl"), source.optString("savedAt")
                )
            }
            return Catalog(topics.filter { it.title.isNotBlank() }, cards.filter { it.title.isNotBlank() })
        }
    }
}

fun jobsFrom(raw: JSONObject?): List<JobItem> = raw?.list("jobs")?.map { job ->
    val progress = job.optJSONObject("progress") ?: JSONObject()
    JobItem(job.optString("eventId"), job.optString("sourceId"), job.optString("title").ifBlank { "正在读取收藏" },
        job.optString("status"), progress.optString("stage"), progress.optInt("progressStep", 0),
        progress.optString("message").ifBlank { job.optString("error") }, job.optString("savedAt"))
}.orEmpty().sortedByDescending { it.savedAt }
