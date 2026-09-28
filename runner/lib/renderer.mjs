import fs from "node:fs";
import path from "node:path";
import { htmlEscape } from "./utils.mjs";
import { cardTypeLabel } from './card-type-registry.mjs';


const statusLabels = {
  ready: "内容完整",
  partial: "信息待补",
  needs_confirmation: "待确认",
  unavailable: "暂不可用"
};

function list(items, render) {
  if (!items || items.length === 0) return "";
  return "<ul>" + items.map((item) => "<li>" + render(item) + "</li>").join("") + "</ul>";
}

function fieldLabelMatches(field, pattern) {
  return pattern.test(String(field.label || ""));
}

const presentationLabels = {
  function_entry: "核心信息",
  method_options: "可选方法",
  experience_judgement: "实际体验",
  prompt_use: "可直接使用",
  concept_learning: "核心理解",
  visual_reference: "素材与参考",
  general_retrieval: "主要内容"
};

function legacyCardFace(fields) {
  const core = fields.find((field) => fieldLabelMatches(field, /核心功能|工具作用|功能描述|用途/)) || fields[0] || null;
  const restriction = fields.find((field) => field !== core && fieldLabelMatches(field, /当前限制|工具缺点|已知限制|限制|注意/)) || null;
  return {
    sections: core ? [{ title: "核心信息", fields: [core], paths: [], style: "primary" }] : [],
    restriction,
    details: fields.filter((field) => field !== core && field !== restriction),
    detailPaths: null,
    source: "legacy"
  };
}

export function cardFaceContent(card) {
  const fields = card.content_fields || [];
  const paths = card.paths || [];
  const presentation = card.presentation;
  if (!presentation || !presentationLabels[presentation.intent]) return legacyCardFace(fields);
  const selectedFieldLabels = new Set(presentation.featured_field_labels || []);
  const selectedPathTitles = new Set(presentation.featured_path_titles || []);
  const selectedFields = fields.filter((field) => selectedFieldLabels.has(field.label));
  const selectedPaths = paths.filter((item) => selectedPathTitles.has(item.title));
  return {
    sections: [{
      title: presentationLabels[presentation.intent],
      fields: selectedFields,
      paths: selectedPaths,
      style: presentation.intent
    }],
    restriction: null,
    details: fields.filter((field) => !selectedFieldLabels.has(field.label)),
    detailPaths: paths.filter((item) => !selectedPathTitles.has(item.title)),
    source: "presentation"
  };
}

function faceSectionHtml(section) {
  const fields = list(section.fields, (field) =>
    "<strong>" + htmlEscape(field.label) + "</strong><span>" + htmlEscape(field.value) + "</span>"
  );
  const paths = list(section.paths, pathHtml);
  if (!fields && !paths) return "";
  return "<section class=\"face-section face-" + htmlEscape(section.style) + "\"><h4>" + htmlEscape(section.title) + "</h4>" + fields + paths + "</section>";
}

function resourceHtml(resource) {
  const label = htmlEscape(resource.type + "：" + resource.availability);
  if (resource.url) return "<a href=\"" + htmlEscape(resource.url) + "\" target=\"_blank\" rel=\"noreferrer\">" + label + "</a>";
  return label + (resource.note ? "<span>" + htmlEscape(resource.note) + "</span>" : "");
}

function pathHtml(pathItem) {
  return "<strong>" + htmlEscape(pathItem.title) + "</strong>" + list(pathItem.steps, (step) => htmlEscape(step));
}

function isSourceLink(resource) {
  return /原链接|原始来源|抖音视频/.test(String(resource.note || ""));
}

function sourceEntriesForCard(card, inputRecord) {
  const ids = [...new Set((card.citations || []).map((citation) => citation.source_id).filter(Boolean))];
  return ids.map((sourceId) => {
    if (sourceId !== inputRecord.source_id) return { id: sourceId, label: "来源 " + sourceId, url: null };
    const frontmatter = inputRecord.frontmatter || {};
    const label = [frontmatter.platform, frontmatter.author, frontmatter.publish_date].filter(Boolean).join(" · ") || inputRecord.title_from_note;
    return { id: sourceId, label, url: frontmatter.source || null };
  });
}

function sourceEntryHtml(entry) {
  const link = entry.url
    ? "<a href=\"" + htmlEscape(entry.url) + "\" target=\"_blank\" rel=\"noreferrer\">查看原视频</a>"
    : "";
  return "<span>" + htmlEscape(entry.label) + "</span>" + link;
}

