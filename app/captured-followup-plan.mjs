import { access } from 'node:fs/promises';
import path from 'node:path';
import { resolveRetryStage } from './retry-stage.mjs';

async function exists(filePath) {
  try { await access(filePath); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

/** A second cloud capture must never overwrite the first local evidence directory. */
export async function planCapturedFollowUp({ projectDirectory, job, retryStamp = new Date().toISOString().replace(/[:.]/g, '-') }) {
  const plan = await resolveRetryStage({ projectDirectory, job: { ...job, status: 'captured' }, localStatus: { status: 'failed' } });
  if (plan.kind === 'completed' || plan.kind === 'card') return plan;
  if (plan.kind !== 'evidence') throw new Error(plan.reason || '无法确定本机续跑步骤');
  const originalDirectory = path.join(projectDirectory, 'runtime', 'mac-intake', job.eventId);
  const outputDirectory = await exists(originalDirectory)
    ? path.join(projectDirectory, 'runtime', 'mac-intake-retries', job.eventId, retryStamp)
    : originalDirectory;
  return { ...plan, outputDirectory, retryStage: plan.retryStage ?? null };
}
