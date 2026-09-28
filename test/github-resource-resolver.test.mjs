import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyVerifiedGithubResources, verifyGithubResources } from '../app/github-resource-resolver.mjs';

test('仅核实精确仓库及其同作者仓库，失败时不编造网址', async () => {
  const cards = [{ title: '虚构流程工具', resources: [
    { label: 'sample-owner/FlowKit（GitHub 项目）', availability: 'unverified', type: 'other' },
    { label: 'FlowKit-Plugins（官方插件仓库）', availability: 'unverified', type: 'other' },
    { label: 'FlowKit-Unknown（社区仓库）', availability: 'unverified', type: 'other' },
    { label: '提到的其他工具', availability: 'unverified', type: 'other' }
  ] }];
  const requested = [];
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    requested.push(path);
    if (path.endsWith('FlowKit-Unknown')) return new Response(null, { status: 404 });
    const repo = path.split('/').at(-1);
    return Response.json({ full_name: `sample-owner/${repo}`, html_url: `https://github.com/sample-owner/${repo}` });
  };
  const verified = await verifyGithubResources({ cards, fetchImpl });
  assert.equal(verified.length, 2);
  assert.deepEqual(requested, [
    '/repos/sample-owner/FlowKit', '/repos/sample-owner/FlowKit-Plugins', '/repos/sample-owner/FlowKit-Unknown'
  ]);
  const enriched = applyVerifiedGithubResources(cards[0], verified);
  assert.equal(enriched[0].url, 'https://github.com/sample-owner/FlowKit');
  assert.equal(enriched[1].availability, 'available');
  assert.equal(enriched[2].url, undefined);
  assert.equal(enriched[3].url, undefined);
});

test('错误仓库身份、无明确作者及关闭联网核实时都保留待核实', async () => {
  const cards = [{ title: '虚构工具', resources: [
    { label: 'sample-owner/FlowKit（GitHub）', availability: 'unverified' },
    { label: 'Sibling-Plugins（插件仓库）', availability: 'unverified' }
  ] }];
  const fetchImpl = async () => Response.json({ full_name: 'other-owner/FlowKit', html_url: 'https://github.com/other-owner/FlowKit' });
  assert.deepEqual(await verifyGithubResources({ cards, fetchImpl }), []);
  assert.deepEqual(await verifyGithubResources({ cards, fetchImpl, enabled: false }), []);
});
