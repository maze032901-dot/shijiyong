import { readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync(new URL('../../app/public/card-types.json', import.meta.url), 'utf8'));
const allIntents = new Set(['function_entry', 'method_options', 'experience_judgement', 'prompt_use', 'concept_learning', 'visual_reference', 'general_retrieval']);
const seen = new Set();
for (const item of registry.types) {
  if (!/^[a-z][a-z0-9_]*$/.test(item.id) || seen.has(item.id) || !item.label || !item.description || !Array.isArray(item.intents) || !item.intents.length || item.intents.some((intent) => !allIntents.has(intent))) {
    throw new Error(`卡片类型目录无效：${item.id ?? '未命名'}`);
  }
  seen.add(item.id);
}
if (!seen.has('generic_unknown')) throw new Error('卡片类型目录必须保留 generic_unknown 兜底类型。');

export const cardTypes = Object.freeze(registry.types.map((item) => Object.freeze({ ...item, intents: Object.freeze([...item.intents]) })));
export const cardTypeIds = Object.freeze(cardTypes.map((item) => item.id));
export const cardTypeById = new Map(cardTypes.map((item) => [item.id, item]));
export const cardTypeLabel = (id) => cardTypeById.get(id)?.label ?? id;
export const cardTypeAllowsIntent = (id, intent) => cardTypeById.get(id)?.intents.includes(intent) ?? false;
export const cardTypePromptGuide = () => cardTypes.map((item) => `${item.id}（${item.label}：${item.description}；卡面意图 ${item.intents.join(' / ')}）`).join('；');
