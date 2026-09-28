import { chromium } from 'playwright-core';

const PAGE_TIMEOUT_MS = 30_000;
const VIDEO_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 20_000;
const MAX_PROBE_ATTEMPTS = 3;
const MEDIA_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const IMAGE_CONTENT_TYPES = new Set(['image/jpeg', 'image/webp', 'image/png']);

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function shouldTryBrowserCapture(result) {
  if (result?.status !== 'failed' || !/^\d{12,22}$/.test(String(result.aweme_id ?? ''))) return false;
  if (result.error_type === 'EmptyPlatformResponse') return true;
  const events = result.diagnostic?.f2_events;
  return Array.isArray(events) && events.some((event) => event?.http_status === 403);
}

export function isDouyinVideoResponse(response) {
  let url;
  try { url = new URL(response.url()); } catch { return false; }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.douyinvod.com')) return false;
  if (![200, 206].includes(response.status())) return false;
  const contentType = cleanText(response.headers()['content-type']).split(';', 1)[0].toLowerCase();
  return contentType === 'video/mp4';
}

function isAwemeImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.douyinpic.com')) return false;
    return url.searchParams.get('biz_tag') === 'aweme_images' || url.pathname.includes('aweme-images');
  } catch {
    return false;
  }
}

export function isDouyinImageResponse(response) {
  if (!isAwemeImageUrl(response.url())) return false;
  if (![200, 206].includes(response.status())) return false;
  const contentType = cleanText(response.headers()['content-type']).split(';', 1)[0].toLowerCase();
  return IMAGE_CONTENT_TYPES.has(contentType);
}

async function probeVideo(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'video/mp4,application/octet-stream;q=0.8,*/*;q=0.1',
      'User-Agent': MEDIA_USER_AGENT,
      Referer: 'https://www.douyin.com/',
      Range: 'bytes=0-32767'
    },
    redirect: 'error',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  });
  const status = typeof response.status === 'function' ? response.status() : response.status;
  if (![200, 206].includes(status)) throw new Error(`网页视频素材不可读取（HTTP ${status}）`);

  // page.request returns a Playwright APIResponse whose body() is a Buffer;
  // the injected test/global fetch returns a Web Response with a stream.
  let prefix;
  if (typeof response.body === 'function') {
    prefix = Buffer.from(await response.body()).subarray(0, 32_768);
  } else {
    if (!response.body) throw new Error('网页视频素材响应为空');
    const reader = response.body.getReader();
    prefix = Buffer.alloc(0);
    try {
      while (prefix.length < 32_768) {
        const { value, done } = await reader.read();
        if (done) break;
        prefix = Buffer.concat([prefix, Buffer.from(value).subarray(0, 32_768 - prefix.length)]);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  if (!prefix.subarray(0, 32).includes(Buffer.from('ftyp'))) throw new Error('网页视频素材不是有效 MP4');
  const tracks = new Set();
  let cursor = -1;
  while ((cursor = prefix.indexOf(Buffer.from('hdlr'), cursor + 1)) >= 0) {
    if (cursor < 4 || cursor + 16 > prefix.length || prefix.readUInt32BE(cursor - 4) < 20) continue;
    const kind = prefix.toString('ascii', cursor + 12, cursor + 16);
    if (kind === 'vide' || kind === 'soun') tracks.add(kind);
  }
  if (tracks.size === 0) throw new Error('无法判别网页 MP4 的音视频轨道');
  return tracks;
}

function pagePath(page, fallback) {
  try {
    return new URL(typeof page.url === 'function' ? page.url() : fallback).pathname;
  } catch {
    return fallback;
  }
}

async function readPageInfo(page) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await page.evaluate(() => ({
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.content ?? '',
        directVideoUrl: [...document.querySelectorAll('video')]
          .map((video) => video.currentSrc || video.src)
          .find((value) => value?.startsWith('https://')) ?? ''
      }));
    } catch (error) {
      lastError = error;
      if (!/execution context was destroyed|navigation/i.test(String(error?.message ?? ''))) throw error;
      if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(250).catch(() => {});
    }
  }
  throw lastError;
}

