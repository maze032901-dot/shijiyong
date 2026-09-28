import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, copyFile, cp, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { appendEvidenceItems, buildFreshEvidenceDocument, validateEvidenceDocument } from '../runner/lib/evidence-contract.mjs';
import { validateLocalEvidenceLocators } from './mac-gallery-evidence.mjs';
import { runRapidOcrBatch } from './rapidocr-runner.mjs';
import { transcribeWithWhisperCpp } from './whisper-cpp-runner.mjs';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(appDirectory, '..');
const MAX_VIDEO_BYTES = 250 * 1024 * 1024;
const MAX_VIDEO_OCR_FRAMES = 120;
const MIN_VIDEO_OCR_INTERVAL_SECONDS = 0.5;
const MAX_VIDEO_OCR_SILENCE_SECONDS = 4;
const VIDEO_OCR_SIMILARITY_THRESHOLD = 0.65;
const VIDEO_FRAME_FILTER = Object.freeze({ hi: 6144, lo: 2560, frac: 0.60 });
const VIDEO_RETRY_RANK = Object.freeze({
  video_download: 1,
  audio_mux: 1,
  audio_extract: 2,
  asr: 3,
  video_ocr: 4,
  evidence_validation: 5
});
const MEDIA_USER_AGENT = process.env.HERMES_MEDIA_USER_AGENT
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MEDIA_REFERER = process.env.HERMES_MEDIA_REFERER || 'https://www.douyin.com/';

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function canReuseVideoStage(retryStage, producedStage) {
  if (!retryStage) return true;
  const retryRank = VIDEO_RETRY_RANK[retryStage];
  const producedRank = VIDEO_RETRY_RANK[producedStage];
  return Number.isInteger(retryRank) && Number.isInteger(producedRank) && producedRank < retryRank;
}

function safeError(error) {
  return String(error?.message ?? error ?? '未知错误')
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .slice(0, 500);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(filePath) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

function selectedVideoAsset(job) {
  const result = job?.result ?? {};
  if (job?.status !== 'captured') throw new Error(`任务尚不可进行 ASR（当前状态：${job?.status ?? '未知'}）`);
  if (result.media_kind !== 'video') throw new Error(`任务不是视频（当前类型：${result.media_kind ?? '未知'}）`);
  const video = (Array.isArray(result.media_manifest) ? result.media_manifest : [])
    .find((asset) => asset?.kind === 'video' && cleanText(asset.url));
  if (!video) throw new Error('视频任务没有可下载的视频素材');
  return video;
}

function selectedAudioAsset(job) {
  return (Array.isArray(job?.result?.media_manifest) ? job.result.media_manifest : [])
    .find((asset) => asset?.kind === 'audio' && cleanText(asset.url)) ?? null;
}

function redactedMetadata(job) {
  const result = job?.result ?? {};
  return {
    event_id: job.eventId,
    source_url: job.sourceUrl ?? null,
    status: job.status,
    aweme_id: result.aweme_id ?? job.awemeId ?? null,
    canonical_url: result.canonical_url ?? null,
    author: result.author ?? null,
    description: result.description ?? null,
    created_at: result.created_at ?? null,
    captured_at: result.captured_at ?? null,
    media_kind: result.media_kind ?? null,
    media_signals: result.media_signals ?? {},
    media_manifest: (Array.isArray(result.media_manifest) ? result.media_manifest : [])
      .map(({ kind, index, aweme_id }) => ({ kind, index, aweme_id }))
  };
}

async function downloadVideo({ asset, targetPath, fetchImpl, localPath = 'assets/video.mp4' }) {
  const response = await fetchImpl(asset.url, {
    // Douyin CDN accepts the signed URL only when the request resembles a
    // normal browser media request. No account cookie is sent or persisted.
    headers: {
      Accept: 'video/mp4,application/octet-stream;q=0.8,*/*;q=0.1',
      'User-Agent': MEDIA_USER_AGENT,
      Referer: MEDIA_REFERER
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(90_000)
  });
  if (!response.ok) throw new Error(`视频下载失败（HTTP ${response.status}）`);
  if (!response.body) throw new Error('视频响应没有内容');
  const declaredType = cleanText(response.headers.get('content-type')).split(';', 1)[0].toLowerCase();
  if (!['video/mp4', 'application/octet-stream', ''].includes(declaredType)) {
    throw new Error(`不支持的视频类型：${declaredType}`);
  }
  const declaredBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_VIDEO_BYTES) throw new Error('视频超过 250 MiB 安全上限');

  const temporaryPath = `${targetPath}.part`;
  const handle = await open(temporaryPath, 'wx');
  const digest = createHash('sha256');
  let bytes = 0;
  let prefix = Buffer.alloc(0);
  try {
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.length;
      if (bytes > MAX_VIDEO_BYTES) throw new Error('视频超过 250 MiB 安全上限');
      if (prefix.length < 64) prefix = Buffer.concat([prefix, chunk.subarray(0, 64 - prefix.length)]);
      digest.update(chunk);
      await handle.write(chunk);
    }
  } catch (error) {
    await handle.close();
    await rm(temporaryPath, { force: true });
    throw error;
  }
  await handle.close();
  if (bytes === 0 || !prefix.subarray(0, 32).includes(Buffer.from('ftyp'))) {
    await rm(temporaryPath, { force: true });
    throw new Error('视频为空或不是有效 MP4');
  }
  await rename(temporaryPath, targetPath);
  return { local_path: localPath, content_type: 'video/mp4', bytes, sha256: digest.digest('hex') };
}

