import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolvePublishedImage } from '../app/published-media.mjs';

test('正式图片只按已发布卡片的图片 ID 读取', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-published-test-'));
  try {
    const evidenceDir = path.join(root, 'runtime', 'mac-intake', 'fictional-event-004');
    const publishedDir = path.join(root, 'runtime', 'card-library', 'published');
    await mkdir(path.join(evidenceDir, 'assets'), { recursive: true });
    await mkdir(publishedDir, { recursive: true });
    const image = path.join(evidenceDir, 'assets', 'image-000.png');
    await writeFile(image, Buffer.from('fictional image'));
    await writeFile(path.join(evidenceDir, 'evidence.json'), JSON.stringify({ source: { id: 'fictional-source-004' }, items: [
      { id: 'asset-000', kind: 'asset', locator: { local_path: 'assets/image-000.png' } },
      { id: 'asset-secret', kind: 'asset', locator: { local_path: 'assets/image-000.png' } }
    ] }));
    await writeFile(path.join(publishedDir, 'fictional-source-004.json'), JSON.stringify({
      source_id: 'fictional-source-004', evidence_path: 'runtime/mac-intake/fictional-event-004/evidence.json',
      fixture: { cards: [{ image_ids: ['asset-000'] }] }
    }));
    assert.equal(await resolvePublishedImage(root, 'fictional-source-004', 'asset-000'), await realpath(image));
    assert.equal(await resolvePublishedImage(root, 'fictional-source-004', 'asset-secret'), null);
    assert.equal(await resolvePublishedImage(root, 'fictional-source-004', '../etc'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
