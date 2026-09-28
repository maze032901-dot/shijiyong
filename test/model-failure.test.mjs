import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { processEvidenceToCard } from '../app/fresh-card-automation.mjs';

test('模型失败保留证据，不发布空白卡片', async () => {
  const projectDirectory = await mkdtemp(path.join(os.tmpdir(), 'hermes-model-test-'));
  try {
    const evidencePath = path.join(projectDirectory, 'evidence.json');
    await writeFile(evidencePath, JSON.stringify({ source: { id: 'fictional-source-006' }, items: [] }));
    const result = await processEvidenceToCard({
      projectDirectory, evidencePath, enabled: true,
      provider: { name: 'fictional-model', endpoint: 'https://example.org/v1/chat/completions', model: 'fictional-model', apiKey: 'fictional-test-key' },
      evaluate: async () => { throw new Error('synthetic model unavailable'); }
    });
    assert.equal(result.kind, 'failed');
    assert.equal(result.stage, 'candidate');
    assert.match(result.error, /synthetic model unavailable/);
  } finally { await rm(projectDirectory, { recursive: true, force: true }); }
});
