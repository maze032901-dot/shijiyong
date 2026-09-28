import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_ID = /^[A-Za-z0-9_-]{6,64}$/;
const MEDIA_ID = /^[a-f0-9]{64}\.(?:jpg|jpeg|png|webp)$/;
const MEDIA_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function validSourceId(value) { return SOURCE_ID.test(String(value ?? '')); }
function validMediaId(value) { return MEDIA_ID.test(String(value ?? '')); }
function cleanString(value, maximum = 20_000) { return typeof value === 'string' ? value.slice(0, maximum) : ''; }
function mediaUrl(value) {
  const match = /^\/api\/mobile\/v1\/media\/([a-f0-9]{64}\.(?:jpg|jpeg|png|webp))$/.exec(String(value ?? ''));
  return match ? `/api/mobile/v1/media/${match[1]}` : null;
}
function safeMedia(media) {
  if (!media || typeof media !== 'object') return null;
  const imageUrls = [...new Set((Array.isArray(media.imageUrls) ? media.imageUrls : []).map(mediaUrl).filter(Boolean))].slice(0, 40);
  const coverUrl = mediaUrl(media.coverUrl);
  if (coverUrl && !imageUrls.includes(coverUrl)) imageUrls.unshift(coverUrl);
  return imageUrls.length ? { coverUrl: coverUrl || imageUrls[0], imageUrls } : null;
}
function safeCard(input, sourceId) {
  if (!input || typeof input !== 'object' || !/^[A-Za-z0-9._-]{3,128}$/.test(String(input.id ?? ''))) throw new Error('卡片 ID 无效');
  const source = input.sources?.[0] || {};
  const topics = Array.isArray(input.topics) ? input.topics.slice(0, 8).map((item) => ({ id: cleanString(item.id, 80), title: cleanString(item.title, 100) })) : [];
  return {
    id: input.id,
    sourceId,
    type: cleanString(input.type, 50),
    title: cleanString(input.title, 240),
    status: cleanString(input.status, 50),
    topics,
    content: (Array.isArray(input.content) ? input.content : []).slice(0, 80).map((item) => ({
      label: cleanString(item.label, 120), value: cleanString(item.value, 30_000), kind: cleanString(item.kind, 40)
    })),
    paths: (Array.isArray(input.paths) ? input.paths : []).slice(0, 30).map((item) => ({
      title: cleanString(item.title, 180), status: cleanString(item.status, 40),
      steps: (Array.isArray(item.steps) ? item.steps : []).slice(0, 100).map((step) => cleanString(step, 2_000))
    })),
    resources: (Array.isArray(input.resources) ? input.resources : []).slice(0, 30).map((item) => ({
      label: cleanString(item.label, 120), type: cleanString(item.type, 40),
      url: /^https?:\/\//.test(String(item.url ?? '')) ? cleanString(item.url, 2_000) : null,
      availability: cleanString(item.availability, 40), note: cleanString(item.note, 1_000)
    })),
    actions: (Array.isArray(input.actions) ? input.actions : []).slice(0, 30).map((item) => ({
      label: cleanString(item.label, 120), text: cleanString(item.text, 30_000),
      url: /^https?:\/\//.test(String(item.url ?? '')) ? cleanString(item.url, 2_000) : null
    })),
    relatedCardIds: (Array.isArray(input.relatedCardIds) ? input.relatedCardIds : []).slice(0, 30).map((id) => cleanString(id, 128)),
    media: safeMedia(input.media),
    sources: [{
      id: cleanString(source.id, 128), title: cleanString(source.title, 240), author: cleanString(source.author, 120),
      kind: cleanString(source.kind, 40), originalUrl: /^https?:\/\//.test(String(source.originalUrl ?? '')) ? cleanString(source.originalUrl, 2_000) : null,
      savedAt: cleanString(source.savedAt, 50)
    }]
  };
}

async function atomicJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

