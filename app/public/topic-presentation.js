export const CURRENT_GENERATION_RULES = 'hermes-generation-rules/2026-09-21-v4';

export const fixedThemes = [];

export function configureTopicCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.topics) || !catalog.topics.length) throw new Error('主题目录为空');
  const seen = new Set();
  const themes = catalog.topics.map((topic) => {
    if (!topic.id || !topic.title || !topic.icon || !Array.isArray(topic.keywords) || seen.has(topic.id)) {
      throw new Error(`主题目录无效：${topic.id ?? '未命名'}`);
    }
    seen.add(topic.id);
    return {
      id: topic.id,
      title: topic.title,
      subtitle: topic.subtitle || '',
      icon: topic.icon,
      aliases: topic.aliases || [],
      keys: topic.keywords
    };
  });
  fixedThemes.splice(0, fixedThemes.length, ...themes);
}

export const otherTheme = { id: 'other', title: '其他收藏', subtitle: '还没有归入现有主题的收藏。', icon: 'folder' };

const sourceOf = card => card.sources?.[0] ?? {};
export const sourceIdOf = card => sourceOf(card).originalUrl?.match(/\/(?:video|note)\/(\d+)(?:[/?#]|$)/)?.[1];
export const searchable = card => [card.title, card.type, ...(card.topics ?? []).map(topic => topic.title), ...(card.content ?? []).flatMap(field => [field.label, field.value]), ...(card.paths ?? []).flatMap(path => [path.title, ...(path.steps ?? [])]), sourceOf(card).title, sourceOf(card).author].join(' ').toLocaleLowerCase('zh-CN');

function topicTitle(card) {
  const title = card.topics?.find(topic => typeof topic?.title === 'string' && topic.title.trim())?.title;
  return title?.normalize('NFKC').replace(/\s+/g, ' ').trim() ?? null;
}

function dynamicId(title) { return `topic:${encodeURIComponent(title.toLocaleLowerCase('zh-CN'))}`; }

const normalised = (value) => String(value ?? '').normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, '');
function keywordMatches(value, keyword) {
  const term = normalised(keyword);
  if (/^[a-z0-9]+$/.test(term)) return new RegExp(`(^|[^a-z0-9])${term}(?=$|[^a-z0-9])`).test(value);
  return value.includes(term);
}

export function themeIdForCard(card) {
  // New compiled publications carry a verified catalog ID. Do not reclassify
  // them by source-specific exceptions or incidental title keywords.
  if (card.topicBinding === 'catalog') {
    const topic = card.topics?.[0];
    if (fixedThemes.some((theme) => theme.id === topic?.id)) return topic.id;
    if (typeof topic?.id === 'string' && topic.id.startsWith('topic_provisional_') && topicTitle(card)) return topic.id;
    return otherTheme.id;
  }
  if (card.generationRulesVersion !== CURRENT_GENERATION_RULES) return null;
  const title = topicTitle(card);
  // Classify by the model's topic, not incidental words in a card's detail.
  const text = normalised(title || [card.title, sourceOf(card).title].join(' '));
  const exact = fixedThemes.find((theme) => [theme.title, ...theme.aliases].some((alias) => normalised(alias) === text));
  if (exact) return exact.id;
  let best = null;
  for (const theme of fixedThemes) {
    const score = theme.keys.reduce((sum, key) => sum + (keywordMatches(text, key) ? 1 : 0), 0);
    if (score > (best?.score ?? 0)) best = { id: theme.id, score };
  }
  if (best) return best.id;
  return title ? dynamicId(title) : otherTheme.id;
}

export function availableThemes(cards) {
  const dynamic = new Map();
  const usedFixed = new Set();
  let hasOther = false;
  for (const card of cards) {
    const id = themeIdForCard(card);
    if (id === otherTheme.id) hasOther = true;
    if (fixedThemes.some((theme) => theme.id === id)) usedFixed.add(id);
    if (!(id?.startsWith('topic:') || id?.startsWith('topic_provisional_')) || dynamic.has(id)) continue;
    dynamic.set(id, {
      id,
      title: topicTitle(card),
      subtitle: '从新收藏里长出的主题。',
      icon: 'folder',
      dynamic: true
    });
  }
  return [...fixedThemes.filter((theme) => usedFixed.has(theme.id)), ...dynamic.values(), ...(hasOther ? [otherTheme] : [])];
}

export function themeForId(id, cards) {
  return fixedThemes.find(theme => theme.id === id) ?? availableThemes(cards).find(theme => theme.id === id) ?? null;
}
