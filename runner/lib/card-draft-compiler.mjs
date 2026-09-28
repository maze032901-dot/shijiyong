import { CARD_DRAFT_VERSION } from './card-draft-contract.mjs';
import { AI_CANDIDATE_SCHEMA_VERSION } from './candidate-response-contract.mjs';
import { cardTypeById } from './card-type-registry.mjs';

const claimKinds = new Set(['observed_fact', 'source_claim', 'source_opinion', 'ai_summary', 'externally_verified']);
const detailKinds = new Set(['text', 'prompt', 'list', 'image_reference']);
const resourceTypes = new Set(['github', 'website', 'app_store', 'plugin_page', 'prompt_text', 'image_file', 'other']);
const resourceStates = new Set(['available', 'missing', 'unverified']);
const defaultIntents = {
  tool: 'function_entry', skill: 'function_entry', prompt: 'prompt_use',
  method: 'method_options', image_asset: 'visual_reference', inspiration: 'visual_reference',
  knowledge: 'concept_learning', recommendation: 'experience_judgement', generic_unknown: 'general_retrieval'
};

function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function titleKey(value) { return text(value).normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, ''); }
function issue(code, path, message) { return { level: 'error', code, path, message }; }
function looksLikeIdentifier(value) { return /^[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+$/.test(value); }

function safePromptHeading(heading) {
  // A model-written prompt assembled from OCR may be useful without being a
  // verbatim transcript. The compiler cannot prove verbatim fidelity, so its
  // display label must not make that stronger claim.
  return heading.replace(/提示词原文/g, '整理后的提示词').replace(/原文/g, '整理版');
}

function detailText(value, kind) {
  if (typeof value === 'string') return value.trim();
  if (kind !== 'list' || !Array.isArray(value) || !value.length) return '';
  const lines = value.map((item, index) => {
    if (typeof item === 'string' && item.trim()) return `${index + 1}. ${item.trim()}`;
    if (!object(item)) return null;
    const parts = Object.entries(item).map(([label, entry]) => {
      if (!text(label) || !['string', 'number', 'boolean'].includes(typeof entry) || !String(entry).trim()) return null;
      return `${label}：${String(entry).trim()}`;
    });
    return parts.length && parts.every(Boolean) ? `${index + 1}. ${parts.join('；')}` : null;
  });
  return lines.every(Boolean) ? lines.join('\n') : '';
}

function detailSegments(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const segments = value.map((item) => object(item) && typeof item.text === 'string' && text(item.text)
    && (item.label === undefined || typeof item.label === 'string')
    ? { label: text(item.label), text: text(item.text) } : null);
  return segments.every(Boolean) ? segments : null;
}

function explicitResourceUrl(url, evidenceDocument) {
  const value = text(url);
  if (!/^https?:\/\//i.test(value) || value === text(evidenceDocument.source?.source_url)) return false;
  return (evidenceDocument.items || []).some((item) => typeof item.text === 'string' && item.text.includes(value));
}

/**
 * The model decides meaning; this compiler only binds that meaning to a
 * source, a controlled topic catalog and exact evidence items. It never
 * guesses a citation, resource URL, card type or missing substantive text.
 */
export function compileCardDraft({ draft, evidenceDocument, request, topicCatalog, requireSemanticSegments = false }) {
  const errors = [];
  const warnings = [];
  const audit = { compiler_version: 'hermes/card-draft-compiler/v1', field_owners: {
    model: ['cards', 'card.type', 'card.topic', 'card.front', 'card.details', 'card.availability'],
    program: ['source_id', 'topics', 'collections', 'presentation', 'citations', 'card_status', 'media_urls']
  }, evidence_handle_map: request?.evidence_handles || {}, card_bindings: [] };
  if (!object(draft) || draft.draft_version !== CARD_DRAFT_VERSION) {
    errors.push(issue('draft_version', 'draft_version', `草稿版本必须是 ${CARD_DRAFT_VERSION}。`));
    return { candidate: null, audit, errors, warnings };
  }
  if (!Array.isArray(draft.cards) || draft.cards.length === 0) {
    errors.push(issue('draft_cards', 'cards', '模型未输出任何有内容的卡片；本次来源进入待处理。'));
    return { candidate: null, audit, errors, warnings };
  }
  const sourceId = text(evidenceDocument?.source?.id);
  const topicById = new Map((topicCatalog?.topics || []).map((topic) => [topic.id, topic]));
  const topicByName = new Map();
  for (const topic of topicCatalog?.topics || []) {
    for (const name of [topic.title, ...(topic.aliases || [])]) topicByName.set(titleKey(name), topic);
  }
  const evidenceById = new Map((evidenceDocument?.items || []).map((item) => [item.id, item]));
  const handles = request?.evidence_handles || {};
  if (!sourceId || !object(handles) || !topicById.size) {
    errors.push(issue('draft_context', '$', '缺少来源、证据句柄或当前主题目录，不能编译草稿。'));
    return { candidate: null, audit, errors, warnings };
  }
  if (!object(draft.source_needs) || typeof draft.source_needs.visual !== 'boolean' || typeof draft.source_needs.lookup !== 'boolean') {
    errors.push(issue('draft_source_needs', 'source_needs', 'source_needs 必须提供 visual 和 lookup 布尔值。'));
  }

  const topics = [];
  const topicByTitle = new Map();
  const cardTitles = new Set();
  const cards = [];
  const bindTopic = (choice, path) => {
    if (!object(choice)) { errors.push(issue('draft_topic', path, '卡片必须选择一个已有主题或提出新主题。')); return null; }
    let selected;
    if (text(choice.existing_id)) {
      selected = topicById.get(text(choice.existing_id));
      if (!selected || text(choice.new_title)) {
        errors.push(issue('draft_topic', path, 'existing_id 必须存在于当前目录，且不能同时输出 new_title。'));
        return null;
      }
    } else if (text(choice.new_title) && text(choice.reason)) {
      selected = topicByName.get(titleKey(choice.new_title)) || null;
      if (!selected) selected = { id: null, title: text(choice.new_title), aliases: [], proposed_reason: text(choice.reason) };
    } else {
      errors.push(issue('draft_topic', path, '新主题必须同时提供 new_title 和 reason。'));
      return null;
    }
    const key = titleKey(selected.title);
    if (!topicByTitle.has(key)) {
      const topic = { title: selected.title, aliases: selected.id ? (selected.aliases || []) : [], ...(selected.id ? { catalog_id: selected.id } : { proposed_reason: selected.proposed_reason }) };
      topicByTitle.set(key, topic);
      topics.push(topic);
    }
    return topicByTitle.get(key);
  };
  const resolveRefs = (refs, fieldPath) => {
    if (!Array.isArray(refs)) { errors.push(issue('draft_evidence_refs', fieldPath, '证据引用必须是 E 编号数组。')); return []; }
    const ids = [];
    for (const [index, handle] of refs.entries()) {
      const id = handles[handle];
      if (typeof handle !== 'string' || !id || !evidenceById.has(id)) {
        errors.push(issue('draft_evidence_unknown', `${fieldPath}[${index}]`, `证据句柄 ${String(handle)} 不存在或不能唯一映射到本次来源。`));
        continue;
      }
      ids.push(id);
    }
    return [...new Set(ids)];
  };

  for (const [index, raw] of draft.cards.entries()) {
    const prefix = `cards[${index}]`;
    if (!object(raw)) { errors.push(issue('draft_card', prefix, '卡片草稿必须是对象。')); continue; }
    const title = text(raw.title);
    if (!title || cardTitles.has(titleKey(title))) errors.push(issue('draft_title', `${prefix}.title`, '卡片标题不能为空或与同来源卡片重复。'));
    cardTitles.add(titleKey(title));
    const type = text(raw.type);
    if (!cardTypeById.has(type) || (type === 'generic_unknown' && !text(raw.subtype))) {
      errors.push(issue('draft_type', `${prefix}.type`, '类型不存在，或待归类卡缺少具体内容形态 subtype。'));
    }
    const topic = bindTopic(raw.topic, `${prefix}.topic`);
    const front = raw.front;
    const point = front?.point;
    const action = front?.action;
    if (!object(point) || !text(point.text) || !claimKinds.has(point.claim_kind)
      || !object(action) || !text(action.text)) {
      errors.push(issue('draft_front', `${prefix}.front`, '卡面必须有简短重点、主张属性和具体操作。'));
    }
    const pointIds = resolveRefs(point?.evidence_refs, `${prefix}.front.point.evidence_refs`);
    const actionIds = resolveRefs(action?.evidence_refs, `${prefix}.front.action.evidence_refs`);
    const allIds = [...pointIds, ...actionIds];
    const fields = [];
    if (text(point?.text)) fields.push({ label: '卡面重点', value: text(point.text), kind: 'text', claim_kind: claimKinds.has(point.claim_kind) ? point.claim_kind : 'ai_summary' });
    if (text(action?.text)) fields.push({ label: '操作', value: text(action.text), kind: 'text', claim_kind: 'ai_summary' });
    const details = raw.details === undefined ? [] : raw.details;
    if (!Array.isArray(details)) errors.push(issue('draft_details', `${prefix}.details`, '详情必须是数组。'));
    const occupiedLabels = new Set(fields.map((field) => field.label));
    const detailBindings = [];
    for (const [detailIndex, detail] of (Array.isArray(details) ? details : []).entries()) {
      const detailPath = `${prefix}.details[${detailIndex}]`;
      const hasSegments = object(detail) && Object.hasOwn(detail, 'segments');
      const segments = hasSegments ? detailSegments(detail.segments) : null;
      const body = segments
        ? segments.map((segment) => `${segment.label ? `${segment.label}：` : ''}${segment.text}`).join('\n')
        : detailText(detail?.text, detail?.kind || 'text');
      if (!object(detail) || !text(detail.heading) || !body
        || !detailKinds.has(detail.kind || 'text') || !claimKinds.has(detail.claim_kind)
        || (hasSegments && (!segments || detail.kind === 'prompt' || text(detail.text)))) {
        errors.push(issue('draft_detail', detailPath, '详情必须有标题、可安全序列化的正文、合法内容类型和主张属性。'));
        continue;
      }
      if (requireSemanticSegments && detail.kind !== 'prompt' && !segments) {
        errors.push(issue('draft_unstructured_detail', detailPath,
          '普通详情必须把每个独立信息单元放入 segments；不能只返回整段 text。'));
        continue;
      }
      if (!hasSegments && typeof detail.text !== 'string') warnings.push({ level: 'warning', code: 'draft_list_serialized', path: `${detailPath}.text`,
        message: '结构化列表已逐项转成可读正文，原始数组保留在 draft-raw.json。' });
      const detailIds = resolveRefs(detail.evidence_refs, `${detailPath}.evidence_refs`);
      allIds.push(...detailIds);
      let label = text(detail.heading);
      if (detail.kind === 'prompt') {
        const safeLabel = safePromptHeading(label);
        if (safeLabel !== label) {
          warnings.push({ level: 'warning', code: 'draft_prompt_heading_not_verbatim', path: `${detailPath}.heading`,
            message: `Prompt 标题由“${label}”改为“${safeLabel}”：程序不能证明模型整理的文本与来源逐字一致。` });
          label = safeLabel;
        }
      }
      if (occupiedLabels.has(label)) {
        label = `详情：${label}`;
        warnings.push({ level: 'warning', code: 'draft_detail_label', path: detailPath, message: `重复详情标题已改为“${label}”。` });
      }
      occupiedLabels.add(label);
      fields.push({ label, value: body, kind: detail.kind || 'text', claim_kind: detail.claim_kind,
        ...(segments ? { segments } : {}) });
      detailBindings.push({ heading: label, citation_ids: detailIds });
    }
    const steps = raw.steps === undefined ? [] : raw.steps;
    if (!Array.isArray(steps) || !steps.every((item) => text(item))) errors.push(issue('draft_steps', `${prefix}.steps`, '步骤必须是非空字符串数组。'));
    const available = raw.availability;
    if (!object(available) || typeof available.usable !== 'boolean'
      || !Array.isArray(available.missing) || !available.missing.every((item) => text(item))
      || !Array.isArray(available.conflicts) || !available.conflicts.every((item) => text(item))) {
      errors.push(issue('draft_availability', `${prefix}.availability`, '可用性必须包含 usable、missing[] 和 conflicts[]。'));
    } else if (!available.usable) {
      errors.push(issue('draft_unusable', `${prefix}.availability`, '该卡没有最低可用内容；不得将它混入成功卡片。'));
    }
    const missing = Array.isArray(available?.missing) ? available.missing.map((reason) => ({ field: '未取得内容', reason })) : [];
    const conflicts = Array.isArray(available?.conflicts) ? available.conflicts.map((reason) => ({ field: '来源信息', candidates: [], reason })) : [];
    const resourceMentions = raw.resource_mentions === undefined ? [] : raw.resource_mentions;
    if (!Array.isArray(resourceMentions)) errors.push(issue('draft_resources', `${prefix}.resource_mentions`, '资源说明必须是数组。'));
    const resources = [];
    for (const [resourceIndex, resource] of (Array.isArray(resourceMentions) ? resourceMentions : []).entries()) {
      const resourcePath = `${prefix}.resource_mentions[${resourceIndex}]`;
      // A named place or product without a URL is a retrieval clue, not a
      // verified external link. Some providers return `name` without the
      // structural `type`; `other` is the only safe deterministic fallback.
      const untypedNamedClue = object(resource) && !text(resource.type) && text(resource.name)
        && !text(resource.url) && ['missing', 'unverified'].includes(resource.availability);
      const resourceType = untypedNamedClue ? 'other' : text(resource?.type);
      if (!object(resource) || !resourceTypes.has(resourceType) || !resourceStates.has(resource.availability)) {
        errors.push(issue('draft_resource', resourcePath, '资源类型或可用状态不合法。'));
        continue;
      }
      if (untypedNamedClue) warnings.push({ level: 'warning', code: 'draft_named_clue_normalized', path: resourcePath,
        message: '无链接的命名线索已归一为待核实的普通资源；没有生成或验证外部链接。' });
      const resourceLabel = text(resource.label) || text(resource.name);
      if (type === 'prompt' && resourceType === 'prompt_text') {
        // The complete prompt body, not the model's resource flag, determines
        // whether the copy action exists. The program adds it below once.
        continue;
      }
      const url = text(resource.url);
      const externalLink = ['github', 'website', 'app_store', 'plugin_page'].includes(resourceType);
      if ((url && !explicitResourceUrl(url, evidenceDocument)) ||
        (resource.availability === 'available' && externalLink && !url)) {
        warnings.push({ level: 'warning', code: 'draft_resource_url_removed', path: `${resourcePath}.url`,
          message: '资源网址未在本次证据中出现，或可用资源缺少网址；已移除链接并标为待核实。' });
        const reason = '资源链接未在本次证据中得到确认，需要回来源查找或单独核实。';
        missing.push({ field: resourceLabel || '资源链接', reason });
        resources.push({ type: resourceType, availability: 'missing',
          ...(resourceLabel ? { label: resourceLabel } : {}),
          note: text(resource.note) || reason });
        continue;
      }
      resources.push({ type: resourceType, availability: resource.availability,
        ...(resourceLabel ? { label: resourceLabel } : {}),
        ...(url ? { url } : {}),
        ...(text(resource.note) ? { note: text(resource.note) } : {}) });
    }
    if (type === 'prompt') {
      const hasPrompt = fields.some((field) => field.kind === 'prompt' && text(field.value));
      if (!hasPrompt) errors.push(issue('draft_prompt_missing', `${prefix}.details`, 'Prompt 卡没有完整可复制正文，不能以摘要充当 Prompt。'));
      resources.push({ type: 'prompt_text', availability: hasPrompt ? 'available' : 'missing' });
    }
    const citations = [...new Set(allIds)].map((evidence_id) => ({ evidence_id }));
    if (!citations.length) errors.push(issue('draft_citation_missing', prefix, '卡片至少需要一个有效且具体的证据句柄。'));
    if (looksLikeIdentifier(title) && citations.length && !citations.some(({ evidence_id }) =>
      text(evidenceById.get(evidence_id)?.text).normalize('NFKC').toLowerCase().includes(title.normalize('NFKC').toLowerCase()))) {
      warnings.push({ level: 'warning', code: 'draft_identifier_spelling_unverified', path: `${prefix}.title`,
        message: `资源式名称“${title}”未在该卡引用的证据文字中原样出现；可能是 OCR 错字或模型补全，请核对原图或官方来源，不自动改写。` });
    }
    const status = conflicts.length ? 'needs_confirmation'
      : missing.length || resources.some((resource) => resource.availability !== 'available') ? 'partial' : 'ready';
    const card = {
      type, ...(text(raw.subtype) ? { subtype: text(raw.subtype) } : {}), title,
      topic_titles: topic ? [topic.title] : [], status,
      presentation: { intent: defaultIntents[type] || 'general_retrieval', featured_field_labels: fields.filter((field) => ['卡面重点', '操作'].includes(field.label)).map((field) => field.label), featured_path_titles: [] },
      content_fields: fields,
      paths: Array.isArray(steps) && steps.length ? [{ title: '使用步骤', steps: steps.map(text), status }] : [],
      resources, citations, missing, identity_conflicts: conflicts
    };
    cards.push(card);
    audit.card_bindings.push({ title, topic_id: topic?.catalog_id || null, citation_ids: citations.map((item) => item.evidence_id),
      field_evidence: { point: pointIds, action: actionIds, details: detailBindings }, status });
  }
  if (errors.length) return { candidate: null, audit, errors, warnings };
  const groupTitle = text(draft.group_label) || text(evidenceDocument.source.title) || '来自同一收藏';
  const candidate = {
    schema_version: AI_CANDIDATE_SCHEMA_VERSION,
    compiler_origin: CARD_DRAFT_VERSION,
    source_id: sourceId,
    source_understanding: { needs_visual: draft.source_needs.visual, needs_lookup: draft.source_needs.lookup, notes: [] },
    semantic_analysis: null,
    topics,
    cards,
    collections: cards.length > 1 ? [{ title: groupTitle, kind: 'source_collection', member_card_titles: cards.map((card) => card.title) }] : [],
    candidate_conflicts: []
  };
  audit.derived_collection = { created: cards.length > 1, member_count: cards.length, title: cards.length > 1 ? groupTitle : null };
  return { candidate, audit, errors, warnings };
}
