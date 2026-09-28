package cn.hermes.capture

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts

/** Only the launcher UI changes; the verified accessibility and upload services remain untouched. */
class MainActivity : ComponentActivity() {
    private val captureStore by lazy { CaptureStore(this) }
    private val export = registerForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri: Uri? ->
        uri ?: return@registerForActivityResult
        contentResolver.openOutputStream(uri)?.use { it.write(captureStore.exportJson().toByteArray(Charsets.UTF_8)) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            HermesMobileApp(
                context = this,
                captureStore = captureStore,
                serviceEnabled = ::isServiceEnabled,
                openAccessibility = { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) },
                exportDiagnostics = { export.launch("hermes-android-${System.currentTimeMillis()}.json") }
            )
        }
    }

    private fun isServiceEnabled(): Boolean {
        val expected = ComponentName(this, HermesAccessibilityService::class.java)
        val active = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        return active.split(':').mapNotNull(ComponentName::unflattenFromString).any { it == expected }
    }
}
