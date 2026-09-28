import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openIntakeStore } from './intake-store.mjs';
import { CloudStatusError, fetchCloudJobs, manageCloudJob, readCloudStatusConfig, summarizeCloudJobs } from './cloud-status.mjs';
import { loadPublishedLibrary } from './published-card-library.mjs';
import { openMobileLibraryStore } from './mobile-library-store.mjs';
import { intakeCardFromJob, mergeIntakeJobs } from './intake-card-library.mjs';
import { loadCardProcessingStatuses, writeCardProcessingStatus } from './card-processing-status.mjs';
import { enqueueLocalRetry } from './local-retry-queue.mjs';
import { resolveRetryStage, validEventId } from './retry-stage.mjs';
import { resolvePublishedImage } from './published-media.mjs';
import { activateProvider, listPublicProviders, loadProviderSettings, removeProvider, saveProvider, testProviderConnection } from './ai-provider-store.mjs';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(appDirectory, '..');
const publicDirectory = path.join(appDirectory, 'public');
const localRuntimeDirectory = path.join(projectDirectory, 'runtime');
// In development everything stays below runtime/.  The cloud container points this
// at its mounted /data volume so a redeploy never erases a user's saved evidence.
const dataDirectory = path.resolve(process.env.HERMES_DATA_DIR ?? localRuntimeDirectory);
const captureDirectory = path.join(localRuntimeDirectory, 'f2-capture-spike', 'captured');
const liveCaptureDirectory = path.join(dataDirectory, 'live-captures');
const publishedCardDirectory = path.join(localRuntimeDirectory, 'card-library', 'published');
const intakeStore = openIntakeStore(path.join(dataDirectory, 'intake-queue.sqlite'));
const mobileLibrary = openMobileLibraryStore(path.join(dataDirectory, 'mobile-library'));
const port = Number.parseInt(process.env.PORT ?? '4318', 10);
const lanMode = process.argv.includes('--lan');
const bindHost = process.env.BIND_HOST ?? (lanMode ? '0.0.0.0' : '127.0.0.1');
const receiverConfigPath = path.join(localRuntimeDirectory, 'receiver.local.json');
// Published bundles are the product source of truth.

// The local library should never wait for a network round trip just to open a page.
// Keep cloud intake status warm in the background; local intake remains read live.
const cloudJobsRefreshIntervalMs = 15_000;
let cachedCloudJobs = [];
let cloudJobsRefreshedAt = 0;
let cloudJobsRefresh = null;

function refreshCloudJobs() {
  if (lanMode || cloudJobsRefresh) return cloudJobsRefresh;
  cloudJobsRefreshedAt = Date.now();
  cloudJobsRefresh = (async () => {
    try {
      const config = await readCloudStatusConfig(projectDirectory);
      cachedCloudJobs = await fetchCloudJobs(config);
    } catch {
      // Keep the last known status while offline.
    } finally {
      cloudJobsRefresh = null;
    }
  })();
  return cloudJobsRefresh;
}

function currentCloudJobs() {
  if (!lanMode && Date.now() - cloudJobsRefreshedAt >= cloudJobsRefreshIntervalMs) {
    void refreshCloudJobs();
  }
  return cachedCloudJobs;
}

if (!lanMode) void refreshCloudJobs();

function receiverToken() {
  if (existsSync(receiverConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(receiverConfigPath, 'utf8'));
      if (typeof config.token === 'string' && config.token.length >= 20) return config.token;
    } catch {
      // Regenerate a local-only token below.
    }
  }
  mkdirSync(path.dirname(receiverConfigPath), { recursive: true });
  const token = randomBytes(24).toString('base64url');
  writeFileSync(receiverConfigPath, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 });
  return token;
}

const intakeToken = process.env.HERMES_INTAKE_TOKEN || receiverToken();
const mobileToken = process.env.HERMES_MOBILE_TOKEN || '';
const mobilePublishToken = process.env.HERMES_MOBILE_PUBLISH_TOKEN || '';
if ([mobileToken, mobilePublishToken].some((token) => token && token.length < 24)) {
  throw new Error('手机凭据至少需要 24 个字符');
}
if ((mobileToken && mobileToken === intakeToken) || (mobilePublishToken && mobilePublishToken === intakeToken)
  || (mobileToken && mobilePublishToken && mobileToken === mobilePublishToken)) {
  throw new Error('接收、手机和 Mac 发布凭据必须互不相同');
}
intakeStore.recoverInterrupted();
const macEventClients = new Set();

function sendSse(response, eventName, payload) {
  try {
    response.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    return true;
  } catch {
    macEventClients.delete(response);
    return false;
  }
}

