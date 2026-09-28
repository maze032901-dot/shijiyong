import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const port = async () => new Promise((resolve, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const selected = server.address().port;
    server.close(() => resolve(selected));
  });
});

test('空白服务可启动，三种凭据隔离，发布卡片和图片能在网页读取', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hermes-cloud-flow-'));
  const sourceRoot = path.resolve(import.meta.dirname, '..');
  await cp(path.join(sourceRoot, 'app'), path.join(directory, 'app'), { recursive: true });
  await cp(path.join(sourceRoot, 'runner'), path.join(directory, 'runner'), { recursive: true });
  const selectedPort = await port();
  const base = `http://127.0.0.1:${selectedPort}`;
  const intake = 'fictional-intake-token-0000000000001';
  const mobile = 'fictional-mobile-token-0000000000002';
  const publish = 'fictional-publish-token-000000000003';
  const child = spawn(process.execPath, ['app/server.mjs'], {
    cwd: directory,
    env: { ...process.env, PORT: String(selectedPort), BIND_HOST: '127.0.0.1', HERMES_DATA_DIR: directory,
      HERMES_INTAKE_TOKEN: intake, HERMES_MOBILE_TOKEN: mobile, HERMES_MOBILE_PUBLISH_TOKEN: publish, NODE_NO_WARNINGS: '1' },
    stdio: 'ignore'
  });
  const request = (url, token, options = {}) => fetch(`${base}${url}`, {
    ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) }
  });
  try {
    let ready = false;
    for (let tries = 0; tries < 80; tries++) {
      try { if ((await request('/api/health')).ok) { ready = true; break; } } catch { /* starting */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, '服务未能启动');
    assert.equal((await request('/api/mobile/v1/library', intake)).status, 401);
    assert.equal((await request('/api/mobile/v1/library', mobile)).status, 200);
    const bytes = Buffer.from('fictional-image-only');
    const mediaId = `${createHash('sha256').update(bytes).digest('hex')}.png`;
    assert.equal((await request(`/api/mac/mobile/media/${mediaId}`, publish, { method: 'PUT', body: bytes })).status, 201);
  const publication = { sourceId: 'fictional-source-005', cards: [{ id: 'fictional-card-005', type: 'prompt', title: '虚构提示词', status: 'ready',
      topics: [{ id: 'fictional-topic', title: '测试主题' }], content: [{ label: 'Prompt', kind: 'prompt', value: 'A fictional prompt' }],
      sources: [{ id: 'fictional-source-005', title: '虚构来源', originalUrl: 'https://example.org/source' }],
      media: { coverUrl: `/api/mobile/v1/media/${mediaId}`, imageUrls: [`/api/mobile/v1/media/${mediaId}`] } }] };
    assert.equal((await request('/api/mac/mobile/publications/fictional-source-005', publish, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(publication)
    })).status, 200);
    const library = await (await request('/api/library')).json();
    assert.equal(library.cards.length, 1);
    assert.equal(library.cards[0].media.coverUrl, `/web-media/${mediaId}`);
    assert.equal(library.topics[0].title, '测试主题');
    assert.deepEqual(Buffer.from(await (await request(`/web-media/${mediaId}`)).arrayBuffer()), bytes);
    assert.equal((await request('/topic?topic=fictional-topic')).status, 200);
    assert.equal((await request('/interaction?source=fictional-source-005')).status, 200);
    assert.equal((await request(`/api/mobile/v1/media/${mediaId}`)).status, 401);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
