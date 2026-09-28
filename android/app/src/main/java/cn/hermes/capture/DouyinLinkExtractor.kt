package cn.hermes.capture

import java.net.URI

object DouyinLinkExtractor {
    private val urlPattern = Regex("https?://[^\\s]+", RegexOption.IGNORE_CASE)
    private val trailingPunctuation = setOf(
        '.', ',', ';', '!', '?', ':',
        '。', '，', '；', '！', '？', '：',
        ')', ']', '}', '）', '】', '》', '"', '\''
    )

    fun extract(text: CharSequence?): List<String> {
        if (text.isNullOrBlank()) return emptyList()

        return urlPattern.findAll(text)
            .map { match -> match.value.trimEnd { it in trailingPunctuation } }
            .filter(::isDouyinUrl)
            .distinct()
            .toList()
    }

    fun isDouyinUrl(value: String): Boolean = try {
        val uri = URI(value)
        val host = uri.host?.lowercase() ?: return false
        (host == "douyin.com" || host.endsWith(".douyin.com")) &&
            (uri.scheme.equals("https", ignoreCase = true) ||
                uri.scheme.equals("http", ignoreCase = true))
    } catch (_: Exception) {
        false
    }
}