function cardSourceHtml(card, inputRecord) {
  const entries = sourceEntriesForCard(card, inputRecord);
  if (entries.length === 0) return "";
  if (entries.length === 1) {
    return "<div class=\"card-source\"><strong>来源</strong>" + sourceEntryHtml(entries[0]) + "</div>";
  }
  return "<details class=\"card-sources\"><summary>来源（" + entries.length + "）</summary>" + list(entries, sourceEntryHtml) + "</details>";
}

function cardHtml(card, topics, inputRecord) {
  const topicNames = card.topic_ids.map((id) => topics.get(id) || id).join(" · ");
  const face = cardFaceContent(card);
  const faceSections = face.sections.map(faceSectionHtml).join("");
  const detailFields = list(face.details, (field) =>
    "<strong>" + htmlEscape(field.label) + "</strong><span>" + htmlEscape(field.value) + "</span>"
  );
  const missing = list(card.missing, (item) =>
    "<strong>缺少：" + htmlEscape(item.field) + "</strong><span>" + htmlEscape(item.reason) + "</span>"
  );
  const conflicts = list(card.identity_conflicts, (item) =>
    "<strong>待核实：" + htmlEscape(item.field) + "</strong><span>" + htmlEscape(item.candidates.join(" / ")) + "。" + htmlEscape(item.reason) + "</span>"
  );
  const actionResources = (card.resources || []).filter((resource) => resource.availability === "available" && resource.url && !isSourceLink(resource));
  const missingEntry = (card.resources || []).find((resource) => resource.availability === "missing" && new Set(["github", "website", "app_store", "plugin_page"]).has(resource.type));
  const resources = list((card.resources || []).filter((resource) => !isSourceLink(resource)), resourceHtml);
  const paths = list(face.detailPaths === null ? card.paths : face.detailPaths, pathHtml);
  return `
    <article class="card">
      <p class="layer-label">Card / 具体内容卡</p>
      <div class="meta"><span>${htmlEscape(cardTypeLabel(card.type))}</span><span>${htmlEscape(statusLabels[card.status] || card.status)}</span></div>
      <h3>${htmlEscape(card.title)}</h3>
      <p class="topic">归属主题：${htmlEscape(topicNames)}</p>
      ${faceSections}
      ${face.restriction ? "<p class=\"restriction\"><strong>" + htmlEscape(face.restriction.label) + "</strong><span>" + htmlEscape(face.restriction.value) + "</span></p>" : ""}
      ${actionResources.length ? "<div class=\"actions\">" + actionResources.map((resource) => "<a href=\"" + htmlEscape(resource.url) + "\" target=\"_blank\" rel=\"noreferrer\">打开资源</a>").join("") + "</div>" : ""}
      ${missingEntry ? "<p class=\"entry-missing\">项目入口：未找到</p>" : ""}
      ${cardSourceHtml(card, inputRecord)}
      <details>
        <summary>查看详情</summary>
        ${detailFields ? "<h4>补充内容</h4>" + detailFields : ""}
        ${paths ? "<h4>使用路径</h4>" + paths : ""}
        ${resources ? "<h4>资源与来源</h4>" + resources : ""}
        ${missing ? "<h4>暂缺信息</h4>" + missing : ""}
        ${conflicts ? "<h4>待核实</h4>" + conflicts : ""}
      </details>
    </article>`;
}

function topicHtml(topic, cards, topics, inputRecord) {
  return `
    <section class="topic-group">
      <header class="topic-header">
        <p class="layer-label">Topic / 主题</p>
        <h2>${htmlEscape(topic.title)}</h2>
        <p>这是找回内容时的聚合层；下面是属于它的具体内容卡。</p>
      </header>
      <div class="card-grid">${cards.map((card) => cardHtml(card, topics, inputRecord)).join("\n")}</div>
    </section>`;
}

function collectionHtml(collection, cardsById) {
  const members = (collection.member_card_ids || [])
    .map((id) => cardsById.get(id)?.title || id)
    .join(" · ");
  return `
    <section class="collection">
      <p class="layer-label">Source collection / 来源集合</p>
      <strong>${htmlEscape(collection.title)}</strong>
      <span>${htmlEscape(members || "未关联具体内容卡")}</span>
    </section>`;
}

