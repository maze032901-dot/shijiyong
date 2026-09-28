import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Mac 安装检查与备用抓取使用同一系统 Chrome', { skip: process.platform !== 'darwin' }, () => {
  const doctorScript = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [doctorScript, '--mode', 'mac', '--json'], {
    encoding: 'utf8'
  });
  const doctor = JSON.parse(result.stdout);
  const chrome = doctor.checks.find((check) => check.name === 'Google Chrome 备用抓取');
  assert.ok(chrome);
  const installed = existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(chrome.status, installed ? 'ok' : 'missing');
});
