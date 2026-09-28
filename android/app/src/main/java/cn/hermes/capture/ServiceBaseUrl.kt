package cn.hermes.capture

import java.net.URI

/** Accept only an origin. API paths are appended by the mobile clients. */
object ServiceBaseUrl {
    fun intakeEndpoint(input: String, allowLocalHttp: Boolean = false): String =
        "${normalize(input, allowLocalHttp)}/api/intake"

    fun normalize(input: String, allowLocalHttp: Boolean = false): String {
        val value = input.trim()
        require(value.isNotEmpty()) { "请填写云端 HTTPS 基础地址" }
        require(value.none { it.isWhitespace() || it == '\\' || it.isISOControl() }) {
            "地址包含空格、换行或反斜杠；请只填写一行 HTTPS 域名"
        }
        val parsed = try { URI(value) } catch (_: Exception) {
            throw IllegalArgumentException("地址格式不正确；请只填写 HTTPS 基础地址")
        }
        val scheme = parsed.scheme?.lowercase()
        val host = parsed.host.orEmpty()
        require(host.isNotBlank()) { "地址缺少有效域名；请检查是否复制了多余字符" }
        require(scheme == "https" || (allowLocalHttp && scheme == "http" && host in listOf("localhost", "127.0.0.1"))) {
            "云端地址必须使用 HTTPS"
        }
        require(parsed.rawUserInfo == null && parsed.rawQuery == null && parsed.rawFragment == null) {
            "地址不能包含账号、密钥或参数"
        }
        require(parsed.rawPath.isNullOrEmpty() || parsed.rawPath == "/") {
            "只填写基础地址，不要附加 /api/intake 等接口路径"
        }
        return URI(scheme, parsed.rawAuthority, null, null, null).toString()
    }
}
