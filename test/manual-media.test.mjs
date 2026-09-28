import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { attachManualMedia, createManualMediaFetch, manualMediaResult } from '../app/manual-media.mjs';
import { getLocalRetry } from '../app/local-retry-queue.mjs';

test('补交图文绑定原事件并由本机受限读取，不产生新收藏', async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'hermes-manual-test-'));
  try {
    const image = path.join(projectDirectory, 'fictional.png');
    const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    await writeFile(image, bytes);
    const job = { eventId: 'fictional-event-003', status: 'failed', sourceUrl: 'https://example.org/note/1003' };
    const queued = await attachManualMedia({ projectDirectory, job, kind: 'gallery', files: [image] });
    assert.equal(queued.kind, 'evidence');
    assert.equal((await getLocalRetry(projectDirectory, job.eventId)).eventId, job.eventId);
    const result = manualMediaResult(job, queued);
    assert.equal(result.media_manifest[0].url, 'hermes-manual://asset/0');
    const localFetch = createManualMediaFetch(projectDirectory, job.eventId, queued.manualMedia);
    const response = await localFetch(result.media_manifest[0].url);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    await assert.rejects(localFetch('file:///etc/passwd'), /地址无效/);
    assert.deepEqual(await readFile(image), bytes);
  } finally { await rm(projectDirectory, { recursive: true, force: true }); }
});
