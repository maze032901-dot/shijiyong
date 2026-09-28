import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { currentMobilePublicationIds, syncAllMobilePublications } from '../app/mobile-publisher.mjs';
import { CURRENT_GENERATION_RULES } from '../app/public/topic-presentation.js';

test('云端短暂不可用后可从本地正式发布包补同步', async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'hermes-mobile-resync-'));
  const sourceId = 'fictional-source-006';
  const publicationDirectory = path.join(projectDirectory, 'runtime/card-library/published');
  const catalogDirectory = path.join(projectDirectory, 'app/public');
  await mkdir(publicationDirectory, { recursive: true });
  await mkdir(catalogDirectory, { recursive: true });
  await writeFile(path.join(catalogDirectory, 'topic-catalog.json'), JSON.stringify({ topics: [
    { id: 'interface', title: '界面与交互', icon: 'folder', keywords: ['界面'] }
  ] }));
  await writeFile(path.join(publicationDirectory, `${sourceId}.json`), JSON.stringify({
    source_id: sourceId, generation_rules_version: CURRENT_GENERATION_RULES,
    published_at: '2026-01-01T00:00:00.000Z', fixture: {
      source: { id: sourceId, title: '虚构作品', source_url: 'https://example.org/work' },
      topics: [{ id: 'interface', title: '界面与交互' }],
      cards: [{ id: 'fictional-card-006', title: '虚构卡片', type: 'knowledge', status: 'ready',
        topic_ids: ['interface'], content_fields: [{ label: '重点', value: '虚构内容', kind: 'text' }],
        image_ids: [], resources: [], actions: [] }]
    }
  }));
  const config = { baseUrl: 'https://hermes.example.invalid', token: 'fictional-publish-token-000000000003' };
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(new URL(url).pathname, `/api/mac/mobile/publications/${sourceId}`);
    assert.equal(options.headers.Authorization, `Bearer ${config.token}`);
    assert.equal(JSON.parse(options.body).cards.length, 1);
    return calls === 1 ? new Response(null, { status: 503 }) : Response.json({ sourceId });
  };
  try {
    assert.deepEqual(await currentMobilePublicationIds(projectDirectory), [sourceId]);
    const first = await syncAllMobilePublications({ projectDirectory, config, fetchImpl });
    assert.equal(first.results[0].kind, 'failed');
    const second = await syncAllMobilePublications({ projectDirectory, config, fetchImpl });
    assert.equal(second.results[0].kind, 'synced');
    assert.equal(calls, 2);
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
