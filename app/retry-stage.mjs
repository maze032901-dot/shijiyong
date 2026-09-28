import { access, open, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateEvidenceDocument } from '../runner/lib/evidence-contract.mjs';
import { validateLocalEvidenceLocators } from './mac-gallery-evidence.mjs';

const validEventId = (value) => /^[A-Za-z0-9._-]{6,128}$/.test(String(value ?? ''));
const evidenceRetryStages = new Map([
  ['video_download', '重新下载视频'],
  ['audio_mux', '重新合成视频和音轨'],
  ['audio_extract', '重新提取音频'],
  ['asr', '重新转写语音'],
  ['video_ocr', '重新识别视频画面文字'],
  ['image_download', '重新下载图片'],
  ['ocr', '重新识别图片文字'],
  ['evidence_validation', '重新校验证据']
]);

async function json(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return null; }
}

async function candidateDirectories(projectDirectory, eventId) {
  if (!validEventId(eventId)) throw new Error('无效收藏事件 ID');
  const root = path.join(projectDirectory, 'runtime');
  const candidates = [path.join(root, 'mac-intake', eventId)];
  const retries = path.join(root, 'mac-intake-retries', eventId);
  try {
    const entries = await readdir(retries, { withFileTypes: true });
    for (const entry of entries) if (entry.isDirectory() && /^[0-9TZ.-]+$/.test(entry.name)) candidates.push(path.join(retries, entry.name));
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const existing = [];
  for (const directory of candidates) {
    try { existing.push({ directory, modified: (await stat(directory)).mtimeMs }); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return existing.sort((a, b) => b.modified - a.modified).map((item) => item.directory);
}

async function validEvidence(directory) {
  const evidence = await json(path.join(directory, 'evidence.json'));
  const validation = await json(path.join(directory, 'validation.json'));
  if (!evidence || validation?.status !== 'passed') return null;
  if (validateEvidenceDocument(evidence).status !== 'passed') return null;
  if ((await validateLocalEvidenceLocators(evidence, directory)).status !== 'passed') return null;
  return evidence;
}

export async function validateRetryEvidence(directory) { return validEvidence(directory); }

async function alreadyPublished(projectDirectory, evidence) {
  const sourceId = String(evidence.source?.id ?? '');
  if (!/^\d{10,25}$/.test(sourceId)) return false;
  const publication = await json(path.join(projectDirectory, 'runtime', 'card-library', 'published', `${sourceId}.json`));
  if (!publication?.evidence_path || publication.source_id !== sourceId || !publication.fixture?.cards?.length) return false;
  const publishedEvidencePath = path.resolve(projectDirectory, publication.evidence_path);
  const root = path.resolve(projectDirectory, 'runtime', 'fresh-candidates') + path.sep;
  if (!publishedEvidencePath.startsWith(root)) return false;
  const publishedEvidence = await json(publishedEvidencePath);
  return publishedEvidence && JSON.stringify(publishedEvidence) === JSON.stringify(evidence);
}

async function matchingCandidateRun(projectDirectory, evidence) {
  const sourceId = String(evidence.source?.id ?? '');
  if (!/^\d{10,25}$/.test(sourceId)) return null;
  const root = path.join(projectDirectory, 'runtime', 'fresh-candidates', sourceId);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const directory = path.join(root, entry.name);
    const outcome = await json(path.join(directory, 'outcome.json'));
    if (!['accepted_by_gates', 'accepted_with_warnings'].includes(outcome?.status)) continue;
    const candidateEvidence = await json(path.join(directory, 'evidence.json'));
    if (!candidateEvidence || JSON.stringify(candidateEvidence) !== JSON.stringify(evidence)) continue;
    try { await access(path.join(directory, 'candidate.json')); return directory; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return null;
}

async function hasReusableMedia(directory, mediaKind) {
  try {
    if (mediaKind === 'video') {
      const filePath = path.join(directory, 'assets', 'video.mp4');
      if ((await stat(filePath)).size <= 64) return false;
      const handle = await open(filePath, 'r');
      try {
        const prefix = Buffer.alloc(32);
        await handle.read(prefix, 0, 32, 0);
        return prefix.includes(Buffer.from('ftyp'));
      } finally { await handle.close(); }
    }
    if (mediaKind === 'gallery') return (await readdir(path.join(directory, 'assets'))).some((name) => /^image-\d{3}\.(jpg|png|webp)$/.test(name));
  } catch { return false; }
  return false;
}

export async function resolveRetryStage({ projectDirectory, job, localStatus }) {
  if (!validEventId(job?.eventId)) throw new Error('无效收藏事件 ID');
  if (job.status === 'dismissed') return { kind: 'unavailable', reason: '这条收藏已删除' };
  if (['captured', 'partial', 'processing', 'queued'].includes(job.status) && localStatus?.status !== 'failed') {
    return { kind: 'unavailable', reason: '这条收藏仍在处理中，暂时不需要重试' };
  }
  const directories = await candidateDirectories(projectDirectory, job.eventId);
  const expectedSourceId = String(job.result?.aweme_id ?? job.awemeId ?? '');
  const localStage = localStatus?.status === 'failed' ? String(localStatus.stage ?? '') : '';
  const mediaKind = job.result?.media_kind;
  const capturedWithMediaKind = ['captured', 'partial'].includes(job.status) && ['video', 'gallery'].includes(mediaKind);
  if (capturedWithMediaKind && evidenceRetryStages.has(localStage)) {
    return {
      kind: 'evidence',
      label: evidenceRetryStages.get(localStage),
      mediaKind,
      retryStage: localStage,
      resumeFromDirectory: directories[0] ?? null
    };
  }
  for (const directory of directories) {
    const evidence = await validEvidence(directory);
    if (!evidence) continue;
    if (expectedSourceId && String(evidence.source?.id ?? '') !== expectedSourceId) continue;
    if (await alreadyPublished(projectDirectory, evidence)) return { kind: 'completed', label: '卡片已生成，无需重跑', evidenceDirectory: directory };
    if (localStatus?.status === 'failed') {
      const candidateRunDirectory = await matchingCandidateRun(projectDirectory, evidence);
      return { kind: 'card', label: candidateRunDirectory ? '从发布卡片继续' : '从生成卡片继续', evidenceDirectory: directory, candidateRunDirectory };
    }
  }
  const captured = ['captured', 'partial'].includes(job.status) && ['video', 'gallery'].includes(job.result?.media_kind);
  if (captured && localStatus?.status === 'failed') {
    let resumeFromDirectory = null;
    for (const directory of directories) {
      if (await hasReusableMedia(directory, job.result.media_kind)) { resumeFromDirectory = directory; break; }
    }
    return { kind: 'evidence', label: resumeFromDirectory ? '从本地素材继续识别' : '从素材处理继续', mediaKind: job.result.media_kind, resumeFromDirectory };
  }
  // F2/browser may have identified the work but returned an empty or unknown
  // media manifest.  This is not a successful capture: there is nothing for
  // the local ASR/OCR stages to consume, so a manual retry must restart the
  // capture stage.  Keep this narrow to the explicit media-unavailable local
  // failure so a normal captured job is never reset by accident.
  const manifest = Array.isArray(job.result?.media_manifest) ? job.result.media_manifest : [];
  const hasUsableMedia = ['video', 'gallery'].includes(job.result?.media_kind) && manifest.length > 0;
  const mediaUnavailable = ['captured', 'partial'].includes(job.status)
    && !hasUsableMedia
    && localStatus?.status === 'failed'
    && localStatus?.stage === 'media_unavailable';
  if (mediaUnavailable) return { kind: 'capture', label: '重新抓取作品' };
  if (['retryable', 'failed'].includes(job.status)) return { kind: 'capture', label: '重新抓取作品' };
  return { kind: 'unavailable', reason: '这条收藏仍在处理中，暂时不需要重试' };
}

export { validEventId };