function notifyMacWorkers() {
  for (const response of macEventClients) sendSse(response, 'job_available', { available: true });
}

const macEventHeartbeat = setInterval(() => {
  for (const response of macEventClients) sendSse(response, 'heartbeat', { at: new Date().toISOString() });
}, 25_000);
macEventHeartbeat.unref();

const resourceLabels = {
  github: 'GitHub',
  website: '项目入口',
  app_store: '应用商店',
  plugin_page: '插件页',
  prompt_text: '复制 Prompt',
  image_file: '查看原图',
  other: '查看资源'
};

function cleanTitle(description, fallback) {
  const firstSentence = String(description ?? '').split(/[。！#]/)[0].trim();
  return firstSentence || fallback;
}

function featuredContent(card) {
  if (card.type === 'method' && card.paths.length > 0) {
    return card.paths.map((item) => ({ label: item.title, value: '', kind: 'path' }));
  }

  if (card.type === 'prompt') {
    const prompt = card.content.find((field) => field.kind === 'prompt');
    return prompt ? [prompt] : [{ label: 'Prompt', value: 'Prompt 原文尚未提取。', kind: 'text' }];
  }

  return card.content.slice(0, 2);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(projectDirectory, relativePath), 'utf8'));
}

function localMediaUrl(awemeId, fileName) {
  return `/media/${encodeURIComponent(awemeId)}/${encodeURIComponent(fileName)}`;
}

function liveMediaUrl(awemeId, fileName) {
  return `/live-media/${encodeURIComponent(awemeId)}/${encodeURIComponent(fileName)}`;
}

function captureCardFromSnapshot(item, media, options = {}) {
  const capturedMedia = media.filter((entry) => entry.status === 'captured');
  const cover = capturedMedia.find((entry) => entry.kind === 'cover');
  const video = capturedMedia.find((entry) => entry.kind === 'video');
  const images = capturedMedia.filter((entry) => entry.kind === 'image').sort((a, b) => a.index - b.index);
  const urlFor = options.live ? liveMediaUrl : localMediaUrl;
  const route = item.media_kind === 'gallery' ? 'note' : 'video';
  const source = {
    id: `source_douyin_${item.aweme_id}`,
    title: '抖音收藏',
    author: item.author ?? null,
    kind: item.media_kind === 'gallery' ? 'note' : 'video',
    originKind: 'douyin',
    originalUrl: item.canonical_url ?? `https://www.douyin.com/${route}/${item.aweme_id}`,
    savedCopyUrl: video
      ? urlFor(item.aweme_id, video.fileName ?? video.file)
      : images[0]
        ? urlFor(item.aweme_id, images[0].fileName ?? images[0].file)
        : cover
          ? urlFor(item.aweme_id, cover.fileName ?? cover.file)
          : null,
    savedAt: item.captured_at ?? item.created_at ?? null
  };
  const card = {
    id: `${options.live ? 'live' : 'capture'}_${item.aweme_id}`,
    type: 'generic_unknown',
    subtype: null,
    title: cleanTitle(item.description, `抖音收藏 · ${item.author ?? '未知作者'}`),
    topics: [],
    status: 'pending',
    content: [{ label: '原始描述', value: item.description ?? '作品未提供文字描述。', kind: 'text', claimKind: 'observed_fact' }],
    paths: [],
    resources: [],
    sources: [source],
    missing: [{ field: '内容卡片', reason: '已保存原内容，尚未整理为具体内容卡。' }],
    media: {
      kind: item.media_kind ?? 'unknown',
      coverUrl: cover ? urlFor(item.aweme_id, cover.fileName ?? cover.file) : null,
      videoUrl: video ? urlFor(item.aweme_id, video.fileName ?? video.file) : null,
      imageUrls: images.map((entry) => urlFor(item.aweme_id, entry.fileName ?? entry.file))
    },
    origin: options.live ? 'live_capture' : 'capture'
  };
  card.featuredContent = [{ label: '已保存内容', value: item.description ?? '作品未提供文字描述。', kind: 'text' }];
  return card;
}

