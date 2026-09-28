import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cardMedia, verifiedSourceEvidencePath } from '../runner/lib/publish-fresh-candidate.mjs';

test('候选证据留在运行目录，正式图片引用原始证据目录', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'shijiyong-media-path-'));
  try {
    const sourceDirectory = path.join(root, 'runtime', 'mac-intake', 'fictional-event-007');
    const candidateDirectory = path.join(root, 'runtime', 'fresh-candidates', 'fictional-source-007');
    await mkdir(path.join(sourceDirectory, 'frames'), { recursive: true });
    await mkdir(candidateDirectory, { recursive: true });
    const evidence = { source: { id: 'fictional-source-007' }, media: { kind: 'video' }, items: [
      { id: 'asset-frame-001', kind: 'asset', locator: { asset_kind: 'video_frame', local_path: 'frames/frame-0000.jpg' } },
      { id: 'ocr-frame-001', kind: 'ocr', locator: { local_path: 'frames/frame-0000.jpg' } }
    ] };
    const sourceEvidence = path.join(sourceDirectory, 'evidence.json');
    const candidateEvidence = path.join(candidateDirectory, 'evidence.json');
    await writeFile(sourceEvidence, JSON.stringify(evidence));
    await writeFile(candidateEvidence, JSON.stringify(evidence));
    await writeFile(path.join(sourceDirectory, 'frames', 'frame-0000.jpg'), Buffer.from('fictional frame'));
    assert.deepEqual(cardMedia({ sourceId: evidence.source.id, evidence, evidencePath: candidateEvidence,
      rawCard: { citations: [{ evidence_id: 'ocr-frame-001' }] }, verifyLocal: true }).imageIds, []);
    const verified = verifiedSourceEvidencePath({ root, candidateEvidencePath: candidateEvidence, sourceEvidencePath: sourceEvidence });
    assert.equal(verified, sourceEvidence);
    const media = cardMedia({ sourceId: evidence.source.id, evidence, evidencePath: verified,
      rawCard: { citations: [{ evidence_id: 'ocr-frame-001' }] }, verifyLocal: true });
    assert.deepEqual(media.imageIds, ['ocr-frame-001']);
    assert.equal(media.coverUrl, '/published-media/fictional-source-007/ocr-frame-001');
    await writeFile(sourceEvidence, JSON.stringify({ ...evidence, source: { id: 'other-source' } }));
    assert.throws(() => verifiedSourceEvidencePath({ root, candidateEvidencePath: candidateEvidence,
      sourceEvidencePath: sourceEvidence }), /不一致/);
    assert.equal(JSON.parse(await readFile(candidateEvidence, 'utf8')).source.id, 'fictional-source-007');
  } finally { await rm(root, { recursive: true, force: true }); }
});
