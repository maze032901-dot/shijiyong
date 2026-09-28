import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { drainMobileCommands } from '../app/mobile-command-worker.mjs';

test('手机命令通道与接收队列分别使用发布和接收凭据', async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'hermes-command-credentials-'));
  const cloudConfig = {
    baseUrl: 'https://hermes.example.invalid',
    token: 'fictional-intake-token-0000000000001',
    mobilePublishToken: 'fictional-publish-token-000000000002'
  };
  const command = { id: '00000000-0000-4000-8000-000000000001', action: 'dismiss', eventId: 'fictional-event-001' };
  const calls = [];
  let claimCount = 0;
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, authorization: options.headers.Authorization });
    if (pathname === '/api/mac/mobile/commands/next') {
      claimCount += 1;
      return claimCount === 1 ? Response.json({ command }) : new Response(null, { status: 204 });
    }
    if (pathname === '/api/intake/dismiss') return Response.json({ event_id: command.eventId });
    if (pathname.endsWith('/result')) return Response.json({ ok: true });
    throw new Error(`未预期的请求：${pathname}`);
  };
  try {
    const drained = await drainMobileCommands({ projectDirectory, cloudConfig, fetchImpl });
    assert.equal(drained.count, 1);
    assert.deepEqual(calls.map((item) => [item.pathname, item.authorization]), [
      ['/api/mac/mobile/commands/next', `Bearer ${cloudConfig.mobilePublishToken}`],
      ['/api/intake/dismiss', `Bearer ${cloudConfig.token}`],
      [`/api/mac/mobile/commands/${command.id}/result`, `Bearer ${cloudConfig.mobilePublishToken}`],
      ['/api/mac/mobile/commands/next', `Bearer ${cloudConfig.mobilePublishToken}`]
    ]);
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
