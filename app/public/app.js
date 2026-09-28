const app = document.querySelector('#app');
const url = new URL(location.href);
const h = (tag, className, value) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = String(value);
  return node;
};
const safeUrl = (value) => {
  if (typeof value !== 'string') return null;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try { const parsed = new URL(value); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : null; }
  catch { return null; }
};
const link = (label, target, className = '') => {
  const a = h('a', className, label);
  a.href = target;
  if (/^https?:/.test(target)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  return a;
};
const heading = (eyebrow, title, summary, back) => {
  const box = h('section', 'section-head');
  if (back) box.append(link('← 返回', back, 'back'));
  box.append(h('div', 'eyebrow', eyebrow), h('h1', '', title));
  if (summary) box.append(h('p', '', summary));
  return box;
};
const coverOf = (card) => safeUrl(card.media?.coverUrl || card.media?.imageUrls?.[0]);
const cardPreview = (card) => {
  const a = link('', `/interaction?source=${encodeURIComponent(card.collection?.id || card.sources?.[0]?.id || card.id)}&card=${encodeURIComponent(card.id)}`, 'note-card');
  const cover = coverOf(card);
  if (cover) { const img = h('img'); img.src = cover; img.alt = ''; img.loading = 'lazy'; a.append(img); }
  a.append(h('span', 'pill', card.type || '卡片'), h('h2', '', card.title || '未命名卡片'));
  const excerpt = card.featuredContent?.[0]?.value || card.content?.[0]?.value || '';
  if (excerpt) a.append(h('p', '', excerpt));
  return a;
};
function renderHome(library) {
  app.replaceChildren();
  const hero = h('section', 'hero');
  hero.append(h('div', 'eyebrow', 'MY LIBRARY'), h('h1', '', '按主题，重新发现收藏'), h('p', '', '打开一个主题，再看其中的卡片。正在解析的内容单独放在“收藏解析”。'));
  app.append(hero);
  const grid = h('section', 'folder-grid');
  for (const topic of library.topics || []) {
    const a = link('', `/topic?topic=${encodeURIComponent(topic.id)}`, 'folder');
    const content = h('div'); content.append(h('h2', '', topic.title), h('p', '', `${topic.totalCount ?? topic.cardIds?.length ?? 0} 张卡片`));
    a.append(content, h('span', 'small', '打开主题 ↗')); grid.append(a);
  }
  app.append(grid.childElementCount ? grid : h('div', 'empty', '还没有主题。收藏并发布第一张卡片后会出现在这里。'));
}
function renderTopic(library, topicId) {
  const topic = library.topics.find((item) => item.id === topicId);
  if (!topic) throw new Error('找不到这个主题');
  app.replaceChildren(heading('TOPIC', topic.title, `${topic.totalCount ?? 0} 张卡片`, '/'));
  const cards = library.cards.filter((card) => card.topics?.some((item) => item.id === topicId) && card.origin !== 'intake_placeholder');
  const groups = new Map();
  for (const card of cards) {
    const key = card.collection?.id || card.sources?.[0]?.id || card.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }
  const grid = h('section', 'card-grid');
  for (const group of groups.values()) {
    const first = group[0];
    const tile = cardPreview(first);
    if (group.length > 1) {
      tile.href = `/interaction?source=${encodeURIComponent(first.collection?.id || first.sources?.[0]?.id || first.id)}&topic=${encodeURIComponent(topicId)}`;
      tile.append(h('span', 'small', `${group.length} 张卡片 · 打开卡片组`));
    }
    grid.append(tile);
  }
  app.append(grid.childElementCount ? grid : h('div', 'empty', '此主题暂时没有卡片。'));
}
function detailBlock(label, value) {
  const box = h('section', 'detail-block');
  box.append(h('h2', '', label), h('p', '', value));
  return box;
}
function renderCard(card, back) {
  app.replaceChildren();
  const detail = h('article', 'card-detail');
  detail.append(heading(card.type || 'CARD', card.title || '未命名卡片', card.topics?.map((item) => item.title).join(' · '), back));
  const cover = coverOf(card);
  if (cover) { const img = h('img', 'detail-cover'); img.src = cover; img.alt = `${card.title || '卡片'}配图`; detail.append(img); }
  const actions = h('div', 'actions');
  const source = safeUrl(card.sources?.[0]?.originalUrl);
  if (source) actions.append(link('打开来源 ↗', source, 'action'));
  const prompt = card.content?.find((field) => field.kind === 'prompt' && field.value)?.value;
  if (prompt) {
    const button = h('button', 'action', '复制提示词'); button.type = 'button';
    button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(prompt); button.textContent = '已复制'; } catch { button.textContent = '复制失败，请手动选择文字'; } });
    actions.append(button);
  }
  detail.append(actions);
  for (const field of card.content || []) if (field.value) detail.append(detailBlock(field.label || '内容', field.value));
  for (const path of card.paths || []) if (path.steps?.length) detail.append(detailBlock(path.title || '操作步骤', path.steps.map((step, i) => `${i + 1}. ${typeof step === 'string' ? step : step.text || step.title || ''}`).join('\n')));
  for (const resource of card.resources || []) {
    const target = safeUrl(resource.url);
    if (target) detail.append(link(resource.label || '查看资源 ↗', target, 'action'));
  }
  const images = (card.media?.imageUrls || []).map(safeUrl).filter((item) => item && item !== cover);
  if (images.length) { const gallery = h('div', 'gallery'); for (const src of images) { const img = h('img'); img.src = src; img.alt = '卡片配图'; img.loading = 'lazy'; gallery.append(img); } detail.append(h('h2', 'section-label', '相关图片'), gallery); }
  app.append(detail);
}
function renderInteraction(library) {
  const source = url.searchParams.get('source');
  const selected = url.searchParams.get('card');
  const cards = library.cards.filter((card) => (card.collection?.id || card.sources?.[0]?.id || card.id) === source);
  const topic = url.searchParams.get('topic');
  const back = topic ? `/topic?topic=${encodeURIComponent(topic)}` : '/';
  if (selected) {
    const card = library.cards.find((item) => item.id === selected);
    if (!card) throw new Error('找不到这张卡片');
    renderCard(card, cards.length > 1 ? `/interaction?source=${encodeURIComponent(source || '')}&topic=${encodeURIComponent(topic || '')}` : back);
    return;
  }
  if (!cards.length) throw new Error('找不到这个卡片组');
  if (cards.length === 1) { renderCard(cards[0], back); return; }
  app.replaceChildren(heading('COLLECTION', cards[0].collection?.title || '来自同一收藏', `${cards.length} 张卡片`, back));
  const grid = h('section', 'card-grid');
  for (const card of cards) grid.append(cardPreview(card));
  app.append(grid);
}
async function manage(eventId, action, button) {
  if (action === 'dismiss' && !confirm('确定从待处理区删除这条收藏吗？已发布卡片不会被删除。')) return;
  button.disabled = true; button.textContent = '处理中…';
  try {
    const response = await fetch('/api/intake/manage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_id: eventId, action }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    location.reload();
  } catch (error) { button.disabled = false; button.textContent = action === 'retry' ? '重试' : '删除'; alert(error.message); }
}
function renderInbox(library) {
  const cards = library.cards.filter((card) => card.origin === 'intake_placeholder');
  app.replaceChildren(heading('PROCESSING', '收藏解析', '尚未发布的收藏、处理进度和失败项都在这里。', '/'));
  const list = h('div', 'inbox-list');
  for (const card of cards) {
    const item = h('article', 'inbox-item');
    item.append(h('h2', '', card.title), h('span', 'pill', card.processingState?.label || '正在处理'), h('p', '', card.processingState?.detail || ''), h('code', 'small', `事件 ID：${card.eventId || '未知'}`));
    const actions = h('div', 'actions');
    const source = safeUrl(card.sources?.[0]?.originalUrl); if (source) actions.append(link('打开来源 ↗', source, 'action'));
    if (['failed', 'retryable'].includes(card.status) && card.eventId) { const button = h('button', 'action', card.processingState?.retryLabel || '从失败处重试'); button.addEventListener('click', () => manage(card.eventId, 'retry', button)); actions.append(button); }
    if (card.eventId) { const button = h('button', 'action danger', '删除'); button.addEventListener('click', () => manage(card.eventId, 'dismiss', button)); actions.append(button); }
    item.append(actions); list.append(item);
  }
  app.append(list.childElementCount ? list : h('div', 'empty', '没有等待解析的收藏。'));
}
async function main() {
  try {
    const response = await fetch('/api/library');
    if (!response.ok) throw new Error(`卡片库暂不可用（HTTP ${response.status}）`);
    const library = await response.json();
    document.querySelector('#inbox-count').textContent = library.cards.filter((item) => item.origin === 'intake_placeholder').length || '';
    const isInbox = url.searchParams.get('view') === 'inbox';
    document.querySelector(`[data-nav="${isInbox ? 'inbox' : 'home'}"]`)?.setAttribute('aria-current', 'page');
    if (isInbox) renderInbox(library);
    else if (url.pathname.startsWith('/topic')) renderTopic(library, url.searchParams.get('topic'));
    else if (url.pathname.startsWith('/interaction')) renderInteraction(library);
    else renderHome(library);
  } catch (error) { app.replaceChildren(h('div', 'error', error?.message || '页面加载失败')); }
}
main();
