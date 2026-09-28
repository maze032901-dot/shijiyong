import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectResourceLinks } from '../app/public/resource-links.js';

test('项目入口仅显示已核实且可安全打开的 URL，与旧版条件一致', () => {
  const available = { label: '示例仓库', url: 'https://github.com/example/project', availability: 'available' };
  const resources = [
    available,
    { label: '只有名称', availability: 'unverified' },
    { label: '未核实地址', url: 'https://github.com/example/unknown', availability: 'unverified' },
    { label: '不安全地址', url: 'javascript:alert(1)', availability: 'available' }
  ];
  assert.deepEqual(projectResourceLinks(resources), [available]);
  assert.deepEqual(projectResourceLinks(resources.slice(1)), []);
});
