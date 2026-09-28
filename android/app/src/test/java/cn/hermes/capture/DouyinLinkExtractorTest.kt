package cn.hermes.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DouyinLinkExtractorTest {
    @Test
    fun extractsShortLinkFromShareText() {
        val text = "7.12 复制打开抖音，看看【示例】 https://v.douyin.com/U_YC5VdXP-w/ 03/15"
        assertEquals(listOf("https://v.douyin.com/U_YC5VdXP-w/"), DouyinLinkExtractor.extract(text))
    }

    @Test
    fun trimsChinesePunctuation() {
        val text = "链接：https://www.douyin.com/video/123456。"
        assertEquals(listOf("https://www.douyin.com/video/123456"), DouyinLinkExtractor.extract(text))
    }

    @Test
    fun rejectsLookalikeDomain() {
        assertFalse(DouyinLinkExtractor.isDouyinUrl("https://evil-douyin.com/video/1"))
        assertTrue(DouyinLinkExtractor.extract("复制 https://evil-douyin.com/video/1").isEmpty())
    }

    @Test
    fun deduplicatesLinks() {
        val link = "https://v.douyin.com/example/"
        assertEquals(listOf(link), DouyinLinkExtractor.extract("$link 再发一次 $link"))
    }
}
