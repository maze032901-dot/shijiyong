package cn.hermes.capture

import android.content.ClipboardManager
import android.content.Context

object ClipboardReader {
    fun readText(context: Context): CharSequence? {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        val clip = clipboard.primaryClip ?: return null
        if (clip.itemCount == 0) return null
        return clip.getItemAt(0).coerceToText(context)
    }
}