async function buildLibrary() {
  const [localPublished, processingStatuses, mobileSnapshot] = await Promise.all([
    loadPublishedLibrary({ directory: publishedCardDirectory, resourceLabels }),
    loadCardProcessingStatuses(projectDirectory),
    mobileLibrary.library()
  ]);
  const localCardIds = new Set(localPublished.cards.map((card) => card.id));
  const mobileCards = mobileSnapshot.cards.filter((card) => !localCardIds.has(card.id)).map((card) => {
    const webImage = (value) => typeof value === 'string' && /^\/api\/mobile\/v1\/media\/[a-f0-9]{64}\.(?:jpg|jpeg|png|webp)$/.test(value)
      ? value.replace('/api/mobile/v1/media/', '/web-media/') : null;
    const imageUrls = (card.media?.imageUrls || []).map(webImage).filter(Boolean);
    return { ...card, origin: 'mobile_publication',
      collection: { id: card.sourceId, title: card.sources?.[0]?.title || '来自同一收藏' },
      media: imageUrls.length ? { coverUrl: webImage(card.media?.coverUrl) || imageUrls[0], imageUrls } : null,
      featuredContent: card.content?.slice(0, 2) || [] };
  });
  const publishedData = { cards: [...localPublished.cards, ...mobileCards],
    topics: [...localPublished.topics, ...mobileSnapshot.topics],
    awemeIds: [...localPublished.awemeIds, ...new Set(mobileCards.map((card) => card.sourceId))] };
  const cloudJobs = currentCloudJobs();
  const jobs = mergeIntakeJobs(intakeStore.list(), cloudJobs);
  const dismissedSourceIds = new Set(jobs.filter((job) => job.status === 'dismissed')
    .map((job) => String(job.awemeId || job.result?.aweme_id || job.sourceUrl?.match(/\/(?:video|note)\/(\d+)/)?.[1] || ''))
    .filter(Boolean));
  const cards = [...publishedData.cards]
    .filter((card) => !dismissedSourceIds.has(String(card.sources?.[0]?.originalUrl?.match(/\/(?:video|note)\/(\d+)/)?.[1] || '')));
  const topicMap = new Map();
  for (const item of [publishedData]) {
    for (const topic of item.topics) {
      if (!topicMap.has(topic.id)) topicMap.set(topic.id, { ...topic, cardIds: [] });
    }
  }
  for (const card of cards) {
    for (const topic of card.topics) topicMap.get(topic.id)?.cardIds.push(card.id);
  }

  const [guestProbe, mediaManifest] = await Promise.all([
    readJson('runtime/f2-capture-spike/guest-identity-probe.json').catch(() => null),
    readJson('runtime/f2-capture-spike/media-capture-manifest.json').catch(() => null)
  ]);
  const mediaByAweme = new Map();
  for (const media of (mediaManifest?.results ?? []).filter((item) => item.status === 'captured')) {
    const list = mediaByAweme.get(media.aweme_id) ?? [];
    list.push({ ...media, fileName: path.basename(media.path) });
    mediaByAweme.set(media.aweme_id, list);
  }

  for (const item of (guestProbe?.results ?? []).filter((result) => result.status === 'fetched')) {
    if (dismissedSourceIds.has(String(item.aweme_id))) continue;
    if (publishedData.awemeIds.includes(String(item.aweme_id))) continue;
    const capturedMedia = mediaByAweme.get(item.aweme_id) ?? [];
    cards.push(captureCardFromSnapshot(item, capturedMedia));
  }

  // Intake placeholders become visible as soon as the cloud acknowledges the
  // Android event. A published card replaces its placeholder by aweme id.
  const intakeCards = [];
  for (const job of jobs) {
    if (job.status === 'dismissed' || job.status === 'published') continue;
    const localStatus = processingStatuses.get(job.eventId);
    if (publishedData.awemeIds.includes(String(job.awemeId)) && localStatus?.status !== 'review_pending') continue;
    const card = intakeCardFromJob(job, { localStatus });
    if (['failed', 'retryable'].includes(card.status)) {
      try {
        const plan = await resolveRetryStage({ projectDirectory, job, localStatus });
        card.processingState.retryLabel = plan.kind === 'completed' ? '确认已生成卡片' : plan.label;
      } catch { card.processingState.retryLabel = '从失败处继续'; }
    }
    intakeCards.push(card);
  }
  cards.unshift(...intakeCards);

  const topics = [...topicMap.values()]
    .map((topic) => ({ ...topic, totalCount: topic.cardIds.length }))
    .sort((a, b) => b.totalCount - a.totalCount || a.title.localeCompare(b.title, 'zh-CN'));

  return {
    product: {
      name: '拾即用',
      mode: '自部署 · 本地卡片库',
      dataSources: ['published', 'intake_queue']
    },
    updatedAt: new Date().toISOString(),
    cloudSyncPending: Boolean(cloudJobsRefresh),
    topics,
    cards
  };
}

function textForSearch(card) {
  return [
    card.title,
    card.type,
    ...card.topics.map((topic) => topic.title),
    ...card.content.map((field) => `${field.label} ${field.value}`),
    ...card.paths.flatMap((item) => [item.title, ...item.steps]),
    ...card.sources.flatMap((source) => [source.title, source.author ?? ''])
  ].join('\n').toLocaleLowerCase('zh-CN');
}

