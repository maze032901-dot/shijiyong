import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('公开网页主脚本可解析，不会停在读取卡片库', () => {
  const script = path.join(projectDirectory, 'app', 'public', 'app.js');
  const checked = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
});
