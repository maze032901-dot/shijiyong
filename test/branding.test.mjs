import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('公开页面和 Android 预览版使用同一产品名称', () => {
  assert.equal(JSON.parse(read('package.json')).name, 'shijiyong-self-hosted-preview');
  assert.match(read('README.md'), /^# 拾即用 · 自部署技术预览/m);
  assert.match(read('app/public/index.html'), /<title>拾即用 · 我的收藏<\/title>/);
  assert.match(read('app/public/providers.html'), /<title>AI 供应商 · 拾即用<\/title>/);
  assert.match(read('android/app/src/main/res/values/strings.xml'), /<string name="app_name">拾即用<\/string>/);
  assert.match(read('android/app/src/debug/res/values/strings.xml'), /<string name="app_name">拾即用预览版<\/string>/);
});
