import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { appendEvidenceItems } from './evidence-contract.mjs';
import {
  DEFAULT_SUPPLEMENT_MAX_CANDIDATES,
  localPathForEvidence,
  supplementKey
} from './evidence-units.mjs';
import { runRapidOcrBatch } from '../../app/rapidocr-runner.mjs';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeId(value) {
  return String(value).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

function imageAsset(item) {
  return item?.kind === 'asset' && ['image', 'video_frame'].includes(text(item.locator?.asset_kind));
}

function existingSynchronousImage(evidenceDocument, interval) {
  return (evidenceDocument.items || []).find((item) => {
    if (!imageAsset(item)) return false;
    const point = finite(item.locator?.timestamp_seconds);
    return point !== null && point >= interval.start_seconds && point <= interval.end_seconds;
  }) || null;
}

export async function runSupplementOcr(imagePath, { batchRunner = runRapidOcrBatch } = {}) {
  const [result] = await batchRunner([{ imagePath, jobId: 'supplement-ocr' }]);
  if (!result || result.status === 'failed') {
    throw new Error(`RapidOCR 补采识别失败：${result?.error || '没有返回结果'}`);
  }
  const regions = Array.isArray(result.regions) ? result.regions : [];
  const recognized = regions.filter((region) => text(region?.text));
  const scores = recognized.map((region) => finite(region.confidence)).filter((score) => score !== null);
  return {
    text: recognized.map((region) => text(region.text)).join('\n'),
    confidence: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0,
    engine: result.engine || 'RapidOCR',
    regions: recognized
  };
}

async function runProcess(executable, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${executable} 退出码 ${code}：${stderr.trim()}`)));
  });
}

export async function extractFrameAt({ videoPath, timestampSeconds, outputPath, cwd = process.cwd(), spawnImpl = spawn }) {
  await new Promise((resolve, reject) => {
    const child = spawnImpl(process.env.HERMES_FFMPEG_PATH || 'ffmpeg', [
      '-nostdin', '-v', 'error', '-n', '-ss', String(Math.max(0, timestampSeconds)), '-i', videoPath,
      '-frames:v', '1', '-q:v', '2', outputPath
    ], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`补采抽帧失败（退出码 ${code}）：${stderr.trim()}`)));
  });
  const info = await stat(outputPath);
  if (info.size === 0) throw new Error('补采得到空图片');
  return { actual_timestamp_seconds: timestampSeconds };
}

export async function supplementAsrGap({
  evidenceDocument,
  sourceDirectory,
  asrEvidenceId,
  outputDirectory = sourceDirectory,
  frameExtractor = extractFrameAt,
  ocrRunner = runSupplementOcr,
  priorRecords = [],
  maxCandidates = DEFAULT_SUPPLEMENT_MAX_CANDIDATES,
  configVersion = 'v1'
}) {
  const asr = (evidenceDocument?.items || []).find((item) => item?.id === asrEvidenceId && item.kind === 'asr');
  const interval = asr ? {
    start_seconds: finite(asr.locator?.start_seconds),
    end_seconds: finite(asr.locator?.end_seconds)
  } : null;
  const base = { asr_evidence_id: asrEvidenceId, config_version: configVersion, requested: true };
  if (!asr || !interval || interval.start_seconds === null || interval.end_seconds === null || interval.end_seconds < interval.start_seconds) {
    return { status: 'failed', evidenceDocument, records: [{ ...base, status: 'failed', code: 'invalid_asr_interval', note: 'ASR 缺少有效起止时间。' }] };
  }
  if (evidenceDocument.media?.kind !== 'video') {
    return { status: 'not_applicable', evidenceDocument, records: [{ ...base, status: 'not_applicable', code: 'not_video', note: '只有视频 evidence 才能按 ASR 时间补采画面。' }] };
  }
  const key = supplementKey({ sourceId: evidenceDocument.source?.id, asrEvidenceId, configVersion });
  const hasPersistedSupplement = (evidenceDocument.items || []).some((item) => item?.locator?.supplement_record_key === key);
  if (hasPersistedSupplement && priorRecords.some((record) => record?.key === key || (record?.asr_evidence_id === asrEvidenceId && record?.config_version === configVersion))) {
    return { status: 'already_processed', evidenceDocument, records: [{ ...base, key, status: 'already_processed' }] };
  }
  const existing = existingSynchronousImage(evidenceDocument, interval);
  if (existing) {
    return {
      status: 'reused_existing',
      evidenceDocument,
      records: [{ ...base, key, status: 'reused_existing', image_evidence_id: existing.id, actual_timestamp_seconds: existing.locator.timestamp_seconds }]
    };
  }

  const videoAsset = (evidenceDocument.items || []).find((item) => item?.kind === 'asset' && item.locator?.asset_kind === 'video');
  const videoPath = localPathForEvidence(sourceDirectory, videoAsset?.locator?.local_path);
  if (!videoPath) {
    return { status: 'failed', evidenceDocument, records: [{ ...base, key, status: 'failed', code: 'video_unavailable', note: '缺少可读取的本地原视频。ASR 保留，未伪造截图。' }] };
  }

  await mkdir(path.join(outputDirectory, 'supplement'), { recursive: true });
  const middle = (interval.start_seconds + interval.end_seconds) / 2;
  const rawCandidates = [middle, interval.start_seconds, interval.end_seconds];
  const timestamps = [...new Set(rawCandidates.map((value) => Number(value.toFixed(3))))].slice(0, Math.max(1, Math.min(3, maxCandidates)));
  let nextDocument = evidenceDocument;
  const records = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const requested = timestamps[index];
    const baseStem = `supplement-${safeId(asrEvidenceId)}-${String(index + 1).padStart(2, '0')}`;
    let stem = baseStem;
    let absolutePath = path.join(outputDirectory, 'supplement', `${stem}.jpg`);
    let repairSuffix = 1;
    while (true) {
      try {
        await access(absolutePath);
        stem = `${baseStem}-repair-${String(repairSuffix).padStart(2, '0')}`;
        absolutePath = path.join(outputDirectory, 'supplement', `${stem}.jpg`);
        repairSuffix += 1;
      } catch (error) {
        if (error?.code === 'ENOENT') break;
        throw error;
      }
    }
    const relativePath = path.posix.join('supplement', `${stem}.jpg`);
    try {
      const extraction = await frameExtractor({ videoPath, timestampSeconds: requested, outputPath: absolutePath, sourceDirectory, cwd: sourceDirectory });
      const actual = finite(extraction?.actual_timestamp_seconds) ?? requested;
      const bytes = (await stat(absolutePath)).size;
      const imageId = `asset-${stem}`;
      const ocrId = `ocr-${stem}`;
      const imageItem = {
        id: imageId,
        kind: 'asset',
        source_id: evidenceDocument.source.id,
        locator: {
          asset_kind: 'video_frame',
          local_path: relativePath,
          content_type: 'image/jpeg',
          bytes,
          timestamp_seconds: actual,
          video_path: videoAsset.locator.local_path,
          supplement_for_asr: asrEvidenceId,
          supplement_record_key: key
        },
        confidence: 1,
        sha256: sha256(await readFile(absolutePath))
      };
      let ocrItem = null;
      let ocrStatus = 'empty';
      try {
        const result = await ocrRunner(absolutePath);
        const ocrText = text(result?.text);
        if (ocrText) {
          ocrStatus = 'text';
          ocrItem = {
            id: ocrId,
            kind: 'ocr',
            source_id: evidenceDocument.source.id,
            text: ocrText,
            locator: {
              local_path: relativePath,
              timestamp_seconds: actual,
              occurrences: [actual],
              video_path: videoAsset.locator.local_path,
              source_image_ref: imageId,
              engine: result?.engine || 'RapidOCR',
              regions: result?.regions || [],
              supplement_for_asr: asrEvidenceId,
              supplement_record_key: key
            },
            confidence: Math.max(0, Math.min(1, Number(result?.confidence) || 0)),
            sha256: sha256(ocrText)
          };
        }
      } catch (error) {
        ocrStatus = 'failed';
        records.push({ ...base, key, status: 'ocr_failed', requested_timestamp_seconds: requested, actual_timestamp_seconds: actual, image_evidence_id: imageId, error: String(error?.message || error).slice(0, 300) });
      }
      nextDocument = appendEvidenceItems(nextDocument, ocrItem ? [imageItem, ocrItem] : [imageItem]);
      records.push({ ...base, key, status: 'captured', requested_timestamp_seconds: requested, actual_timestamp_seconds: actual, image_evidence_id: imageId, ocr_evidence_id: ocrItem?.id || null, ocr_status: ocrStatus, ocr_empty_is_preserved: ocrStatus === 'empty' });
      return { status: 'captured', evidenceDocument: nextDocument, records };
    } catch (error) {
      records.push({ ...base, key, status: 'frame_failed', requested_timestamp_seconds: requested, error: String(error?.message || error).slice(0, 300) });
    }
  }
  return { status: 'failed', evidenceDocument: nextDocument, records };
}