async function collectGalleryImageUrls(page, responseUrls) {
  const urls = [];
  const add = (value) => {
    if (isAwemeImageUrl(value) && !urls.includes(value)) urls.push(value);
  };
  responseUrls.forEach(add);

  // Gallery pages lazy-load their main images. A short bounded scroll lets the
  // page request the remaining images without turning the fallback into a
  // general-purpose crawler.
  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  for (let round = 0; round < 8 && Date.now() < deadline; round += 1) {
    const domUrls = await page.evaluate(() => [...document.images]
      .map((image) => image.currentSrc || image.src)
      .filter(Boolean));
    domUrls.forEach(add);
    if (round >= 2 && urls.length > 0) break;
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.85, 640))).catch(() => {});
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(500).catch(() => {});
  }
  return urls;
}

/**
 * Read a public video page in a new, non-persistent Chrome context. This never
 * imports the user's browser profile or account cookies. Signed media URLs are
 * returned only for immediate processing by the paired Mac.
 */
export async function captureDouyinBrowser({ sourceUrl, awemeId, browserType = chromium, fetchImpl = fetch }) {
  const id = String(awemeId ?? '');
  if (!/^\d{12,22}$/.test(id)) throw new Error('作品 ID 无效，无法打开公开网页');
  const noteUrl = `https://www.douyin.com/note/${id}`;
  const canonicalUrl = `https://www.douyin.com/video/${id}`;
  const browser = await browserType.launch({ channel: 'chrome', headless: true, timeout: PAGE_TIMEOUT_MS });
  try {
    const page = await browser.newPage({ locale: 'zh-CN' });
    const mediaUrls = [];
    const imageUrls = [];
    page.on('response', (response) => {
      if (isDouyinVideoResponse(response) && !mediaUrls.includes(response.url())) mediaUrls.push(response.url());
      if (isDouyinImageResponse(response) && !imageUrls.includes(response.url())) imageUrls.push(response.url());
    });
    await page.goto(noteUrl, { waitUntil: 'commit', timeout: PAGE_TIMEOUT_MS });
    // A short-link-style note route can perform one client redirect after the
    // initial commit. Wait for the first DOM-ready state before evaluating it,
    // otherwise Playwright may report a destroyed execution context.
    if (typeof page.waitForLoadState === 'function') {
      await page.waitForLoadState('domcontentloaded', { timeout: PAGE_TIMEOUT_MS }).catch(() => {});
    }
    await page.waitForFunction(() => Boolean(document.title), null, { timeout: 5_000 }).catch(() => {});
    let finalPath = pagePath(page, noteUrl);
    let pageInfo = await readPageInfo(page);

    let galleryAttempted = false;
    if (/\/note\/\d+/.test(finalPath)) {
      galleryAttempted = true;
      const galleryUrls = await collectGalleryImageUrls(page, imageUrls);
      if (galleryUrls.length > 0) {
        const title = cleanText(pageInfo.title).replace(/\s+-\s*抖音\s*$/, '');
        const description = title || cleanText(pageInfo.description).slice(0, 2000);
        return {
          status: 'captured',
          retryable: false,
          capture_method: 'public_browser',
          aweme_id: id,
          source_url: sourceUrl,
          canonical_url: `https://www.douyin.com/note/${id}`,
          author: null,
          description,
          created_at: null,
          media_kind: 'gallery',
          media_signals: { aweme_type: 68, has_images: true, has_video_play_url: false, has_audio_play_url: false },
          media_manifest: galleryUrls.map((url, index) => ({ aweme_id: id, kind: 'image', index: index + 1, url })),
          media: [],
          captured_at: new Date().toISOString()
        };
      }

      // Some video IDs briefly remain on the note route without gallery
      // images. Navigate explicitly to the video route before deciding that
      // the public page has no usable media.
      await page.goto(canonicalUrl, { waitUntil: 'commit', timeout: PAGE_TIMEOUT_MS });
      if (typeof page.waitForLoadState === 'function') {
        await page.waitForLoadState('domcontentloaded', { timeout: PAGE_TIMEOUT_MS }).catch(() => {});
      }
      await page.waitForFunction(() => Boolean(document.title), null, { timeout: 5_000 }).catch(() => {});
      finalPath = pagePath(page, canonicalUrl);
      pageInfo = await readPageInfo(page);
    }

    try {
      await page.waitForFunction(
        () => [...document.querySelectorAll('video')].some((video) => video.readyState >= 2),
        null,
        { timeout: VIDEO_TIMEOUT_MS }
      );
    } catch (error) {
      // Some public pages yield playable MP4 requests before the DOM video
      // reports readyState >= 2. The media response is the useful evidence.
      if (!/Timeout/i.test(String(error?.message ?? ''))) throw error;
    }
    await page.waitForFunction(() => Boolean(document.title), null, { timeout: 5_000 }).catch(() => {});
    const direct = pageInfo.directVideoUrl;
    if (direct && !mediaUrls.includes(direct)) {
      const candidate = {
        url: () => direct,
        status: () => 200,
        headers: () => ({ 'content-type': 'video/mp4' })
      };
      if (isDouyinVideoResponse(candidate)) mediaUrls.push(direct);
    }
    let videoUrl;
    let audioUrl;
    let lastError;
    const probeAttempts = new Map();
    const deadline = Date.now() + VIDEO_TIMEOUT_MS;
    while (Date.now() < deadline) {
      for (const candidate of mediaUrls.filter((url) => (probeAttempts.get(url) ?? 0) < MAX_PROBE_ATTEMPTS)) {
        probeAttempts.set(candidate, (probeAttempts.get(candidate) ?? 0) + 1);
        try {
          // A signed media URL can be bound to the browser context that
          // produced it. Prefer Playwright's request context so cookies and
          // browser headers are retained; tests and callers can still inject
          // a normal fetch implementation when no request context exists.
          const pageFetch = page.request?.get
            ? (url, options) => page.request.get(url, {
                headers: options.headers,
                maxRedirects: 0,
                failOnStatusCode: false,
                timeout: PROBE_TIMEOUT_MS
              })
            : fetchImpl;
          const tracks = await probeVideo(candidate, pageFetch);
          if (tracks.has('vide') && tracks.has('soun')) {
            videoUrl = candidate;
            audioUrl = null;
            break;
          }
          if (tracks.has('vide') && !videoUrl) videoUrl = candidate;
          if (tracks.has('soun') && !audioUrl) audioUrl = candidate;
        } catch (error) {
          lastError = error;
        }
      }
      if (videoUrl && audioUrl !== undefined) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await page.waitForResponse(isDouyinVideoResponse, { timeout: Math.min(2500, remaining) }).catch(() => {});
    }
    if (!videoUrl && audioUrl) throw new Error('公开网页只加载了音轨，未取得画面流');
    if (!videoUrl && mediaUrls.length === 0) {
      throw new Error(galleryAttempted
        ? '公开网页已打开，但未观察到可下载的图文或视频素材'
        : '公开网页已打开，但未观察到可下载的 douyinvod 视频响应');
    }
    if (!videoUrl) throw lastError ?? new Error('网页视频素材不可读取');
    if (audioUrl === undefined) throw new Error('公开网页只提供无声视频，当前自动 ASR 尚不能处理');
    const title = cleanText(pageInfo.title).replace(/\s+-\s*抖音\s*$/, '');
    const description = title || cleanText(pageInfo.description).slice(0, 2000);
    return {
      status: 'captured',
      retryable: false,
      capture_method: 'public_browser',
      aweme_id: id,
      source_url: sourceUrl,
      canonical_url: canonicalUrl,
      author: null,
      description,
      created_at: null,
      media_kind: 'video',
      media_signals: { aweme_type: null, has_images: false, has_video_play_url: true, has_audio_play_url: true },
      media_manifest: [
        { aweme_id: id, kind: 'video', index: 1, url: videoUrl },
        ...(audioUrl ? [{ aweme_id: id, kind: 'audio', index: 1, url: audioUrl }] : [])
      ],
      media: [],
      captured_at: new Date().toISOString()
    };
  } finally {
    await browser.close();
  }
}