function filterCards(library, query) {
  const keyword = (query.get('query') ?? '').trim().toLocaleLowerCase('zh-CN');
  const type = query.get('type') ?? '';
  const status = query.get('status') ?? '';
  const topic = query.get('topic') ?? '';
  return library.cards.filter((card) => {
    if (keyword && !textForSearch(card).includes(keyword)) return false;
    if (type && card.type !== type) return false;
    if (status && card.status !== status) return false;
    if (topic && !card.topics.some((item) => item.id === topic)) return false;
    return true;
  });
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.json': 'application/json; charset=utf-8'
};

async function sendFile(request, response, filePath) {
  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  if (!fileInfo.isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const contentType = mimeTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  const range = request.headers.range;
  const cacheControl = 'private, max-age=0, must-revalidate';
  const etag = `"${fileInfo.size.toString(16)}-${Math.trunc(fileInfo.mtimeMs).toString(16)}"`;
  const cacheHeaders = { 'Cache-Control': cacheControl, ETag: etag };
  if (!range && request.headers['if-none-match'] === etag) {
    response.writeHead(304, cacheHeaders);
    response.end();
    return;
  }
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match?.[1] ? Number.parseInt(match[1], 10) : 0;
    const end = match?.[2] ? Number.parseInt(match[2], 10) : fileInfo.size - 1;
    if (!match || start >= fileInfo.size || end < start) {
      response.writeHead(416, { 'Content-Range': `bytes */${fileInfo.size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${fileInfo.size}`,
      'Content-Length': end - start + 1,
      ...cacheHeaders
    });
    createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': fileInfo.size,
    'Accept-Ranges': 'bytes',
    ...cacheHeaders
  });
  createReadStream(filePath).pipe(response);
}

function safePath(root, pathname) {
  const decoded = decodeURIComponent(pathname);
  const target = path.resolve(root, `.${decoded}`);
  return target.startsWith(`${root}${path.sep}`) || target === root ? target : null;
}

function isDouyinUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'));
  } catch {
    return false;
  }
}

function isAuthorised(request) {
  return request.headers.authorization === `Bearer ${intakeToken}`;
}

