import path from 'node:path';
import { processGalleryEvidence } from './mac-gallery-evidence.mjs';
import { processVideoEvidence } from './mac-video-evidence.mjs';

function safeError(error) {
  return String(error?.message ?? error ?? '未知错误')
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .slice(0, 240);
}

function capturedGalleryJob(outcome) {
  if (outcome?.kind !== 'processed') return null;
  if (outcome.complete?.status !== 'captured') return null;
  if (outcome.result?.media_kind !== 'gallery') return null;
  if (!outcome.job?.eventId) return null;
  return {
    ...outcome.job,
    status: 'captured',
    result: outcome.result
  };
}

/**
 * Runs only after F2 has already captured and returned a gallery.  It is a
 * local follow-up: an OCR failure must never alter the cloud intake status.
 */
export async function processCapturedGalleryEvidence(outcome, {
  projectDirectory,
  processor = processGalleryEvidence
} = {}) {
  const job = capturedGalleryJob(outcome);
  if (!job) return { kind: 'not_applicable' };
  const outputDirectory = path.join(projectDirectory, 'runtime', 'mac-intake', job.eventId);
  try {
    const result = await processor({ job, outputDirectory });
    return { kind: 'processed', eventId: job.eventId, result };
  } catch (error) {
    return { kind: 'failed', eventId: job.eventId, error: safeError(error) };
  }
}

/**
 * Dispatches one freshly captured item to its local evidence producer.  The
 * cloud result has already been accepted before this function runs.
 */
export async function processCapturedEvidence(outcome, {
  projectDirectory,
  outputDirectory = null,
  resumeFromDirectory = null,
  retryStage = null,
  galleryProcessor = processGalleryEvidence,
  videoProcessor = processVideoEvidence,
  fetchImpl = fetch,
  onStage = async () => {}
} = {}) {
  if (outcome?.kind !== 'processed' || outcome.complete?.status !== 'captured' || !outcome.job?.eventId) {
    return { kind: 'not_applicable' };
  }
  const mediaKind = outcome.result?.media_kind;
  const processor = mediaKind === 'gallery' ? galleryProcessor : mediaKind === 'video' ? videoProcessor : null;
  if (!processor) return { kind: 'not_applicable' };
  const job = { ...outcome.job, status: 'captured', result: outcome.result };
  const evidenceDirectory = outputDirectory || path.join(projectDirectory, 'runtime', 'mac-intake', job.eventId);
  try {
    const result = await processor({ job, outputDirectory: evidenceDirectory, resumeFromDirectory, retryStage, fetchImpl, onStage });
    return { kind: 'processed', mediaKind, eventId: job.eventId, result };
  } catch (error) {
    return { kind: 'failed', mediaKind, eventId: job.eventId, error: safeError(error) };
  }
}
