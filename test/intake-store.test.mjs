import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_CAPTURE_ATTEMPTS, openIntakeStore } from '../app/intake-store.mjs';

test('失败任务有界重试且不会阻塞新任务', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hermes-intake-test-'));
  const store = openIntakeStore(path.join(directory, 'queue.sqlite'));
  try {
    const older = 'fictional-event-001';
    const newer = 'fictional-event-002';
    store.enqueue({ eventId: older, sourceUrl: 'https://example.org/video/1001', trigger: 'test', savedAt: 1 });
    assert.equal(store.takeNextForMac()?.eventId, older);
    store.saveMacResult(older, { status: 'failed', retryable: true, error: 'synthetic network failure' });
    assert.equal(store.get(older).status, 'retryable');
    store.enqueue({ eventId: newer, sourceUrl: 'https://example.org/video/1002', trigger: 'test', savedAt: 2 });
    assert.equal(store.takeNextForMac()?.eventId, newer);
    store.saveMacResult(newer, { status: 'captured', media_kind: 'video', media_manifest: [{ kind: 'video', url: 'https://example.org/media.mp4' }] });
    for (let attempt = 2; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
      assert.equal(store.takeNextForMac({ at: '9999-01-01T00:00:00.000Z' })?.eventId, older);
      store.saveMacResult(older, { status: 'failed', retryable: true, error: 'synthetic network failure' });
    }
    assert.equal(store.get(older).status, 'failed');
    assert.equal(store.get(older).attempts, MAX_CAPTURE_ATTEMPTS);
    assert.equal(store.takeNextForMac({ at: '9999-01-01T00:00:00.000Z' }), null);
    assert.equal(store.requeue(older)?.status, 'queued');
    assert.equal(store.get(older).attempts, 0);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