async function muxVideoAudio(videoPath, audioPath, targetPath) {
  const executable = process.env.HERMES_FFMPEG_PATH || 'ffmpeg';
  await runProcess(executable, [
    '-nostdin', '-v', 'error', '-n',
    '-i', videoPath, '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart', targetPath
  ], '视频与音轨合成失败');
  const info = await stat(targetPath);
  if (info.size === 0) throw new Error('视频与音轨合成结果为空');
  return {
    local_path: 'assets/video.mp4',
    content_type: 'video/mp4',
    bytes: info.size,
    sha256: await sha256File(targetPath)
  };
}

function runProcess(executable, args, errorPrefix, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, { cwd: projectDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > 5_000_000) stdout = stdout.slice(-5_000_000); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
    child.on('error', (error) => reject(new Error(`${errorPrefix}：${safeError(error)}`)));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${errorPrefix}（退出码 ${code}）：${safeError(stderr)}`));
      else resolve(stdout);
    });
  });
}

export async function extractAudio(videoPath, audioPath, spawnImpl = spawn) {
  const executable = process.env.HERMES_FFMPEG_PATH || 'ffmpeg';
  await runProcess(executable, [
    '-nostdin', '-v', 'error', '-n', '-i', videoPath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath
  ], '音频提取失败', spawnImpl);
  const info = await stat(audioPath);
  if (info.size === 0) throw new Error('音频提取结果为空');
  return {
    local_path: 'assets/audio-16k.wav',
    content_type: 'audio/wav',
    bytes: info.size,
    duration_seconds: Math.max(0, (info.size - 44) / 32_000),
    sha256: await sha256File(audioPath)
  };
}

export async function runWhisperCpp(audioPath, options = {}) {
  return transcribeWithWhisperCpp(audioPath, options);
}

async function readPrefix(filePath, size = 64) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

async function reusableVideo(resumeFromDirectory, assetsDirectory) {
  if (!resumeFromDirectory) return null;
  const original = path.join(resumeFromDirectory, 'assets', 'video.mp4');
  try {
    const info = await stat(original);
    if (info.size < 64 || !(await readPrefix(original, 32)).includes(Buffer.from('ftyp'))) return null;
    await copyFile(original, path.join(assetsDirectory, 'video.mp4'));
    return { local_path: 'assets/video.mp4', content_type: 'video/mp4', bytes: info.size, sha256: await sha256File(original) };
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function reusableAudio(resumeFromDirectory, assetsDirectory) {
  if (!resumeFromDirectory) return null;
  const original = path.join(resumeFromDirectory, 'assets', 'audio-16k.wav');
  try {
    const info = await stat(original);
    const prefix = await readPrefix(original, 12);
    if (info.size <= 44 || prefix.toString('ascii', 0, 4) !== 'RIFF' || prefix.toString('ascii', 8, 12) !== 'WAVE') return null;
    await copyFile(original, path.join(assetsDirectory, 'audio-16k.wav'));
    return { local_path: 'assets/audio-16k.wav', content_type: 'audio/wav', bytes: info.size, duration_seconds: Math.max(0, (info.size - 44) / 32_000), sha256: await sha256File(original) };
  } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

async function reusableTranscript(resumeFromDirectory) {
  if (!resumeFromDirectory) return null;
  try {
    const transcript = JSON.parse(await readFile(path.join(resumeFromDirectory, 'asr-transcript.json'), 'utf8'));
    return transcript.engine === 'whisper.cpp' && transcript.model === 'large-v3-turbo'
      && Array.isArray(transcript.segments) && Number.isFinite(Number(transcript.duration_seconds)) ? transcript : null;
  } catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

async function reusableVideoOcr(resumeFromDirectory, staging) {
  if (!resumeFromDirectory) return null;
  try {
    const result = JSON.parse(await readFile(path.join(resumeFromDirectory, 'video-ocr.json'), 'utf8'));
    if (result.status !== 'completed' || result.engine !== 'RapidOCR' || !Array.isArray(result.frames)) return null;
    for (const frame of result.frames) {
      if (!/^frames\/frame-\d{4}\.jpg$/.test(frame.local_path)) return null;
      await access(path.join(resumeFromDirectory, frame.local_path));
    }
    if (result.frames.length) await cp(path.join(resumeFromDirectory, 'frames'), path.join(staging, 'frames'), { recursive: true });
    return result;
  } catch (error) { if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

function normaliseOcrText(value) {
  return cleanText(value).toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function characterBigrams(value) {
  const normalised = normaliseOcrText(value);
  const grams = new Set();
  if (normalised.length < 2) {
    if (normalised) grams.add(normalised);
    return grams;
  }
  for (let index = 0; index < normalised.length - 1; index += 1) grams.add(normalised.slice(index, index + 2));
  return grams;
}

function textSimilarity(left, right) {
  const leftGrams = characterBigrams(left);
  const rightGrams = characterBigrams(right);
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0;
  let overlap = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) overlap += 1;
  return (2 * overlap) / (leftGrams.size + rightGrams.size);
}

export function consolidateVideoOcrFrames(frames, threshold = VIDEO_OCR_SIMILARITY_THRESHOLD) {
  const groups = [];
  for (const frame of frames) {
    const group = groups.at(-1);
    const belongs = group
      && textSimilarity(group[0].text, frame.text) >= threshold
      && textSimilarity(group.at(-1).text, frame.text) >= threshold;
    if (belongs) group.push(frame);
    else groups.push([frame]);
  }
  return groups.map((group, index) => {
    const representative = group.reduce((best, candidate) => {
      const bestScore = normaliseOcrText(best.text).length * (0.5 + best.confidence);
      const candidateScore = normaliseOcrText(candidate.text).length * (0.5 + candidate.confidence);
      return candidateScore > bestScore ? candidate : best;
    });
    const occurrences = group.flatMap((frame) => frame.occurrences ?? [frame.timestamp_seconds]);
    return {
      ...representative,
      index: index + 1,
      occurrences,
      time_range: {
        start_seconds: Math.min(...occurrences),
        end_seconds: Math.max(...occurrences)
      },
      merged_frames: group.length
    };
  });
}

export async function extractVideoFrameOcr({
  videoPath,
  framesDirectory,
  durationSeconds,
  spawnImpl = spawn
}) {
  const duration = Number(durationSeconds);
  const intervalSeconds = Math.max(
    MIN_VIDEO_OCR_INTERVAL_SECONDS,
    Number.isFinite(duration) && duration > 0 ? duration / MAX_VIDEO_OCR_FRAMES : 1
  );
  await mkdir(framesDirectory, { recursive: true });
  const executable = process.env.HERMES_FFMPEG_PATH || 'ffmpeg';
  const fpsFilter = `fps=1/${intervalSeconds.toFixed(6)}`;
  await runProcess(executable, [
    '-nostdin', '-v', 'error', '-n', '-i', videoPath,
    '-vf', fpsFilter,
    '-frames:v', String(MAX_VIDEO_OCR_FRAMES), '-q:v', '2',
    '-start_number', '0', path.join(framesDirectory, 'frame-%04d.jpg')
  ], '视频抽帧失败', spawnImpl);

  const candidateFileNames = (await readdir(framesDirectory))
    .filter((name) => /^frame-\d{4}\.jpg$/.test(name))
    .sort();
  const comparisonDirectory = path.join(framesDirectory, '.comparison');
  await mkdir(comparisonDirectory);
  const maxDropCount = Math.max(1, Math.floor(MAX_VIDEO_OCR_SILENCE_SECONDS / intervalSeconds));
  await runProcess(executable, [
    '-nostdin', '-v', 'error', '-n', '-i', videoPath,
    '-vf', `${fpsFilter},scale=320:-2,format=gray,gblur=sigma=2,mpdecimate=max=${maxDropCount}:hi=${VIDEO_FRAME_FILTER.hi}:lo=${VIDEO_FRAME_FILTER.lo}:frac=${VIDEO_FRAME_FILTER.frac}`,
    '-frames:v', String(MAX_VIDEO_OCR_FRAMES), '-fps_mode', 'vfr', '-frame_pts', '1',
    path.join(comparisonDirectory, 'frame-%04d.pgm')
  ], '视频关键帧筛选失败', spawnImpl);
  const selectedIndexes = new Set((await readdir(comparisonDirectory))
    .map((name) => /^frame-(\d+)\.pgm$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number));
  await rm(comparisonDirectory, { recursive: true, force: true });
  if (selectedIndexes.size === 0 && candidateFileNames.length > 0) selectedIndexes.add(0);
  const fileNames = [];
  for (const fileName of candidateFileNames) {
    const frameIndex = Number(/^frame-(\d+)\.jpg$/.exec(fileName)?.[1]);
    if (selectedIndexes.has(frameIndex)) fileNames.push(fileName);
    else await rm(path.join(framesDirectory, fileName), { force: true });
  }
  const exactUniqueFrames = [];
  const seen = new Map();
  const failures = [];
  const ocrResults = await runRapidOcrBatch(fileNames.map((fileName) => ({
    assetId: fileName,
    localPath: path.posix.join('frames', fileName),
    imagePath: path.join(framesDirectory, fileName)
  })));
  for (const [index, fileName] of fileNames.entries()) {
    const framePath = path.join(framesDirectory, fileName);
    const sampledFrame = Number(/^frame-(\d+)\.jpg$/.exec(fileName)?.[1]);
    const timestampSeconds = Number(Math.min(
      Number.isFinite(duration) && duration > 0 ? duration : Number.POSITIVE_INFINITY,
      sampledFrame * intervalSeconds
    ).toFixed(3));
    const ocr = ocrResults[index];
    if (!ocr || ocr.status === 'failed') {
      failures.push({ frame: sampledFrame, timestamp_seconds: timestampSeconds, error: safeError(ocr?.error || 'RapidOCR 没有返回该帧结果') });
      await rm(framePath, { force: true });
      continue;
    }
    const regions = Array.isArray(ocr.regions) ? ocr.regions : [];
    const text = regions.map((region) => cleanText(region.text)).filter(Boolean).join('\n');
    const key = normaliseOcrText(text);
    if (!key) {
      await rm(framePath, { force: true });
      continue;
    }
    const duplicate = seen.get(key);
    if (duplicate) {
      duplicate.occurrences.push(timestampSeconds);
      await rm(framePath, { force: true });
      continue;
    }
    const info = await stat(framePath);
    const frame = {
      index: exactUniqueFrames.length + 1,
      sampled_frame: sampledFrame,
      timestamp_seconds: timestampSeconds,
      local_path: path.posix.join('frames', fileName),
      content_type: 'image/jpeg',
      bytes: info.size,
      sha256: await sha256File(framePath),
      text,
      confidence: regions.length ? regions.reduce((sum, region) => sum + (Number(region.confidence) || 0), 0) / regions.length : 0,
      words: regions.length,
      regions,
      image_width_px: ocr.image_width_px ?? null,
      image_height_px: ocr.image_height_px ?? null,
      occurrences: [timestampSeconds]
    };
    seen.set(key, frame);
    exactUniqueFrames.push(frame);
  }
  const evidenceFrames = consolidateVideoOcrFrames(exactUniqueFrames);
  const retainedPaths = new Set(evidenceFrames.map((frame) => frame.local_path));
  for (const frame of exactUniqueFrames) {
    if (!retainedPaths.has(frame.local_path)) await rm(path.join(framesDirectory, path.basename(frame.local_path)), { force: true });
  }
  return {
    schema_version: 'hermes/video-ocr/v1',
    status: 'completed',
    engine: 'RapidOCR',
    languages: 'ch+en',
    interval_seconds: Number(intervalSeconds.toFixed(3)),
    candidate_frames: candidateFileNames.length,
    selected_frames: fileNames.length,
    sampled_frames: fileNames.length,
    selection: {
      method: 'ffmpeg_mpdecimate',
      comparison: 'scale_320_gray_blur_2',
      max_silence_seconds: MAX_VIDEO_OCR_SILENCE_SECONDS,
      max_drop_count: maxDropCount,
      ...VIDEO_FRAME_FILTER
    },
    text_frames_before_merge: exactUniqueFrames.length,
    unique_text_frames: evidenceFrames.length,
    elapsed_seconds: ocrResults[0]?.batch_elapsed_seconds ?? null,
    similarity_threshold: VIDEO_OCR_SIMILARITY_THRESHOLD,
    max_frames: MAX_VIDEO_OCR_FRAMES,
    frames: evidenceFrames,
    failures
  };
}

function buildVideoOcrEvidenceItems({ awemeId, video, videoOcr }) {
  const items = [];
  for (const frame of videoOcr.frames ?? []) {
    const suffix = String(frame.index).padStart(3, '0');
    items.push({
      id: `asset-frame-${suffix}`,
      kind: 'asset',
      source_id: awemeId,
      locator: {
        asset_kind: 'video_frame',
        local_path: frame.local_path,
        content_type: frame.content_type,
        bytes: frame.bytes,
        timestamp_seconds: frame.timestamp_seconds,
        video_path: video.local_path
      },
      confidence: 1,
      sha256: frame.sha256
    });
    items.push({
      id: `ocr-frame-${suffix}`,
      kind: 'ocr',
      source_id: awemeId,
      text: frame.text,
      locator: {
        frame_index: frame.sampled_frame,
        timestamp_seconds: frame.timestamp_seconds,
        occurrences: frame.occurrences,
        local_path: frame.local_path,
        video_path: video.local_path,
        report_path: 'video-ocr.json',
        engine: videoOcr.engine,
        languages: videoOcr.languages,
        regions: frame.regions ?? [],
        image_width_px: frame.image_width_px ?? null,
        image_height_px: frame.image_height_px ?? null
      },
      confidence: frame.confidence,
      sha256: sha256(frame.text)
    });
  }
  return items;
}

function buildEvidence({ job, video, audio, transcript, videoOcr }) {
  const result = job.result;
  const awemeId = String(result.aweme_id ?? job.awemeId ?? 'unknown');
  const metadata = redactedMetadata(job);
  const items = [{
    id: 'metadata-001',
    kind: 'metadata',
    source_id: awemeId,
    text: JSON.stringify(metadata, null, 2),
    locator: { local_path: 'source-metadata.json', format: 'json' },
    confidence: 1,
    sha256: sha256(JSON.stringify(metadata))
  }];
  for (const [id, assetKind, asset] of [
    ['asset-video', 'video', video],
    ['asset-audio', 'audio', audio]
  ]) {
    items.push({
      id,
      kind: 'asset',
      source_id: awemeId,
      locator: {
        asset_kind: assetKind,
        local_path: asset.local_path,
        content_type: asset.content_type,
        bytes: asset.bytes
      },
      confidence: 1,
      sha256: asset.sha256
    });
  }
  for (const segment of transcript.segments) {
    const text = cleanText(segment.text);
    if (!text) continue;
    items.push({
      id: `asr-${String(segment.index).padStart(3, '0')}`,
      kind: 'asr',
      source_id: awemeId,
      text,
      locator: {
        segment_index: segment.index,
        start_seconds: segment.start,
        end_seconds: segment.end,
        transcript_path: 'asr-transcript.json',
        engine: transcript.engine,
        model: transcript.model,
        language: transcript.language
      },
      confidence: Math.max(0, Math.min(1, Number(segment.confidence) || 0)),
      sha256: sha256(text)
    });
  }
  items.push(...buildVideoOcrEvidenceItems({ awemeId, video, videoOcr }));
  return buildFreshEvidenceDocument({
    source: {
      id: awemeId,
      kind: 'douyin_post',
      title: cleanText(result.description).slice(0, 120) || `抖音作品 ${awemeId}`,
      evidence_scope: 'fresh_source',
      status: 'captured',
      source_url: result.canonical_url ?? job.sourceUrl
    },
    mediaKind: 'video',
    mediaSignals: result.media_signals ?? {},
    items
  });
}

export async function enrichExistingVideoEvidence({
  outputDirectory,
  videoOcrRunner = extractVideoFrameOcr,
  replaceExisting = false
}) {
  const target = path.resolve(outputDirectory);
  const evidencePath = path.join(target, 'evidence.json');
  const baseEvidencePath = path.join(target, 'evidence.before-video-ocr.json');
  const validationPath = path.join(target, 'validation.json');
  const transcriptPath = path.join(target, 'asr-transcript.json');
  const videoPath = path.join(target, 'assets', 'video.mp4');
  let evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const transcript = JSON.parse(await readFile(transcriptPath, 'utf8'));
  if (evidence.media?.kind !== 'video') throw new Error('指定证据包不是视频');
  const alreadyEnriched = evidence.items.some((item) => item.id.startsWith('ocr-frame-'));
  if (alreadyEnriched && !replaceExisting) throw new Error('该视频证据包已经包含画面 OCR');
  if (alreadyEnriched) evidence = JSON.parse(await readFile(baseEvidencePath, 'utf8'));

  const temporaryFrames = await mkdtemp(path.join(target, '.frames-ocr-'));
  const framesDirectory = path.join(target, 'frames');
  const rebuildSuffix = new Date().toISOString().replace(/[:.]/g, '-');
  const previousFrames = `${framesDirectory}.before-rebuild-${rebuildSuffix}`;
  let framesPromoted = false;
  let previousFramesMoved = false;
  try {
    const videoOcr = await videoOcrRunner({
      videoPath,
      framesDirectory: temporaryFrames,
      durationSeconds: transcript.duration_seconds
    });
    try {
      await access(framesDirectory);
      if (!replaceExisting) throw new Error('证据包已经存在 frames 目录，拒绝覆盖');
      await rename(framesDirectory, previousFrames);
      previousFramesMoved = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await rename(temporaryFrames, framesDirectory);
    framesPromoted = true;
    const adjustedVideoOcr = {
      ...videoOcr,
      frames: (videoOcr.frames ?? []).map((frame) => ({
        ...frame,
        local_path: path.posix.join('frames', path.basename(frame.local_path))
      }))
    };
    const video = { local_path: 'assets/video.mp4' };
    const additions = buildVideoOcrEvidenceItems({
      awemeId: evidence.source.id,
      video,
      videoOcr: adjustedVideoOcr
    });
    const nextEvidence = appendEvidenceItems(evidence, additions);
    const structural = validateEvidenceDocument(nextEvidence);
    const locators = await validateLocalEvidenceLocators(nextEvidence, target);
    const validation = {
      status: structural.status === 'passed' && locators.status === 'passed' ? 'passed' : 'failed',
      structural,
      local_locators: locators
    };
    if (validation.status !== 'passed') throw new Error('追加视频 OCR 后证据校验失败');

    const evidenceNext = `${evidencePath}.next`;
    const validationNext = `${validationPath}.next`;
    if (alreadyEnriched) {
      await copyFile(evidencePath, path.join(target, `evidence.before-rebuild-${rebuildSuffix}.json`));
      try { await copyFile(path.join(target, 'video-ocr.json'), path.join(target, `video-ocr.before-rebuild-${rebuildSuffix}.json`)); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    } else {
      await copyFile(evidencePath, baseEvidencePath);
      try { await copyFile(validationPath, path.join(target, 'validation.before-video-ocr.json')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
    await writeFile(path.join(target, 'video-ocr.json'), `${JSON.stringify(adjustedVideoOcr, null, 2)}\n`, 'utf8');
    await writeFile(evidenceNext, `${JSON.stringify(nextEvidence, null, 2)}\n`, 'utf8');
    await writeFile(validationNext, `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
    await rename(validationNext, validationPath);
    await rename(evidenceNext, evidencePath);
    return {
      output_directory: target,
      sampled_frames: adjustedVideoOcr.sampled_frames,
      ocr_frames: adjustedVideoOcr.frames.length,
      ocr_failures: adjustedVideoOcr.failures.length,
      validation: validation.status
    };
  } catch (error) {
    if (framesPromoted && previousFramesMoved) {
      await rm(framesDirectory, { recursive: true, force: true });
      await rename(previousFrames, framesDirectory);
    } else if (framesPromoted) {
      await rm(framesDirectory, { recursive: true, force: true });
    } else if (!framesPromoted) {
      await rm(temporaryFrames, { recursive: true, force: true });
    }
    throw error;
  }
}

