package cn.hermes.capture

import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.spec.X509EncodedKeySpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import java.security.KeyFactory
import java.security.PublicKey

data class MobileConfig(val baseUrl: String, val token: String, val keyFingerprint: String) {
    val isComplete get() = baseUrl.isNotBlank() && token.isNotBlank()
}

/** The phone's read/control token is independent of the older intake upload token. */
class MobileConfigStore(private val context: Context) {
    private val prefs = context.getSharedPreferences("hermes_mobile_connection", Context.MODE_PRIVATE)
    private val alias = "hermes-mobile-token-v1"

    private fun key(): javax.crypto.SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? javax.crypto.SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build())
            generateKey()
        }
    }

    fun read(): MobileConfig {
        val token = try {
            val packed = Base64.decode(prefs.getString("encrypted_token", ""), Base64.NO_WRAP)
            if (packed.size < 29) "" else Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, packed.copyOfRange(0, 12)))
                String(doFinal(packed.copyOfRange(12, packed.size)), Charsets.UTF_8)
            }
        } catch (_: Exception) { "" }
        return MobileConfig(prefs.getString("base_url", "").orEmpty(), token, prefs.getString("mac_fingerprint", "").orEmpty())
    }

    fun save(baseUrl: String, token: String) {
        val debug = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        val normalizedUrl = ServiceBaseUrl.normalize(baseUrl, allowLocalHttp = debug)
        val normalizedToken = token.trim()
        require(normalizedToken.length >= 24) { "手机凭据至少需要 24 个字符" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val packed = cipher.iv + cipher.doFinal(normalizedToken.toByteArray(Charsets.UTF_8))
        val previous = read().baseUrl
        prefs.edit().putString("base_url", normalizedUrl)
            .putString("encrypted_token", Base64.encodeToString(packed, Base64.NO_WRAP))
            .apply {
                if (previous != normalizedUrl) remove("mac_fingerprint")
            }.apply()
    }

    fun trustMacFingerprint(fingerprint: String) {
        val existing = read().keyFingerprint
        require(existing.isBlank() || existing == fingerprint) { "Mac 加密公钥发生变化；请在服务设置中确认并重新配对" }
        prefs.edit().putString("mac_fingerprint", fingerprint).apply()
    }

    fun forgetMacFingerprint() { prefs.edit().remove("mac_fingerprint").apply() }
}

class MobileApi(private val context: Context) {
    private val configStore = MobileConfigStore(context)
    private val cacheDir = File(context.filesDir, "mobile-library-cache").apply { mkdirs() }

    fun cachedLibrary(): JSONObject? = readCache("library.json")
    fun cachedJobs(): JSONObject? = readCache("jobs.json")
    fun cachedProviders(): JSONObject? = readCache("providers.json")

    private fun readCache(name: String): JSONObject? = try { JSONObject(File(cacheDir, name).readText()) } catch (_: Exception) { null }

    private fun request(path: String, method: String = "GET", body: JSONObject? = null, extraHeaders: Map<String, String> = emptyMap()): Pair<Int, ByteArray> {
        val config = configStore.read()
        require(config.isComplete) { "请先在服务设置中配置手机专用凭据" }
        val connection = URL(config.baseUrl + path).openConnection() as HttpURLConnection
        return try {
            connection.requestMethod = method
            connection.connectTimeout = 10_000
            connection.readTimeout = 20_000
            connection.setRequestProperty("Authorization", "Bearer ${config.token}")
            connection.setRequestProperty("Accept", "application/json")
            extraHeaders.forEach { (name, value) -> connection.setRequestProperty(name, value) }
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            if (status !in 200..299 && status != 304) throw IllegalStateException("云端返回 HTTP $status")
            status to (if (status == 204 || status == 304) byteArrayOf() else connection.inputStream.use { it.readBytes() })
        } finally { connection.disconnect() }
    }

    private fun json(path: String, cacheName: String? = null): JSONObject {
        val body = JSONObject(String(request(path).second, Charsets.UTF_8))
        if (cacheName != null) File(cacheDir, cacheName).writeText(body.toString())
        return body
    }

    fun library(): JSONObject {
        val cached = cachedLibrary()
        val revision = cached?.optString("revision").orEmpty()
        val (status, bytes) = request("/api/mobile/v1/library", extraHeaders =
            if (revision.isBlank()) emptyMap() else mapOf("If-None-Match" to "\"$revision\""))
        if (status == 304) return cached ?: error("缓存不存在，无法使用 304 响应")
        val result = JSONObject(String(bytes, Charsets.UTF_8))
        File(cacheDir, "library.json").writeText(result.toString())
        return result
    }
    fun jobs(): JSONObject = json("/api/mobile/v1/jobs", "jobs.json")
    fun providers(): JSONObject = json("/api/mobile/v1/providers", "providers.json")
    fun command(action: String, eventId: String? = null, payload: JSONObject? = null): String {
        val input = JSONObject().put("action", action)
        if (eventId != null) input.put("eventId", eventId)
        if (payload != null) input.put("payload", payload)
        return JSONObject(String(request("/api/mobile/v1/commands", "POST", input).second)).getString("id")
    }
    fun commandStatus(id: String): JSONObject = json("/api/mobile/v1/commands/$id")

    fun image(url: String): Bitmap? {
        if (!Regex("^/api/mobile/v1/media/[a-f0-9]{64}\\.(jpg|jpeg|png|webp)$").matches(url)) return null
        val target = File(cacheDir, url.substringAfterLast('/'))
        if (target.exists()) return BitmapFactory.decodeFile(target.path)
        val bytes = request(url).second
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        if (digest != target.name.substring(0, 64)) return null
        target.writeBytes(bytes)
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }

    fun prefetchImages(catalog: Catalog) {
        for (url in catalog.cards.flatMap { it.imageUrls }.distinct()) {
            val target = File(cacheDir, url.substringAfterLast('/'))
            if (!target.exists()) try { image(url) } catch (_: Exception) { /* A failed image must not block cards. */ }
        }
    }

    private fun encryptForMac(input: JSONObject): JSONObject {
        val keyData = json("/api/mobile/v1/mac-key")
        val pem = keyData.getString("publicKey")
        val encoded = pem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replace(Regex("\\s+"), "")
        val publicKey: PublicKey = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(Base64.decode(encoded, Base64.DEFAULT)))
        val fingerprint = MessageDigest.getInstance("SHA-256").digest(pem.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        configStore.trustMacFingerprint(fingerprint)
        val key = ByteArray(32).also(SecureRandom()::nextBytes)
        val iv = ByteArray(12).also(SecureRandom()::nextBytes)
        val aes = Cipher.getInstance("AES/GCM/NoPadding")
        aes.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        val encrypted = aes.doFinal(input.toString().toByteArray(Charsets.UTF_8))
        val rsa = Cipher.getInstance("RSA/ECB/OAEPWithSHA-256AndMGF1Padding")
        rsa.init(Cipher.ENCRYPT_MODE, publicKey, OAEPParameterSpec("SHA-256", "MGF1", java.security.spec.MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT))
        return JSONObject()
            .put("encryptedKey", Base64.encodeToString(rsa.doFinal(key), Base64.NO_WRAP))
            .put("iv", Base64.encodeToString(iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP))
    }

    fun providerCommand(action: String, details: JSONObject): String = command(action, payload = encryptForMac(details))
}
