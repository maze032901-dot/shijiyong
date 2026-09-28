import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizePublishedBundle } from './published-card-library.mjs';
import { CURRENT_GENERATION_RULES, configureTopicCatalog, themeForId, themeIdForCard } from './public/topic-presentation.js';

const SOURCE_ID = /^[A-Za-z0-9_-]{6,64}$/;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function inside(root, candidate) {
  const resolved = path.resolve(candidate);
  return resolved.startsWith(path.resolve(root) + path.sep) ? resolved : null;
}

async function evidenceImage(projectDirectory, publication, sourceId, assetId) {
  const evidencePath = inside(path.join(projectDirectory, 'runtime'), path.resolve(projectDirectory, publication.evidence_path || ''));
  if (!evidencePath || !/^[A-Za-z0-9._-]+$/.test(assetId)) return null;
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  if (String(evidence.source?.id) !== sourceId) return null;
  const asset = evidence.items?.find((item) => item.id === assetId);
  const localPath = asset?.locator?.local_path;
  if (typeof localPath !== 'string' || !localPath) return null;
  const eventDirectory = path.dirname(evidencePath);
  const target = inside(eventDirectory, path.resolve(eventDirectory, localPath));
  if (!target || !IMAGE_EXTENSIONS.has(path.extname(target).toLowerCase())) return null;
  try { return (await stat(target)).isFile() ? target : null; } catch { return null; }
}

async function imagePath(projectDirectory, publication, sourceId, url) {
  const review = new RegExp(`^/published-media/${sourceId}/([A-Za-z0-9._-]+)$`).exec(url);
  if (review) return evidenceImage(projectDirectory, publication, sourceId, review[1]);
  const intake = new RegExp(`^/local-intake-media/${sourceId}/([A-Za-z0-9._-]+\\.(?:jpg|jpeg|png|webp))$`).exec(url);
  if (intake) {
    const target = path.join(projectDirectory, 'app', 'public', 'local-intake-media', sourceId, intake[1]);
    try { return (await stat(target)).isFile() ? target : null; } catch { return null; }
  }
  return null;
}

function publishConfig(env = process.env) {
  const baseUrl = String(env.HERMES_CLOUD_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.HERMES_MOBILE_PUBLISH_TOKEN || '').trim();
  if (!/^https:\/\//.test(baseUrl) || token.length < 24) return null;
  return { baseUrl, token };
}

async function request(config, pathname, options = {}, fetchImpl = fetch, timeoutMs = 20_000) {
  const response = await fetchImpl(`${config.baseUrl}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${config.token}`, ...(options.headers || {}) },
    redirect: 'error', signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`手机卡库同步失败（HTTP ${response.status}）`);
  return response;
}

export async function syncMobilePublication({ projectDirectory, sourceId, config = publishConfig(), fetchImpl = fetch }) {
  if (!config) return { kind: 'not_configured' };
  if (!SOURCE_ID.test(String(sourceId))) throw new Error('来源 ID 无效');
  const publication = JSON.parse(await readFile(path.join(projectDirectory, 'runtime', 'card-library', 'published', `${sourceId}.json`), 'utf8'));
  const normalized = normalizePublishedBundle(publication);
  if (!normalized.cards.length) throw new Error('正式发布包没有卡片');
  const topicCatalog = JSON.parse(await readFile(path.join(projectDirectory, 'app', 'public', 'topic-catalog.json'), 'utf8'));
  configureTopicCatalog(topicCatalog);
  const imageMap = new Map();
  const missingImages = [];
  const attemptedImages = new Set();
  for (const card of normalized.cards) for (const url of [card.media?.coverUrl, ...(card.media?.imageUrls || [])].filter(Boolean)) {
    if (attemptedImages.has(url)) continue;
    attemptedImages.add(url);
    const file = await imagePath(projectDirectory, publication, sourceId, url);
    if (!file) { missingImages.push(url); continue; }
    const bytes = await readFile(file);
    if (bytes.length < 1 || bytes.length > 5 * 1024 * 1024) throw new Error('正式卡片图片大小超出限制');
    const mediaId = `${createHash('sha256').update(bytes).digest('hex')}${path.extname(file).toLowerCase()}`;
    imageMap.set(url, { mediaId, bytes });
  }
  for (const { mediaId, bytes } of imageMap.values()) {
    // Media travels through the public tunnel and can take much longer than a JSON update.
    await request(config, `/api/mac/mobile/media/${mediaId}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }, fetchImpl, 120_000);
  }
  const cards = normalized.cards.map((card) => {
    const toMobileUrl = (url) => imageMap.has(url) ? `/api/mobile/v1/media/${imageMap.get(url).mediaId}` : null;
    const imageUrls = [...new Set([card.media?.coverUrl, ...(card.media?.imageUrls || [])].map(toMobileUrl).filter(Boolean))];
    const coverUrl = toMobileUrl(card.media?.coverUrl) || imageUrls[0] || null;
    const topicId = themeIdForCard(card);
    const topic = topicId ? themeForId(topicId, normalized.cards) : null;
    return {
      id: card.id, sourceId, type: card.type, title: card.title, status: card.status,
      topics: topic ? [{ id: topic.id, title: topic.title }] : card.topics.slice(0, 1),
      content: card.content, paths: card.paths, resources: card.resources, actions: card.actions,
      relatedCardIds: card.relatedCardIds, sources: card.sources,
      media: imageUrls.length ? { coverUrl, imageUrls } : null
    };
  });
  const body = JSON.stringify({ sourceId, publishedAt: publication.published_at, cards });
  await request(config, `/api/mac/mobile/publications/${sourceId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }, fetchImpl);
  return { kind: 'synced', sourceId, cards: cards.length, images: imageMap.size, missingImages };
}

export async function currentMobilePublicationIds(projectDirectory) {
  const directory = path.join(projectDirectory, 'runtime', 'card-library', 'published');
  let entries;
  try { entries = (await readdir(directory)).filter((name) => /^[A-Za-z0-9_-]{6,64}\.json$/.test(name)).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const selected = [];
  for (const name of entries) {
    const item = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    if (item.generation_rules_version === CURRENT_GENERATION_RULES || String(item.generation_rules_version || '').startsWith('human-reviewed/')) selected.push(name.slice(0, -5));
  }
  return selected;
}

export async function syncAllMobilePublications({ projectDirectory, config = publishConfig(), fetchImpl = fetch, onResult = () => {} }) {
  if (!config) return { kind: 'not_configured', results: [] };
  const sourceIds = await currentMobilePublicationIds(projectDirectory);
  const results = [];
  for (const sourceId of sourceIds) {
    try { results.push(await syncMobilePublication({ projectDirectory, sourceId, config, fetchImpl })); }
    catch (error) { results.push({ kind: 'failed', sourceId, error: String(error?.message || error).slice(0, 240) }); }
    onResult(results.at(-1));
  }
  return { kind: 'complete', results };
}

export async function syncMobileProgress({ eventId, update, config = publishConfig(), fetchImpl = fetch }) {
  if (!config) return { kind: 'not_configured' };
  await request(config, `/api/mac/mobile/progress/${encodeURIComponent(eventId)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: update.status, stage: update.stage, message: update.message, progressStep: update.progressStep })
  }, fetchImpl);
  return { kind: 'synced' };
}

export { publishConfig };