export function renderPreview({ fixture, inputRecord, outputPath }) {
  const topics = new Map(fixture.topics.map((topic) => [topic.id, topic.title]));
  const cardsByPrimaryTopic = new Map(fixture.topics.map((topic) => [topic.id, []]));
  const ungroupedCards = [];
  fixture.cards.forEach((card) => {
    const primaryTopicId = card.topic_ids?.[0];
    if (cardsByPrimaryTopic.has(primaryTopicId)) cardsByPrimaryTopic.get(primaryTopicId).push(card);
    else ungroupedCards.push(card);
  });
  const topicGroups = fixture.topics
    .filter((topic) => cardsByPrimaryTopic.get(topic.id).length > 0)
    .map((topic) => topicHtml(topic, cardsByPrimaryTopic.get(topic.id), topics, inputRecord))
    .join("\n");
  const ungrouped = ungroupedCards.length > 0
    ? topicHtml({ title: "未归类主题" }, ungroupedCards, topics, inputRecord)
    : "";
  const cardsById = new Map(fixture.cards.map((card) => [card.id, card]));
  const collections = (fixture.collections || []).map((collection) => collectionHtml(collection, cardsById)).join("\n");
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>拾即用测试预览：${htmlEscape(fixture.source.title)}</title>
<style>
  :root { color: #25221f; background: #f5f2ec; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; }
  body { max-width: 780px; margin: 0 auto; padding: 36px 20px 72px; }
  .notice { background: #fff5d6; border: 1px solid #e5c56f; padding: 12px 14px; border-radius: 10px; color: #72551a; }
  h1 { font-size: 28px; margin: 28px 0 8px; } h2 { font-size: 21px; margin: 6px 0; } h3 { font-size: 19px; margin: 12px 0 6px; } h4 { font-size: 14px; margin: 18px 0 5px; color: #6b6359; }
  .source, .topic, .topic-header > p:not(.layer-label) { color: #6b6359; line-height: 1.5; }
  .grid { display: grid; gap: 24px; margin-top: 22px; } .topic-group { border-left: 4px solid #8072bf; padding-left: 16px; }
  .topic-header { margin: 0 0 12px; } .card-grid { display: grid; gap: 12px; }
  .card { background: #fff; padding: 22px; border-radius: 14px; box-shadow: 0 3px 14px #574b3c14; }
  .layer-label { color: #675a9c; font-size: 12px; font-weight: 700; letter-spacing: .04em; margin: 0 0 6px; }
  .meta { display: flex; gap: 8px; } .meta span { padding: 3px 8px; background: #ede7de; border-radius: 99px; font-size: 12px; color: #6b6359; }
  ul { margin: 6px 0; padding-left: 0; list-style: none; } li { display: grid; gap: 3px; padding: 8px 0; border-top: 1px solid #efece6; line-height: 1.45; }
  li strong { font-size: 14px; } li span { color: #4d4842; } a { color: #805d00; }
  .face-section { margin: 16px 0 10px; padding: 12px 14px; border-radius: 10px; background: #f7f5ff; border: 1px solid #e5e0f4; } .face-section h4 { margin: 0 0 6px; color: #514772; font-size: 13px; } .face-section ul { margin: 0; } .face-section li:first-child { border-top: 0; padding-top: 3px; } .face-section li:last-child { padding-bottom: 3px; } .face-experience_judgement { background: #eff7f6; border-color: #d5e9e5; } .face-experience_judgement h4 { color: #276359; }
  .restriction { display: grid; gap: 3px; padding: 10px 12px; margin: 10px 0; border-radius: 9px; background: #fff7e9; color: #634d25; } .restriction strong { font-size: 13px; color: #6b6359; }
  .entry-missing { color: #8a5e00; font-size: 14px; margin: 12px 0 0; } .actions { display: flex; gap: 8px; margin-top: 14px; } .actions a { background: #302856; color: #fff; padding: 8px 12px; border-radius: 8px; text-decoration: none; font-size: 14px; }
  .card-source { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-top: 14px; padding-top: 12px; border-top: 1px solid #efece6; color: #6b6359; font-size: 14px; } .card-source strong { color: #4d4842; }
  .card-sources { margin-top: 14px; border-top: 1px solid #efece6; padding-top: 12px; }
  details { margin-top: 16px; border-top: 1px solid #efece6; padding-top: 12px; } summary { cursor: pointer; color: #675a9c; font-weight: 650; }
  .collection { display: grid; gap: 4px; padding: 14px 16px; background: #eeeaf7; border-radius: 12px; color: #4e466c; } .collection span { color: #6a6380; font-size: 14px; }
  code { font-size: 12px; color: #6b6359; }
</style>
</head>
<body>
  <p class="notice">这是候选结构审核预览，用来区分主题、具体内容卡与来源集合；不是正式产品界面。</p>
  <h1>${htmlEscape(fixture.source.title)}</h1>
  <p class="source">证据快照：${htmlEscape(inputRecord.note_path)}<br><code>${htmlEscape(inputRecord.markdown_sha256)}</code></p>
  <main class="grid">${topicGroups}${ungrouped}${collections}</main>
</body>
</html>`;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, "utf8");
}
