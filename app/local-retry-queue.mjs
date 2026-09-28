import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validEventId } from './retry-stage.mjs';

function directoryOf(projectDirectory) { return path.join(projectDirectory, 'runtime', 'local-retry-queue'); }
function fileOf(projectDirectory, eventId) {
  if (!validEventId(eventId)) throw new Error('无效收藏事件 ID');
  return path.join(directoryOf(projectDirectory), `${eventId}.json`);
}
async function read(filePath) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
async function put(projectDirectory, request) {
  const target = fileOf(projectDirectory, request.eventId);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
  return request;
}

export async function enqueueLocalRetry(projectDirectory, eventId, plan) {
  const existing = await read(fileOf(projectDirectory, eventId));
  if (['queued', 'processing'].includes(existing?.status)) return existing;
  return put(projectDirectory, {
    eventId, kind: plan.kind, evidenceDirectory: plan.evidenceDirectory ?? null,
    outputDirectory: plan.outputDirectory ?? null,
    candidateRunDirectory: plan.candidateRunDirectory ?? null,
    resumeFromDirectory: plan.resumeFromDirectory ?? null,
    retryStage: plan.retryStage ?? null,
    manualMedia: plan.manualMedia ?? null,
    status: 'queued', requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  });
}

export async function listQueuedLocalRetries(projectDirectory) {
  let entries;
  try { entries = await readdir(directoryOf(projectDirectory)); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const requests = [];
  for (const name of entries.filter((item) => /^[A-Za-z0-9._-]{6,128}\.json$/.test(item))) {
    const request = await read(path.join(directoryOf(projectDirectory), name));
    if (request?.status === 'queued') requests.push(request);
  }
  return requests.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export async function updateLocalRetry(projectDirectory, eventId, update) {
  const existing = await read(fileOf(projectDirectory, eventId));
  if (!existing) throw new Error('本机重试任务不存在');
  return put(projectDirectory, { ...existing, ...update, updatedAt: new Date().toISOString() });
}

export async function getLocalRetry(projectDirectory, eventId) {
  return read(fileOf(projectDirectory, eventId));
}

export async function recoverLocalRetries(projectDirectory) {
  let entries;
  try { entries = await readdir(directoryOf(projectDirectory)); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  for (const name of entries.filter((item) => /^[A-Za-z0-9._-]{6,128}\.json$/.test(item))) {
    const request = await read(path.join(directoryOf(projectDirectory), name));
    if (request?.status === 'processing') await updateLocalRetry(projectDirectory, request.eventId, { status: 'queued' });
  }
}