function renderReport({ job, video, audio, transcript, videoOcr, validation }) {
  const result = job.result;
  const lines = [
    '# 视频 ASR 证据报告',
    '',
    `- 任务：${job.eventId}`,
    `- 作品 ID：${result.aweme_id ?? job.awemeId ?? '未知'}`,
    `- 标准链接：${result.canonical_url ?? '未生成'}`,
    `- 作者：${cleanText(result.author) || '未知'}`,
    `- 视频：${video.bytes} bytes · SHA-256 ${video.sha256}`,
    `- 音频：${audio.bytes} bytes · SHA-256 ${audio.sha256}`,
    `- ASR：${transcript.engine} / ${transcript.model} · 语言 ${transcript.language}`,
    ...(Number.isFinite(transcript.run?.elapsed_seconds) ? [`- ASR 耗时：${transcript.run.elapsed_seconds} 秒`] : []),
    `- 时长：${transcript.duration_seconds} 秒 · 分段：${transcript.segments.length}`,
    `- 视频 OCR：${videoOcr.status === 'completed' ? `${videoOcr.candidate_frames} 帧候选 · ${videoOcr.selected_frames} 帧实际识别 · ${videoOcr.unique_text_frames} 段独立文字` : `失败 · ${videoOcr.error}`}`,
    ...(Number.isFinite(videoOcr.elapsed_seconds) ? [`- RapidOCR 耗时：${videoOcr.elapsed_seconds} 秒`] : []),
    ...(videoOcr.status === 'completed' ? [`- 抽帧间隔：${videoOcr.interval_seconds} 秒 · 单视频上限 ${videoOcr.max_frames} 帧`] : []),
    `- 证据校验：${validation.status === 'passed' ? '通过' : '失败'}`,
    '',
    '## 转写原文',
    ''
  ];
  if (transcript.segments.length === 0) lines.push('未检测到可用语音。', '');
  for (const segment of transcript.segments) {
    lines.push(`### ${segment.start.toFixed(2)}s–${segment.end.toFixed(2)}s（置信度 ${Number(segment.confidence).toFixed(2)}）`, '', segment.text, '');
  }
  lines.push('## 画面文字', '');
  if ((videoOcr.frames ?? []).length === 0) lines.push(videoOcr.status === 'completed' ? '抽样画面未检测到可用文字。' : '视频 OCR 未完成，ASR 证据仍保留。', '');
  for (const frame of videoOcr.frames ?? []) {
    lines.push(`### ${frame.timestamp_seconds.toFixed(2)}s（置信度 ${Number(frame.confidence).toFixed(2)}）`, '', frame.text, '', `画面：${frame.local_path}`, '');
  }
  lines.push('> 视频签名地址未写入本报告；本地视频、音频与转写均通过 locator 和 SHA-256 追溯。', '');
  return lines.join('\n');
}