export function openMobileLibraryStore(directory) {
  const publications = path.join(directory, 'publications');
  const mediaDirectory = path.join(directory, 'media');
  const progressDirectory = path.join(directory, 'progress');
  const commandDirectory = path.join(directory, 'commands');

  return {
    async saveMedia(mediaId, bytes) {
      if (!validMediaId(mediaId)) throw new Error('媒体 ID 无效');
      if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 5 * 1024 * 1024) throw new Error('媒体大小无效');
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== mediaId.slice(0, 64)) throw new Error('媒体校验不一致');
      await mkdir(mediaDirectory, { recursive: true });
      await writeFile(path.join(mediaDirectory, mediaId), bytes, { flag: 'wx', mode: 0o600 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      return { id: mediaId, bytes: bytes.length };
    },
    async mediaPath(mediaId) {
      if (!validMediaId(mediaId)) return null;
      const target = path.join(mediaDirectory, mediaId);
      try { await stat(target); return { path: target, type: MEDIA_TYPES[mediaId.split('.').at(-1)] }; }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async savePublication(input) {
      const sourceId = String(input?.sourceId ?? '');
      if (!validSourceId(sourceId)) throw new Error('来源 ID 无效');
      if (!Array.isArray(input.cards) || input.cards.length < 1 || input.cards.length > 100) throw new Error('卡片数量无效');
      const cards = input.cards.map((card) => safeCard(card, sourceId));
      if (new Set(cards.map((card) => card.id)).size !== cards.length) throw new Error('卡片 ID 重复');
      for (const card of cards) {
        for (const url of card.media?.imageUrls || []) {
          if (!await this.mediaPath(url.split('/').at(-1))) throw new Error('卡片引用的图片尚未上传');
        }
      }
      const publication = { schema: 'hermes/mobile-publication/v1', sourceId, publishedAt: cleanString(input.publishedAt, 50) || new Date().toISOString(), cards };
      await atomicJson(path.join(publications, `${sourceId}.json`), publication);
      return { sourceId, cardCount: cards.length };
    },
    async library() {
      let entries;
      try { entries = (await readdir(publications)).filter((name) => /^[A-Za-z0-9_-]{6,64}\.json$/.test(name)).sort(); }
      catch (error) { if (error.code === 'ENOENT') entries = []; else throw error; }
      const bundles = [];
      for (const name of entries) {
        try { bundles.push(JSON.parse(await readFile(path.join(publications, name), 'utf8'))); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const cards = bundles.flatMap((bundle) => bundle.cards).sort((a, b) => (b.sources?.[0]?.savedAt || '').localeCompare(a.sources?.[0]?.savedAt || ''));
      const topicMap = new Map();
      for (const card of cards) for (const topic of card.topics || []) {
        const current = topicMap.get(topic.id) || { ...topic, totalCount: 0 };
        current.totalCount += 1;
        topicMap.set(topic.id, current);
      }
      const revision = createHash('sha256').update(JSON.stringify(bundles)).digest('hex');
      return { schema: 'hermes/mobile-library/v1', revision, topics: [...topicMap.values()], cards };
    },
    async saveProgress(eventId, input) {
      if (!/^[A-Za-z0-9._-]{6,128}$/.test(String(eventId))) throw new Error('事件 ID 无效');
      const progress = {
        eventId, status: cleanString(input?.status, 40), stage: cleanString(input?.stage, 80),
        message: cleanString(input?.message, 500), progressStep: Number.isInteger(input?.progressStep) ? Math.max(0, Math.min(3, input.progressStep)) : null,
        updatedAt: new Date().toISOString()
      };
      await atomicJson(path.join(progressDirectory, `${eventId}.json`), progress);
      return progress;
    },
    async progress() {
      let entries;
      try { entries = (await readdir(progressDirectory)).filter((name) => /^[A-Za-z0-9._-]{6,128}\.json$/.test(name)); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      return Promise.all(entries.map(async (name) => JSON.parse(await readFile(path.join(progressDirectory, name), 'utf8'))));
    },
    async enqueueCommand(input) {
      const action = String(input?.action ?? '');
      if (!['retry', 'dismiss', 'provider_save', 'provider_activate', 'provider_delete', 'provider_test'].includes(action)) throw new Error('操作不支持');
      const eventId = String(input?.eventId ?? '');
      if (['retry', 'dismiss'].includes(action) && !/^[A-Za-z0-9._-]{6,128}$/.test(eventId)) throw new Error('事件 ID 无效');
      const payload = input?.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
      const serialized = JSON.stringify(payload);
      if (serialized.length > 40_000 || /"(?:apiKey|api_key|secret|token)"\s*:/.test(serialized)) throw new Error('命令包含不允许上传的明文凭据');
      if (action.startsWith('provider_')) {
        if (Object.keys(payload).sort().join(',') !== 'ciphertext,encryptedKey,iv'
          || [payload.ciphertext, payload.encryptedKey, payload.iv].some((value) => typeof value !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(value))) {
          throw new Error('供应商命令必须端到端加密');
        }
      }
      const command = { id: randomUUID(), action, eventId: eventId || null, payload, status: 'queued', createdAt: new Date().toISOString() };
      await atomicJson(path.join(commandDirectory, `${command.id}.json`), command);
      return { id: command.id, action, status: command.status };
    },
    async commands() {
      let entries;
      try { entries = (await readdir(commandDirectory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const commands = await Promise.all(entries.map(async (name) => JSON.parse(await readFile(path.join(commandDirectory, name), 'utf8'))));
      return commands.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async takeNextCommand() {
      const command = (await this.commands()).find((item) => item.status === 'queued'
        || (item.status === 'processing' && Date.now() - Date.parse(item.claimedAt || item.createdAt) > 5 * 60_000));
      if (!command) return null;
      const claimed = { ...command, status: 'processing', claimedAt: new Date().toISOString() };
      await atomicJson(path.join(commandDirectory, `${command.id}.json`), claimed);
      return claimed;
    },
    async finishCommand(id, input) {
      if (!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error('命令 ID 无效');
      const target = path.join(commandDirectory, `${id}.json`);
      const command = JSON.parse(await readFile(target, 'utf8'));
      if (command.status !== 'processing') throw new Error('命令状态无效');
      const finished = { ...command, payload: undefined, status: input?.ok ? 'completed' : 'failed',
        result: cleanString(input?.result, 500), finishedAt: new Date().toISOString() };
      await atomicJson(target, finished);
      return { id, status: finished.status, result: finished.result };
    },
    async saveProviderView(input) {
      const view = { activeProviderId: cleanString(input?.activeProviderId, 100),
        providers: (Array.isArray(input?.providers) ? input.providers : []).slice(0, 30).map((item) => ({
          id: cleanString(item.id, 100), name: cleanString(item.name, 120), endpoint: cleanString(item.endpoint, 2000),
          model: cleanString(item.model, 120), keyConfigured: Boolean(item.keyConfigured),
          maxOutputTokens: Number(item.maxOutputTokens) || null, contextWindowTokens: Number(item.contextWindowTokens) || null
        })) };
      await atomicJson(path.join(directory, 'providers.json'), view);
      return view;
    },
    async providerView() {
      try { return JSON.parse(await readFile(path.join(directory, 'providers.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return { activeProviderId: null, providers: [] }; throw error; }
    },
    async saveMacPublicKey(publicKey) {
      if (typeof publicKey !== 'string' || !publicKey.includes('BEGIN PUBLIC KEY') || publicKey.length > 2_000) throw new Error('公钥无效');
      await atomicJson(path.join(directory, 'mac-public-key.json'), { publicKey, updatedAt: new Date().toISOString() });
    },
    async macPublicKey() {
      try { return JSON.parse(await readFile(path.join(directory, 'mac-public-key.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
  };
}