function hasBearer(request, expected) {
  if (!expected || expected.length < 24) return false;
  const supplied = String(request.headers.authorization || '').replace(/^Bearer /, '');
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isLocalRequest(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
}

async function readJsonBody(request, maximumSize = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumSize) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readBinaryBody(request, maximumSize = 5 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumSize) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const pathname = requestUrl.pathname;

    if (pathname.startsWith('/api/mobile/v1/') || pathname.startsWith('/api/mac/mobile/')) {
      const macRoute = pathname.startsWith('/api/mac/mobile/');
      if (!hasBearer(request, macRoute ? mobilePublishToken : mobileToken)) {
        return sendJson(response, macRoute ? (mobilePublishToken ? 401 : 503) : (mobileToken ? 401 : 503),
          { error: macRoute ? 'Mac 发布凭据未配置或无效' : '手机凭据未配置或无效' });
      }
      try {
        if (request.method === 'GET' && pathname === '/api/mobile/v1/library') {
          const library = await mobileLibrary.library();
          const etag = `"${library.revision}"`;
          if (request.headers['if-none-match'] === etag) { response.writeHead(304, { ETag: etag }); response.end(); return; }
          response.setHeader('ETag', etag);
          return sendJson(response, 200, library);
        }
        if (request.method === 'GET' && pathname.startsWith('/api/mobile/v1/media/')) {
          const media = await mobileLibrary.mediaPath(pathname.slice('/api/mobile/v1/media/'.length));
          return media ? sendFile(request, response, media.path) : sendJson(response, 404, { error: '图片不存在' });
        }
        if (request.method === 'GET' && pathname === '/api/mobile/v1/jobs') {
          const progress = new Map((await mobileLibrary.progress()).map((item) => [item.eventId, item]));
          return sendJson(response, 200, { jobs: intakeStore.list().filter((item) => item.status !== 'dismissed').map((item) => ({
            eventId: item.eventId, sourceId: item.awemeId || null, sourceUrl: item.sourceUrl, savedAt: item.savedAt, status: item.status,
            title: item.result?.description || item.result?.title || null, error: item.error, updatedAt: item.updatedAt,
            progress: progress.get(item.eventId) || null
          })) });
        }
        if (request.method === 'GET' && pathname === '/api/mobile/v1/providers') return sendJson(response, 200, await mobileLibrary.providerView());
        if (request.method === 'GET' && pathname === '/api/mobile/v1/mac-key') {
          const key = await mobileLibrary.macPublicKey();
          return key ? sendJson(response, 200, key) : sendJson(response, 503, { error: 'Mac 尚未注册加密公钥' });
        }
        if (request.method === 'POST' && pathname === '/api/mobile/v1/commands') {
          const command = await mobileLibrary.enqueueCommand(await readJsonBody(request, 48 * 1024));
          return sendJson(response, 202, command);
        }
        const commandMatch = /^\/api\/mobile\/v1\/commands\/([a-f0-9-]{36})$/.exec(pathname);
        if (request.method === 'GET' && commandMatch) {
          const command = (await mobileLibrary.commands()).find((item) => item.id === commandMatch[1]);
          return command ? sendJson(response, 200, { id: command.id, action: command.action, status: command.status,
            result: command.result || null, createdAt: command.createdAt, finishedAt: command.finishedAt || null })
            : sendJson(response, 404, { error: '命令不存在' });
        }
        if (request.method === 'PUT' && pathname.startsWith('/api/mac/mobile/media/')) {
          const result = await mobileLibrary.saveMedia(pathname.slice('/api/mac/mobile/media/'.length), await readBinaryBody(request));
          return sendJson(response, 201, result);
        }
        if (request.method === 'PUT' && pathname.startsWith('/api/mac/mobile/publications/')) {
          const sourceId = pathname.slice('/api/mac/mobile/publications/'.length);
          const body = await readJsonBody(request, 2 * 1024 * 1024);
          if (body.sourceId !== sourceId) return sendJson(response, 400, { error: '来源 ID 不一致' });
          return sendJson(response, 200, await mobileLibrary.savePublication(body));
        }
        if (request.method === 'POST' && pathname.startsWith('/api/mac/mobile/progress/')) {
          const eventId = pathname.slice('/api/mac/mobile/progress/'.length);
          return sendJson(response, 200, await mobileLibrary.saveProgress(eventId, await readJsonBody(request, 8 * 1024)));
        }
        if (request.method === 'PUT' && pathname === '/api/mac/mobile/providers') {
          return sendJson(response, 200, await mobileLibrary.saveProviderView(await readJsonBody(request, 32 * 1024)));
        }
        if (request.method === 'PUT' && pathname === '/api/mac/mobile/public-key') {
          const body = await readJsonBody(request, 4 * 1024);
          await mobileLibrary.saveMacPublicKey(body.publicKey);
          return sendJson(response, 200, { ok: true });
        }
        if (request.method === 'POST' && pathname === '/api/mac/mobile/commands/next') {
          const command = await mobileLibrary.takeNextCommand();
          return command ? sendJson(response, 200, { command }) : (response.writeHead(204), response.end());
        }
        const finishMatch = /^\/api\/mac\/mobile\/commands\/([a-f0-9-]{36})\/result$/.exec(pathname);
        if (request.method === 'POST' && finishMatch) {
          return sendJson(response, 200, await mobileLibrary.finishCommand(finishMatch[1], await readJsonBody(request, 4 * 1024)));
        }
        return sendJson(response, 404, { error: '未找到手机接口' });
      } catch (error) {
        return sendJson(response, 400, { error: error?.message || '手机接口请求无效' });
      }
    }

    // LAN mode is a narrow intake receiver, not a way to publish this user's library or media.
    // The full UI and media remain available only through the default localhost server.
    const isLanReceiverRoute =
      (request.method === 'POST' && pathname === '/api/intake') ||
      (request.method === 'GET' && pathname === '/api/intake/jobs') ||
      (request.method === 'GET' && pathname === '/api/mac/events') ||
      (request.method === 'POST' && (pathname === '/api/mac/next' || pathname === '/api/mac/results'));
    if (lanMode && !isLanReceiverRoute) return sendJson(response, 404, { error: '局域网接收服务不提供此路径' });

    if (request.method === 'POST' && pathname === '/api/intake') {
      if (!isAuthorised(request)) return sendJson(response, 401, { error: '接收密钥无效' });
      const body = await readJsonBody(request);
      const eventId = String(body.event_id ?? '');
      const sourceUrl = String(body.source_url ?? '');
      const trigger = String(body.trigger ?? 'unknown').slice(0, 80);
      const savedAt = Number(body.saved_at);
      if (!/^[A-Za-z0-9._-]{6,128}$/.test(eventId)) return sendJson(response, 400, { error: '无效收藏事件 ID' });
      if (!isDouyinUrl(sourceUrl)) return sendJson(response, 400, { error: '只接收有效的抖音链接' });
      if (!Number.isSafeInteger(savedAt) || savedAt < 0) return sendJson(response, 400, { error: '无效收藏时间' });
      const queued = intakeStore.enqueue({ eventId, sourceUrl, trigger, savedAt });
      if (queued.created) notifyMacWorkers();
      return sendJson(response, queued.created ? 202 : 200, {
        event_id: queued.job.eventId,
        status: queued.job.status,
        accepted: true,
        duplicate_request: !queued.created
      });
    }
    if (request.method === 'GET' && pathname === '/api/intake/jobs') {
      if (!isAuthorised(request)) return sendJson(response, 401, { error: '接收密钥无效' });
      return sendJson(response, 200, { jobs: intakeStore.list() });
    }
    if (request.method === 'GET' && pathname === '/api/mac/events') {
      if (!isAuthorised(request)) return sendJson(response, 401, { error: '接收密钥无效' });
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      response.flushHeaders();
      macEventClients.add(response);
      sendSse(response, 'ready', { available: true });
      response.on('close', () => macEventClients.delete(response));
      response.on('error', () => macEventClients.delete(response));
      return;
    }
    if (request.method === 'POST' && pathname === '/api/mac/next') {
      if (!isAuthorised(request)) return sendJson(response, 401, { error: '接收密钥无效' });
      const hasBody = Number(request.headers['content-length'] || 0) > 0 || Boolean(request.headers['transfer-encoding']);
      const body = hasBody ? await readJsonBody(request) : {};
      const excluded = Array.isArray(body.exclude_event_ids) ? body.exclude_event_ids : [];
      const job = intakeStore.takeNextForMac({ excludeEventIds: excluded });
      if (!job) {
        response.writeHead(204);
        response.end();
        return;
      }
      return sendJson(response, 200, { job });
    }
    if (request.method === 'POST' && pathname === '/api/mac/results') {
      if (!isAuthorised(request)) return sendJson(response, 401, { error: '接收密钥无效' });
      const body = await readJsonBody(request, 256 * 1024);
      const eventId = String(body.event_id ?? '');
      const result = body.result;
      if (!/^[A-Za-z0-9._-]{6,128}$/.test(eventId)) return sendJson(response, 400, { error: '无效收藏事件 ID' });
      if (!result || typeof result !== 'object' || Array.isArray(result)) return sendJson(response, 400, { error: '缺少 Mac 解析结果' });
      if (!['captured', 'partial', 'failed'].includes(result.status)) return sendJson(response, 400, { error: '无效的 Mac 解析状态' });
      const job = intakeStore.saveMacResult(eventId, result);
      if (!job) return sendJson(response, 409, { error: '任务不存在或不处于 Mac 处理中' });
      return sendJson(response, 200, { event_id: job.eventId, status: job.status, accepted: true });
    }
    if (request.method === 'POST' && pathname === '/api/intake/retry') {
      if (!isAuthorised(request)) return sendJson(response, 401, { error: '接收密钥无效' });
      const body = await readJsonBody(request);
      const eventId = String(body.event_id ?? '');
      if (!/^[A-Za-z0-9._-]{6,128}$/.test(eventId)) return sendJson(response, 400, { error: '无效收藏事件 ID' });
      const job = intakeStore.requeue(eventId, { reason: 'manual' });
      if (!job) return sendJson(response, intakeStore.get(eventId) ? 409 : 404, { error: '收藏任务不存在或当前不需要重试' });
      notifyMacWorkers();
      return sendJson(response, 202, {
        event_id: job.eventId,
        status: job.status,
        accepted: true
      });
    }
    if (request.method === 'POST' && pathname === '/api/intake/dismiss') {
      if (!isAuthorised(request)) return sendJson(response, 401, { error: '接收密钥无效' });
      const body = await readJsonBody(request);
      const eventId = String(body.event_id ?? '');
      if (!/^[A-Za-z0-9._-]{6,128}$/.test(eventId)) return sendJson(response, 400, { error: '无效收藏事件 ID' });
      const job = intakeStore.dismiss(eventId);
      if (!job) return sendJson(response, 404, { error: '未找到该收藏任务' });
      return sendJson(response, 200, { event_id: job.eventId, status: job.status, accepted: true });
    }
    if (request.method === 'POST' && pathname === '/api/intake/complete') {
      if (!isAuthorised(request)) return sendJson(response, 401, { error: '接收密钥无效' });
      const body = await readJsonBody(request);
      const eventId = String(body.event_id ?? '');
      if (!validEventId(eventId)) return sendJson(response, 400, { error: '无效收藏事件 ID' });
      const job = intakeStore.markPublished(eventId);
      if (!job) return sendJson(response, 404, { error: '任务不存在或已删除' });
      return sendJson(response, 200, { event_id: job.eventId, status: job.status, accepted: true });
    }
    if (request.method === 'POST' && pathname === '/api/intake/manage') {
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return sendJson(response, 403, { error: '只允许在本机管理收藏' });
      if (request.headers.origin && request.headers.origin !== requestUrl.origin) return sendJson(response, 403, { error: '不允许跨站操作收藏' });
      const body = await readJsonBody(request);
      const action = String(body.action ?? '');
      const eventId = String(body.event_id ?? '');
      if (!validEventId(eventId) || !['retry', 'dismiss'].includes(action)) return sendJson(response, 400, { error: '收藏操作无效' });
      try {
        const config = await readCloudStatusConfig(projectDirectory);
        if (action === 'retry') {
          const jobs = await fetchCloudJobs(config);
          const job = jobs.find((item) => item.eventId === eventId);
          if (!job) return sendJson(response, 404, { error: '未找到该收藏任务' });
          const statuses = await loadCardProcessingStatuses(projectDirectory);
          const plan = await resolveRetryStage({ projectDirectory, job, localStatus: statuses.get(eventId) });
          if (plan.kind === 'unavailable') return sendJson(response, 409, { error: plan.reason });
          if (plan.kind === 'completed') {
            await manageCloudJob(config, 'complete', eventId);
            await writeCardProcessingStatus(projectDirectory, eventId, { status: 'completed', stage: 'published', message: '卡片已生成，无需重新解析。' });
            cachedCloudJobs = cachedCloudJobs.map((item) => item.eventId === eventId ? { ...item, status: 'published', updatedAt: new Date().toISOString() } : item);
            return sendJson(response, 200, { event_id: eventId, status: 'completed', resumed_from: 'published', message: plan.label });
          }
          if (plan.kind === 'card' || plan.kind === 'evidence') {
            const queued = await enqueueLocalRetry(projectDirectory, eventId, plan);
            await writeCardProcessingStatus(projectDirectory, eventId, {
              status: 'processing', stage: plan.kind === 'card' ? 'retry_card' : 'retry_evidence', message: `${plan.label}，等待本机处理器接手。`
            });
            return sendJson(response, 202, { event_id: eventId, status: queued.status, resumed_from: plan.kind, message: plan.label });
          }
        }
        const result = await manageCloudJob(config, action, eventId);
        cachedCloudJobs = cachedCloudJobs.map((job) => job.eventId === eventId
          ? { ...job, status: result.status, updatedAt: new Date().toISOString() }
          : job);
        void refreshCloudJobs();
        return sendJson(response, 200, { ...result, resumed_from: action === 'retry' ? 'capture' : undefined, message: action === 'retry' ? '抓取阶段失败，已安排重新抓取。' : undefined });
      } catch (error) {
        const known = error instanceof CloudStatusError;
        return sendJson(response, known ? error.statusCode : 500, { error: known ? error.message : '收藏操作失败' });
      }
    }
    if (request.method === 'GET' && pathname === '/api/cloud-status') {
      try {
        const config = await readCloudStatusConfig(projectDirectory);
        const jobs = await fetchCloudJobs(config);
        return sendJson(response, 200, {
          connected: true,
          baseUrl: config.baseUrl,
          checkedAt: new Date().toISOString(),
          summary: summarizeCloudJobs(jobs),
          jobs
        });
      } catch (error) {
        const known = error instanceof CloudStatusError;
        return sendJson(response, known ? error.statusCode : 500, {
          connected: false,
          code: known ? error.code : 'INTERNAL_ERROR',
          error: known ? error.message : '本地状态服务读取失败'
        });
      }
    }
    if (pathname.startsWith('/api/providers')) {
      if (!isLocalRequest(request)) return sendJson(response, 403, { error: '供应商设置仅限本机访问' });
      try {
        if (request.method === 'GET' && pathname === '/api/providers') {
          return sendJson(response, 200, await listPublicProviders(projectDirectory));
        }
        if (request.method === 'POST' && pathname === '/api/providers') {
          const body = await readJsonBody(request, 32 * 1024);
          const provider = await saveProvider(projectDirectory, body);
          const publicView = await listPublicProviders(projectDirectory);
          return sendJson(response, 200, { provider: publicView.providers.find((item) => item.id === provider.id) });
        }
        if (request.method === 'POST' && pathname === '/api/providers/activate') {
          const body = await readJsonBody(request);
          return sendJson(response, 200, { activeProviderId: await activateProvider(projectDirectory, String(body.id || '')) });
        }
        if (request.method === 'POST' && pathname === '/api/providers/test') {
          const body = await readJsonBody(request, 32 * 1024);
          const saved = body.id ? (await loadProviderSettings(projectDirectory)).providers.find((item) => item.id === body.id) : null;
          return sendJson(response, 200, await testProviderConnection({ ...saved, ...body, apiKey: body.apiKey || saved?.apiKey }));
        }
        if (request.method === 'DELETE' && pathname.startsWith('/api/providers/')) {
          await removeProvider(projectDirectory, decodeURIComponent(pathname.slice('/api/providers/'.length)));
          return sendJson(response, 200, { ok: true });
        }
        return sendJson(response, 404, { error: '未找到供应商接口' });
      } catch (error) {
        return sendJson(response, 400, { error: error?.message || '供应商操作失败' });
      }
    }
    if (request.method === 'GET' && pathname === '/api/health') {
      const library = await buildLibrary();
      sendJson(response, 200, { ok: true, cards: library.cards.length, topics: library.topics.length });
      return;
    }
    if (request.method === 'GET' && pathname === '/api/library') {
      if (requestUrl.searchParams.has('waitCloud') && cloudJobsRefresh) await cloudJobsRefresh;
      sendJson(response, 200, await buildLibrary());
      return;
    }
    if (request.method === 'GET' && pathname === '/api/cards') {
      const library = await buildLibrary();
      sendJson(response, 200, { cards: filterCards(library, requestUrl.searchParams) });
      return;
    }
    if (request.method === 'GET' && pathname.startsWith('/api/cards/')) {
      const library = await buildLibrary();
      const cardId = decodeURIComponent(pathname.slice('/api/cards/'.length));
      const card = library.cards.find((item) => item.id === cardId);
      if (!card) return sendJson(response, 404, { error: '未找到该卡片' });
      return sendJson(response, 200, { card });
    }
    if (request.method === 'GET' && pathname.startsWith('/api/topics/')) {
      const library = await buildLibrary();
      const topicId = decodeURIComponent(pathname.slice('/api/topics/'.length));
      const topic = library.topics.find((item) => item.id === topicId);
      if (!topic) return sendJson(response, 404, { error: '未找到该 Topic' });
      return sendJson(response, 200, {
        topic,
        cards: library.cards.filter((card) => card.topics.some((item) => item.id === topicId))
      });
    }
    if (request.method === 'GET' && pathname.startsWith('/media/')) {
      const target = safePath(captureDirectory, pathname.slice('/media'.length));
      if (!target) return sendJson(response, 400, { error: '无效媒体路径' });
      return sendFile(request, response, target);
    }
    if (request.method === 'GET' && pathname.startsWith('/published-media/')) {
      const match = /^\/published-media\/([A-Za-z0-9._-]{1,128})\/([A-Za-z0-9._-]{1,128})$/.exec(pathname);
      if (!match) return sendJson(response, 404, { error: '图片不存在' });
      const target = await resolvePublishedImage(projectDirectory, match[1], match[2]);
      if (!target) return sendJson(response, 404, { error: '图片不存在' });
      return sendFile(request, response, target);
    }
    if (request.method === 'GET' && pathname.startsWith('/web-media/')) {
      const media = await mobileLibrary.mediaPath(pathname.slice('/web-media/'.length));
      return media ? sendFile(request, response, media.path) : sendJson(response, 404, { error: '图片不存在' });
    }
    if (request.method === 'GET' && pathname.startsWith('/live-media/')) {
      const target = safePath(liveCaptureDirectory, pathname.slice('/live-media'.length));
      if (!target) return sendJson(response, 400, { error: '无效媒体路径' });
      return sendFile(request, response, target);
    }
    if (request.method === 'GET' && ['/topic', '/topic/', '/interaction', '/interaction/'].includes(pathname)) {
      return sendFile(request, response, path.join(publicDirectory, 'index.html'));
    }
    if (request.method === 'GET' && (pathname === '/providers' || pathname === '/providers/')) {
      if (!isLocalRequest(request)) return sendJson(response, 403, { error: '供应商设置仅限本机访问' });
      return sendFile(request, response, path.join(publicDirectory, 'providers.html'));
    }
    if (request.method === 'GET') {
      const localPath = pathname === '/' ? '/index.html' : pathname;
      const target = safePath(publicDirectory, localPath);
      if (target) return sendFile(request, response, target);
    }
    sendJson(response, 404, { error: '未找到接口或页面' });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: '本地服务读取数据失败' });
  }
});

server.listen(port, bindHost, () => {
  console.log(`拾即用已启动：http://${bindHost}:${port}`);
  if (lanMode) {
    console.log('手机接收已启用；凭据不会输出到日志。');
    console.log('该端口只提供带密钥的接收与队列查询；卡片库、原视频和媒体仍只在 localhost 服务提供。');
    console.log('仅向同一可信 Wi‑Fi 中的拾即用手机端填写此密钥，不要发送到聊天、截图或公开页面。');
  }
});
