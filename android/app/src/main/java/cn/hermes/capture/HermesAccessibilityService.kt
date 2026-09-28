package cn.hermes.capture

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityEvent
import android.widget.Toast

class HermesAccessibilityService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var store: CaptureStore
    private var lastBridgeLaunchAt = 0L
    private var lastSharePanelDetectedAt = 0L

    override fun onCreate() {
        super.onCreate()
        store = CaptureStore(this)
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        store.add(
            CaptureRecord(
                timestamp = System.currentTimeMillis(),
                trigger = "service",
                outcome = "service_connected"
            )
        )
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        event ?: return
        if (event.packageName?.toString() != DOUYIN_PACKAGE) return

        when (event.eventType) {
            AccessibilityEvent.TYPE_VIEW_CLICKED -> {
                if (event.visibleTexts().any { it.contains("复制链接") }) {
                    scheduleClipboardRead("view_clicked")
                }
            }

            AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED -> {
                if (event.visibleTexts().any(::looksLikeCopiedMessage)) {
                    scheduleClipboardRead("copy_message")
                }
            }

            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> detectSharePanel()
        }
    }

    override fun onInterrupt() {
        store.add(
            CaptureRecord(
                timestamp = System.currentTimeMillis(),
                trigger = "service",
                outcome = "service_interrupted"
            )
        )
    }

    private fun scheduleClipboardRead(trigger: String) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastBridgeLaunchAt < BRIDGE_DEBOUNCE_MS) return
        lastBridgeLaunchAt = now

        store.add(
            CaptureRecord(
                timestamp = System.currentTimeMillis(),
                trigger = trigger,
                outcome = "trigger_detected"
            )
        )

        handler.postDelayed({ readDirectlyOrLaunchBridge(trigger) }, CLIPBOARD_SETTLE_MS)
    }

    private fun readDirectlyOrLaunchBridge(trigger: String) {
        val text = ClipboardReader.readText(this)
        val link = DouyinLinkExtractor.extract(text).firstOrNull()
        if (link != null) {
            store.saveLink(System.currentTimeMillis(), trigger, "captured_direct", link)
            LinkSyncScheduler.syncNow(this)
            Toast.makeText(this, "拾即用：已收藏", Toast.LENGTH_SHORT).show()
            return
        }

        store.add(
            CaptureRecord(
                timestamp = System.currentTimeMillis(),
                trigger = trigger,
                outcome = "direct_clipboard_unavailable"
            )
        )
        try {
            ClipboardBridgeActivity.launch(this, trigger)
        } catch (_: Exception) {
            store.add(
                CaptureRecord(
                    timestamp = System.currentTimeMillis(),
                    trigger = trigger,
                    outcome = "bridge_start_failed"
                )
            )
        }
    }

    private fun detectSharePanel() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastSharePanelDetectedAt < SHARE_PANEL_DEBOUNCE_MS) return
        if (!containsCopyLink(rootInActiveWindow)) return
        lastSharePanelDetectedAt = now
        store.add(
            CaptureRecord(
                timestamp = System.currentTimeMillis(),
                trigger = "window_content",
                outcome = "share_panel_detected"
            )
        )
    }

    private fun containsCopyLink(root: AccessibilityNodeInfo?): Boolean {
        root ?: return false
        val pending = ArrayDeque<AccessibilityNodeInfo>()
        pending.add(root)
        var visited = 0

        while (pending.isNotEmpty() && visited < MAX_NODES_PER_SCAN) {
            val node = pending.removeFirst()
            visited += 1
            val text = node.text?.toString().orEmpty()
            val description = node.contentDescription?.toString().orEmpty()
            if (text.contains("复制链接") || description.contains("复制链接")) return true
            for (index in 0 until node.childCount) {
                node.getChild(index)?.let(pending::add)
            }
        }
        return false
    }

    private fun AccessibilityEvent.visibleTexts(): List<String> = buildList {
        text.mapTo(this) { it.toString() }
        source?.text?.toString()?.takeIf { it.isNotBlank() }?.let(::add)
        source?.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let(::add)
        contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let(::add)
    }

    private fun looksLikeCopiedMessage(value: String): Boolean {
        return value == "复制" || value.contains("已复制") || value.contains("复制成功")
    }

    companion object {
        const val DOUYIN_PACKAGE = "com.ss.android.ugc.aweme"
        private const val CLIPBOARD_SETTLE_MS = 120L
        private const val BRIDGE_DEBOUNCE_MS = 1_500L
        private const val SHARE_PANEL_DEBOUNCE_MS = 2_000L
        private const val MAX_NODES_PER_SCAN = 250
    }
}
