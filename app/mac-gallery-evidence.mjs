import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildFreshEvidenceDocument, validateEvidenceDocument } from '../runner/lib/evidence-contract.mjs';
import { runRapidOcrBatch } from './rapidocr-runner.mjs';

const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
export const VISUAL_REVIEW_CONFIDENCE_THRESHOLD = 0.6;
const IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp']
]);
const GALLERY_RETRY_RANK = Object.freeze({ image_download: 1, ocr: 2, evidence_validation: 3 });

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function canReuseGalleryStage(retryStage, producedStage) {
  if (!retryStage) return true;
  const retryRank = GALLERY_RETRY_RANK[retryStage];
  const producedRank = GALLERY_RETRY_RANK[producedStage];
  return Number.isInteger(retryRank) && Number.isInteger(producedRank) && producedRank < retryRank;
}

function safeName(value, fallback) {
  const name = String(value ?? fallback).replace(/[^A-Za-z0-9_-]/g, '');
  return name || fallback;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function imageMagicMatches(contentType, bytes) {
  return (contentType === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    || (contentType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    || (contentType === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP');
}

function safeError(error) {
  return String(error?.message ?? error ?? '未知错误')
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .slice(0, 240);
}

function selectedImageAssets(job) {
  const result = job?.result ?? {};
  if (job?.status !== 'captured') throw new Error(`任务尚不可进行 OCR（当前状态：${job?.status ?? '未知'}）`);
  if (result.media_kind !== 'gallery') throw new Error(`任务不是图文（当前类型：${result.media_kind ?? '未知'}）`);
  const images = (Array.isArray(result.media_manifest) ? result.media_manifest : [])
    .filter((asset) => asset?.kind === 'image' && Number.isInteger(asset.index) && cleanText(asset.url));
  if (images.length === 0) throw new Error('图文任务没有可下载的图片素材');
  if (images.length > MAX_IMAGES) throw new Error(`图文图片数量超过本轮安全上限（${MAX_IMAGES}）`);
  return images;
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
    media_manifest: (Array.isArray(result.media_manifest) ? result.media_manifest : []).map(({ kind, index, aweme_id }) => ({ kind, index, aweme_id }))
  };
}

async function downloadImage({ asset, assetsDirectory, fetchImpl }) {
  const response = await fetchImpl(asset.url, {
    headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) throw new Error(`素材下载失败（HTTP ${response.status}）`);
  const contentType = cleanText(response.headers.get('content-type')).split(';', 1)[0].toLowerCase();
  const extension = IMAGE_TYPES.get(contentType);
  if (!extension) throw new Error(`不支持的图片类型：${contentType || '缺失'}`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) throw new Error('图片超过 30 MiB 安全上限');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) throw new Error('图片为空或超过 30 MiB 安全上限');
  if (!imageMagicMatches(contentType, buffer)) throw new Error('图片内容与声明类型不一致');
  const fileName = `image-${String(asset.index).padStart(3, '0')}${extension}`;
  const finalPath = path.join(assetsDirectory, fileName);
  const temporaryPath = `${finalPath}.part`;
  const handle = await open(temporaryPath, 'wx');
  try {
    await handle.writeFile(buffer);
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, finalPath);
  return {
    kind: 'image',
    index: asset.index,
    status: 'captured',
    local_path: path.posix.join('assets', fileName),
    content_type: contentType,
    bytes: buffer.length,
    sha256: hash(buffer)
  };
}

async function reuseImage({ asset, assetsDirectory, resumeFromDirectory }) {
  if (!resumeFromDirectory) return null;
  for (const [contentType, extension] of IMAGE_TYPES) {
    const fileName = `image-${String(asset.index).padStart(3, '0')}${extension}`;
    const oldPath = path.join(resumeFromDirectory, 'assets', fileName);
    let buffer;
    try { buffer = await readFile(oldPath); }
    catch (error) { if (error?.code === 'ENOENT') continue; throw error; }
    if (!buffer.length || buffer.length > MAX_IMAGE_BYTES || !imageMagicMatches(contentType, buffer)) continue;
    const localPath = path.posix.join('assets', fileName);
    await copyFile(oldPath, path.join(assetsDirectory, fileName));
    return { kind: 'image', index: asset.index, status: 'captured', local_path: localPath, content_type: contentType, bytes: buffer.length, sha256: hash(buffer) };
  }
  return null;
}

async function reusableOcrResults(resumeFromDirectory) {
  if (!resumeFromDirectory) return null;
  try {
    const results = JSON.parse(await readFile(path.join(resumeFromDirectory, 'ocr-results.json'), 'utf8'));
    if (!Array.isArray(results) || results.length === 0) return null;
    for (const item of results) {
      if (!item || !/^assets\/image-\d{3}\.(jpg|png|webp)$/.test(String(item.local_path ?? ''))) return null;
      await access(path.join(resumeFromDirectory, item.local_path));
    }
    return results;
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function validateLocalEvidenceLocators(document, outputDirectory) {
  const issues = [];
  for (const item of document.items ?? []) {
    const localPath = item?.locator?.local_path;
    if (!localPath) continue;
    const resolved = path.resolve(outputDirectory, localPath);
    if (!resolved.startsWith(`${path.resolve(outputDirectory)}${path.sep}`)) {
      issues.push(`证据 ${item.id} 的本地路径越界`);
      continue;
    }
    try {
      await access(resolved);
    } catch {
      issues.push(`证据 ${item.id} 指向的本地文件不存在`);
    }
  }
  return { status: issues.length ? 'failed' : 'passed', issues };
}

function buildPacketDocument({ job, assets, ocrResults }) {
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
    sha256: hash(JSON.stringify(metadata))
  }];
  for (const asset of assets) {
    items.push({
      id: `asset-${String(asset.index).padStart(3, '0')}`,
      kind: 'asset',
      source_id: awemeId,
      locator: {
        asset_index: asset.index,
        asset_kind: 'image',
        local_path: asset.local_path,
        content_type: asset.content_type,
        bytes: asset.bytes
      },
      confidence: 1,
      sha256: asset.sha256
    });
  }
  for (const result of ocrResults) {
    if (!result.text) continue;
    items.push({
      id: `ocr-${String(result.index).padStart(3, '0')}`,
      kind: 'ocr',
      source_id: awemeId,
      text: result.text,
      locator: {
        asset_index: result.index,
        local_path: result.local_path,
        image_evidence_id: `asset-${String(result.index).padStart(3, '0')}`,
        engine: 'RapidOCR',
        languages: 'ch+en',
        image_width_px: result.image_width_px ?? null,
        image_height_px: result.image_height_px ?? null,
        regions: result.regions ?? []
      },
      confidence: result.confidence,
      sha256: hash(result.text)
    });
  }
  return buildFreshEvidenceDocument({
    source: {
      id: awemeId,
      kind: 'douyin_post',
      title: cleanText(result.description).slice(0, 120) || `抖音作品 ${awemeId}`,
      evidence_scope: 'fresh_source',
      status: 'captured',
      source_url: result.canonical_url ?? job.sourceUrl
    },
    mediaKind: 'gallery',
    mediaSignals: result.media_signals ?? {},
    items
  });
}

function buildVisualReview({ job, ocrResults }) {
  const items = ocrResults
    .filter((item) => !item.text || item.confidence < VISUAL_REVIEW_CONFIDENCE_THRESHOLD)
    .map((item) => ({
      evidence_id: `ocr-${String(item.index).padStart(3, '0')}`,
      asset_index: item.index,
      local_path: item.local_path,
      ocr_confidence: item.confidence,
      reason: item.text ? 'low_ocr_confidence' : 'no_ocr_text',
      visual_classification: null,
      visual_understanding: null
    }));
  return {
    schema_version: 'hermes/visual-review/v1',
    event_id: job.eventId,
    status: items.length ? 'needs_visual_review' : 'not_needed',
    purpose: '仅用于后续视觉理解分流；不是画面内容或重要性的判断。',
    threshold: { ocr_confidence_lt: VISUAL_REVIEW_CONFIDENCE_THRESHOLD },
    items
  };
}

function renderReport({ job, assets, failures, ocrResults, visualReview, validation }) {
  const result = job.result;
  const lines = [
    '# 图文 OCR 证据报告',
    '',
    `- 任务：${job.eventId}`,
    `- 作品 ID：${result.aweme_id ?? job.awemeId ?? '未知'}`,
    `- 标准链接：${result.canonical_url ?? '未生成'}`,
    `- 作者：${cleanText(result.author) || '未知'}`,
    `- 图片下载：${assets.length} 成功，${failures.length} 失败`,
    '- OCR：RapidOCR · ONNX Runtime · CPU',
    `- OCR 文本图片：${ocrResults.filter((item) => item.text).length}/${ocrResults.length}`,
    ...(Number.isFinite(ocrResults[0]?.batch_elapsed_seconds) ? [`- RapidOCR 批处理耗时：${ocrResults[0].batch_elapsed_seconds} 秒`] : []),
    `- 证据校验：${validation.status === 'passed' ? '通过' : '失败'}`,
    '',
    '## 图片素材',
    ''
  ];
  for (const asset of assets) lines.push(`- ${asset.local_path} · ${asset.content_type} · ${asset.bytes} bytes · SHA-256 ${asset.sha256}`);
  for (const failure of failures) lines.push(`- 图片 ${failure.index} 下载失败：${failure.error}`);
  lines.push('', '## OCR 原文', '');
  for (const item of ocrResults) {
    lines.push(`### 图片 ${item.index}（置信度 ${item.confidence.toFixed(2)}）`, '', item.text || '未识别到可用文字', '');
  }
  if (visualReview.items.length) {
    lines.push('## 待视觉补充', '');
    for (const item of visualReview.items) {
      lines.push(`- ${item.local_path} · ${item.reason} · OCR 置信度 ${item.ocr_confidence.toFixed(2)}。当前未对画面内容或重要性作出判断。`);
    }
    lines.push('');
  }
  lines.push('> 素材签名地址未写入本报告；请在素材有效期内重新运行本步骤。', '');
  return lines.join('\n');
}

/**
 * Downloads a captured gallery's fresh image assets and creates an inspectable
 * local OCR evidence packet.  It never writes signed media URLs to disk.
 */
export async function processGalleryEvidence({
  job,
  outputDirectory,
  resumeFromDirectory = null,
  retryStage = null,
  fetchImpl = fetch,
  ocrRunner = null,
  onStage = async () => {}
}) {
  const images = selectedImageAssets(job);
  const target = path.resolve(outputDirectory);
  const assetsDirectory = path.join(target, 'assets');
  try {
    await access(path.join(target, 'evidence.json'));
    throw new Error('该任务已有 OCR 证据包；为避免混合两次素材，请先检查既有结果，不会覆盖。');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(assetsDirectory, { recursive: true });

  const assets = [];
  const failures = [];
  for (const [assetPosition, asset] of images.entries()) {
    try {
      const reused = canReuseGalleryStage(retryStage, 'image_download')
        ? await reuseImage({ asset, assetsDirectory, resumeFromDirectory })
        : null;
      if (reused) {
        assets.push(reused);
        continue;
      }
      await onStage({ stage: 'image_download_request', message: `正在请求第 ${assetPosition + 1}/${images.length} 张图片。` });
      await onStage({ stage: 'image_download_waiting', message: `正在等待第 ${assetPosition + 1}/${images.length} 张图片返回。` });
      await onStage({ stage: 'image_download', message: `正在下载第 ${assetPosition + 1}/${images.length} 张图片。` });
      assets.push(await downloadImage({ asset, assetsDirectory, fetchImpl }));
      await onStage({ stage: 'image_download_received', message: `已收到第 ${assetPosition + 1}/${images.length} 张图片。` });
    } catch (error) {
      failures.push({ index: asset.index, error: safeError(error) });
    }
  }
  if (assets.length === 0) throw new Error(`没有成功下载任何图片：${failures.map((item) => `图片 ${item.index} ${item.error}`).join('；')}`);

  const metadata = redactedMetadata(job);
  await writeFile(path.join(target, 'source-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  // A normal continuation intentionally reruns OCR; only an explicit
  // evidence-validation retry is allowed to reuse the saved OCR packet.
  let ocrResults = retryStage === 'evidence_validation'
    ? await reusableOcrResults(resumeFromDirectory)
    : null;
  if (!ocrResults) {
    let batchOutputs = [];
    await onStage({ stage: 'ocr_request', message: `正在准备 RapidOCR 图片识别，共 ${assets.length} 张。` });
    await onStage({ stage: 'ocr_waiting', message: `图片已提交给 RapidOCR，正在等待 ${assets.length} 张识别结果。` });
    await onStage({ stage: 'ocr', message: `正在用 RapidOCR 识别 ${assets.length} 张图片。` });
    if (!ocrRunner) {
      try {
        batchOutputs = await runRapidOcrBatch(assets.map((asset) => ({
          eventId: job.eventId,
          assetId: asset.local_path,
          localPath: asset.local_path,
          imagePath: path.join(target, asset.local_path)
        })));
      } catch (error) {
        batchOutputs = assets.map(() => ({ status: 'failed', regions: [], error: safeError(error) }));
      }
    }
    ocrResults = [];
    for (const [index, asset] of assets.entries()) {
      try {
        const output = ocrRunner
          ? await ocrRunner(path.join(target, asset.local_path))
          : batchOutputs[index];
        if (output?.status === 'failed') throw new Error(output.error || 'RapidOCR 识别失败');
        const regions = Array.isArray(output?.regions) ? output.regions : [];
        ocrResults.push({
          ...asset,
          text: cleanText(output?.text) || regions.map((region) => cleanText(region.text)).filter(Boolean).join('\n'),
          confidence: Number(output?.confidence) || (regions.length ? regions.reduce((sum, region) => sum + (Number(region.confidence) || 0), 0) / regions.length : 0),
          words: Number(output?.words) || regions.length,
          regions,
          image_width_px: output?.image_width_px ?? null,
          image_height_px: output?.image_height_px ?? null,
          batch_elapsed_seconds: output?.batch_elapsed_seconds ?? null,
          engine: ocrRunner ? (output?.engine || 'custom') : 'RapidOCR'
        });
      } catch (error) {
        ocrResults.push({ ...asset, text: '', confidence: 0, words: 0, regions: [], error: safeError(error), engine: 'RapidOCR' });
      }
    }
    await onStage({ stage: 'ocr_received', message: `图片 OCR 已完成，收到 ${ocrResults.length} 张结果。` });
  }
  const document = buildPacketDocument({ job, assets, ocrResults });
  const visualReview = buildVisualReview({ job, ocrResults });
  await onStage({ stage: 'evidence_validation', message: '图片文字识别完成，正在校验证据和素材文件。' });
  const structuralValidation = validateEvidenceDocument(document);
  const locatorValidation = await validateLocalEvidenceLocators(document, target);
  const validation = {
    status: structuralValidation.status === 'passed' && locatorValidation.status === 'passed' ? 'passed' : 'failed',
    structural: structuralValidation,
    local_locators: locatorValidation
  };
  await onStage({ stage: 'evidence_validated', message: validation.status === 'passed' ? '识别结果和素材已通过证据校验。' : '证据校验未通过，已保留失败详情供重试。' });
  await writeFile(path.join(target, 'evidence.json'), `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(target, 'validation.json'), `${JSON.stringify(validation, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(target, 'visual-review.json'), `${JSON.stringify(visualReview, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(target, 'ocr-results.json'), `${JSON.stringify(ocrResults, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(path.join(target, 'ocr-report.md'), renderReport({ job, assets, failures, ocrResults, visualReview, validation }), { encoding: 'utf8', flag: 'wx' });
  return {
    status: failures.length ? 'partial' : 'captured',
    output_directory: target,
    images_downloaded: assets.length,
    images_failed: failures.length,
    ocr_text_images: ocrResults.filter((item) => item.text).length,
    visual_review_images: visualReview.items.length,
    validation: validation.status
  };
}