export async function processVideoEvidence({
  job,
  outputDirectory,
  resumeFromDirectory = null,
  fetchImpl = fetch,
  ffmpegRunner = extractAudio,
  muxRunner = muxVideoAudio,
  asrRunner = runWhisperCpp,
  videoOcrRunner = extractVideoFrameOcr,
  retryStage = null,
  onStage = async () => {}
}) {
  const audioAsset = selectedAudioAsset(job);
  const target = path.resolve(outputDirectory);
  try {
    await access(target);
    throw new Error('该任务已有本地处理目录；为避免覆盖既有证据，本次不会继续。');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, `.${path.basename(target)}-asr-`));
  const assetsDirectory = path.join(staging, 'assets');
  await mkdir(assetsDirectory);
  try {
    await writeFile(path.join(staging, 'checkpoint.json'), `${JSON.stringify({ event_id: job.eventId, aweme_id: job.result?.aweme_id ?? job.awemeId ?? null })}\n`, 'utf8');
    let video = canReuseVideoStage(retryStage, 'video_download')
      ? await reusableVideo(resumeFromDirectory, assetsDirectory)
      : null;
    if (!video) {
      const videoAsset = selectedVideoAsset(job);
      await onStage({ stage: 'video_download_request', message: '正在请求视频和音轨素材。' });
      await onStage({ stage: 'video_download_waiting', message: '视频素材请求已发出，正在等待下载响应。' });
      await onStage({ stage: 'video_download', message: '正在下载视频素材。' });
      if (audioAsset) {
        const silentPath = path.join(assetsDirectory, 'video-only.mp4');
        const soundtrackPath = path.join(assetsDirectory, 'audio-only.mp4');
        await downloadVideo({ asset: videoAsset, targetPath: silentPath, fetchImpl, localPath: 'assets/video-only.mp4' });
        await downloadVideo({ asset: audioAsset, targetPath: soundtrackPath, fetchImpl, localPath: 'assets/audio-only.mp4' });
        await onStage({ stage: 'audio_mux', message: '画面和音轨已取得，正在合成完整视频。' });
        video = await muxRunner(silentPath, soundtrackPath, path.join(assetsDirectory, 'video.mp4'));
        await rm(silentPath, { force: true });
        await rm(soundtrackPath, { force: true });
      } else {
        video = await downloadVideo({ asset: videoAsset, targetPath: path.join(assetsDirectory, 'video.mp4'), fetchImpl });
      }
      await onStage({ stage: 'video_download_received', message: '视频素材已保存，准备处理音频。' });
    }
    let audio = canReuseVideoStage(retryStage, 'audio_extract')
      ? await reusableAudio(resumeFromDirectory, assetsDirectory)
      : null;
    if (!audio) {
      await onStage({ stage: 'audio_extract', message: '视频已保存，正在提取音轨。' });
      audio = await ffmpegRunner(path.join(assetsDirectory, 'video.mp4'), path.join(assetsDirectory, 'audio-16k.wav'));
      await onStage({ stage: 'audio_extract_received', message: '音轨已提取，准备发送给 ASR。' });
    }
    let transcript = canReuseVideoStage(retryStage, 'asr')
      ? await reusableTranscript(resumeFromDirectory)
      : null;
    if (!transcript) {
      await onStage({ stage: 'asr_request', message: '正在准备 whisper.cpp large-v3-turbo 转写。' });
      await onStage({ stage: 'asr_waiting', message: '音频已交给 whisper.cpp，正在等待转写结果。' });
      await onStage({ stage: 'asr', message: '正在使用 whisper.cpp large-v3-turbo 转写语音。' });
      transcript = await asrRunner(path.join(assetsDirectory, 'audio-16k.wav'), {
        outputDirectory: staging,
        durationSeconds: audio.duration_seconds
      });
      await onStage({ stage: 'asr_received', message: `ASR 已完成，共收到 ${transcript.segments?.length ?? 0} 段口播。` });
    }
    let videoOcr = canReuseVideoStage(retryStage, 'video_ocr')
      ? await reusableVideoOcr(resumeFromDirectory, staging)
      : null;
    if (!videoOcr) {
      try {
        await onStage({ stage: 'video_ocr_request', message: '正在抽取视频关键帧并准备 RapidOCR。' });
        await onStage({ stage: 'video_ocr_waiting', message: '关键帧已提交给 RapidOCR，正在等待识别结果。' });
        await onStage({ stage: 'video_ocr', message: '正在对视频关键帧运行 RapidOCR。' });
        const framesDirectory = path.join(staging, 'frames');
        await mkdir(framesDirectory);
        videoOcr = await videoOcrRunner({
          videoPath: path.join(assetsDirectory, 'video.mp4'),
          framesDirectory,
          durationSeconds: transcript.duration_seconds
        });
        await onStage({ stage: 'video_ocr_received', message: `画面 OCR 已完成，共保留 ${videoOcr.frames?.length ?? 0} 组关键帧文字。` });
      } catch (error) {
        videoOcr = {
          schema_version: 'hermes/video-ocr/v1', status: 'failed', engine: 'RapidOCR', languages: 'ch+en',
          frames: [], failures: [], error: safeError(error)
        };
      }
    }
    const metadata = redactedMetadata(job);
    await writeFile(path.join(staging, 'source-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    await writeFile(path.join(staging, 'asr-transcript.json'), `${JSON.stringify(transcript, null, 2)}\n`, 'utf8');
    await writeFile(path.join(staging, 'video-ocr.json'), `${JSON.stringify(videoOcr, null, 2)}\n`, 'utf8');
    const evidence = buildEvidence({ job, video, audio, transcript, videoOcr });
    await onStage({ stage: 'evidence_validation', message: 'ASR/OCR 已完成，正在校验结果和素材文件。' });
    const structural = validateEvidenceDocument(evidence);
    const locators = await validateLocalEvidenceLocators(evidence, staging);
    const validation = {
      status: structural.status === 'passed' && locators.status === 'passed' ? 'passed' : 'failed',
      structural,
      local_locators: locators
    };
    await onStage({ stage: 'evidence_validated', message: validation.status === 'passed' ? '识别结果和素材已通过证据校验。' : '证据校验未通过，已保留失败详情供重试。' });
    await writeFile(path.join(staging, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    await writeFile(path.join(staging, 'validation.json'), `${JSON.stringify(validation, null, 2)}\n`, 'utf8');
    await writeFile(path.join(staging, 'asr-report.md'), renderReport({ job, video, audio, transcript, videoOcr, validation }), 'utf8');
    await rename(staging, target);
    return {
      status: 'captured',
      output_directory: target,
      video_bytes: video.bytes,
      audio_bytes: audio.bytes,
      asr_segments: transcript.segments.length,
      video_ocr_status: videoOcr.status,
      video_ocr_frames: videoOcr.frames.length,
      video_ocr_sampled_frames: videoOcr.sampled_frames ?? 0,
      video_ocr_candidate_frames: videoOcr.candidate_frames ?? 0,
      language: transcript.language,
      validation: validation.status
    };
  } catch (error) {
    try { await rename(staging, target); }
    catch { /* Preserve the original error; the staging directory still contains reusable files. */ }
    throw error;
  }
}
