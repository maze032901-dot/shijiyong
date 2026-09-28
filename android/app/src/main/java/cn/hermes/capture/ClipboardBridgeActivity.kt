package cn.hermes.capture

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Toast

class ClipboardBridgeActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var store: CaptureStore
    private var completed = false
    private var attemptsScheduled = false
    private val trigger: String by lazy {
        intent.getStringExtra(EXTRA_TRIGGER) ?: "unknown"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = CaptureStore(this)

        window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        window.setDimAmount(0f)
        window.setGravity(Gravity.BOTTOM or Gravity.END)
        window.addFlags(WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL)
        setContentView(View(this).apply { alpha = 0.01f })
        window.setLayout(1, 1)
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus && !attemptsScheduled) {
            attemptsScheduled = true
            scheduleAttempts()
        }
    }

    private fun scheduleAttempts() {
        ATTEMPT_DELAYS.forEachIndexed { index, delay ->
            handler.postDelayed({ attemptRead(index) }, delay)
        }
    }

    private fun attemptRead(index: Int) {
        if (completed) return

        val text = ClipboardReader.readText(this)
        val links = DouyinLinkExtractor.extract(text)

        if (links.isNotEmpty()) {
            completed = true
            val link = links.first()
            store.saveLink(System.currentTimeMillis(), trigger, "captured", link)
            LinkSyncScheduler.syncNow(this)
            Toast.makeText(this, "拾即用：已收藏", Toast.LENGTH_SHORT).show()
            closeBridge()
            return
        }

        if (index == ATTEMPT_DELAYS.lastIndex) {
            completed = true
            store.add(
                CaptureRecord(
                    timestamp = System.currentTimeMillis(),
                    trigger = trigger,
                    outcome = if (text.isNullOrBlank()) "clipboard_unavailable" else "no_douyin_link"
                )
            )
            Toast.makeText(this, "拾即用：没有读到抖音链接", Toast.LENGTH_SHORT).show()
            closeBridge()
        }
    }

    private fun closeBridge() {
        handler.removeCallbacksAndMessages(null)
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    companion object {
        private const val EXTRA_TRIGGER = "trigger"
        private val ATTEMPT_DELAYS = longArrayOf(0L, 100L, 250L, 500L, 900L)

        fun launch(context: Context, trigger: String) {
            val intent = Intent(context, ClipboardBridgeActivity::class.java)
                .putExtra(EXTRA_TRIGGER, trigger)
                .addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_NO_ANIMATION or
                        Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
                )
            context.startActivity(intent)
        }
    }
}
