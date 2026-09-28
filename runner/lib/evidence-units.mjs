import path from 'node:path';

export const EVIDENCE_UNITS_PROTOCOL_VERSION = 'hermes-evidence-units/v1';
export const DEFAULT_SUPPLEMENT_MAX_CANDIDATES = 3;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalisePath(value) {
  return text(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

function itemPosition(item) {
  const locator = item?.locator || {};
  return finite(locator.start_seconds)
    ?? finite(locator.timestamp_seconds)
    ?? finite(locator.occurrences?.[0])
    ?? finite(locator.asset_index)
    ?? finite(locator.frame_index)
    ?? Number.POSITIVE_INFINITY;
}

function sortItems(items) {
  return [...items].sort((left, right) => {
    const position = itemPosition(left) - itemPosition(right);
    if (position !== 0) return position;
    return String(left?.id || '').localeCompare(String(right?.id || ''));
  });
}

function isImageAsset(item) {
  const kind = text(item?.locator?.asset_kind);
  return item?.kind === 'asset' && ['image', 'video_frame'].includes(kind);
}

function isSupportAsset(item) {
  return item?.kind === 'asset' && !isImageAsset(item);
}

function imagePoints(item) {
  const locator = item?.locator || {};
  const points = [
    finite(locator.timestamp_seconds),
    ...(Array.isArray(locator.occurrences) ? locator.occurrences.map(finite) : [])
  ].filter((value) => value !== null);
  return [...new Set(points)].sort((left, right) => left - right);
}

function asrInterval(item) {
  const start = finite(item?.locator?.start_seconds);
  const end = finite(item?.locator?.end_seconds);
  if (start === null || end === null || end < start) return null;
  return { start_seconds: start, end_seconds: end };
}

function parseMetadataDescription(document) {
  const metadata = (document?.items || []).find((item) => item?.kind === 'metadata');
  if (!metadata?.text) return null;
  try {
    const value = JSON.parse(metadata.text);
    return text(value?.description) || null;
  } catch {
    return null;
  }
}

function parseSourceText(document) {
  const metadata = (document?.items || []).find((item) => item?.kind === 'metadata');
  const raw = text(metadata?.text);
  if (!raw) return null;
  try {
    JSON.parse(raw);
    return null;
  } catch {
    return raw;
  }
}

function sourceImageRef(ocr) {
  const locator = ocr?.locator || {};
  return text(locator.source_image_ref)
    || text(locator.image_evidence_id)
    || text(locator.asset_ref)
    || null;
}

function findImageForOcr(ocr, images) {
  const locator = ocr?.locator || {};
  const explicit = sourceImageRef(ocr);
  if (explicit) {
    const byId = images.find((image) => image.id === explicit);
    if (byId) return { image: byId, method: 'explicit_evidence_id' };
  }
  const ocrPath = normalisePath(locator.local_path);
  if (ocrPath) {
    const byPath = images.find((image) => normalisePath(image.locator?.local_path) === ocrPath);
    if (byPath) return { image: byPath, method: 'same_source_path' };
  }
  const assetIndex = locator.asset_index;
  if (Number.isInteger(assetIndex)) {
    const byIndex = images.find((image) => image.locator?.asset_index === assetIndex);
    if (byIndex) return { image: byIndex, method: 'same_source_asset_index' };
  }
  return { image: null, method: 'unresolved' };
}

function decisionKey(imageId, asrId) {
  return `${imageId}\u0000${asrId}`;
}

function normaliseDecisions(decisions) {
  const map = new Map();
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (!text(decision?.image_evidence_id) || !text(decision?.asr_evidence_id)) continue;
    if (!['related', 'unrelated', 'unknown'].includes(decision.status)) continue;
    map.set(decisionKey(decision.image_evidence_id, decision.asr_evidence_id), {
      image_evidence_id: decision.image_evidence_id,
      asr_evidence_id: decision.asr_evidence_id,
      status: decision.status,
      method: text(decision.method) || 'provided',
      reason: text(decision.reason) || null
    });
  }
  return map;
}

function temporalCandidate(image, asr, adjacencySeconds) {
  const interval = asrInterval(asr);
  const points = imagePoints(image);
  if (!interval || points.length === 0) return null;
  const overlapping = points.find((point) => point >= interval.start_seconds && point <= interval.end_seconds);
  if (overlapping !== undefined) {
    return { temporal_relation: 'overlap', image_timestamp_seconds: overlapping };
  }
  const distance = Math.min(...points.map((point) => Math.min(
    Math.abs(point - interval.start_seconds),
    Math.abs(point - interval.end_seconds)
  )));
  if (distance <= adjacencySeconds) {
    return { temporal_relation: 'nearby', distance_seconds: Number(distance.toFixed(3)), image_timestamp_seconds: points[0] };
  }
  return null;
}

function imagePosition(image) {
  const locator = image?.locator || {};
  const points = imagePoints(image);
  if (Number.isInteger(locator.asset_index) && locator.asset_kind === 'image') {
    return { gallery_index: locator.asset_index, basis: 'gallery_order' };
  }
  if (points.length) return { timestamp_seconds: points[0], observation_points: points, basis: 'observed_points' };
  return { timestamp_seconds: null, observation_points: [], basis: 'unknown' };
}

function asrPosition(asr) {
  const interval = asrInterval(asr);
  if (interval) return { ...interval, basis: 'asr_interval' };
  return { start_seconds: null, end_seconds: null, basis: 'unknown' };
}

function locationForItem(item) {
  const locator = item?.locator || {};
  return {
    ...(finite(locator.timestamp_seconds) !== null ? { timestamp_seconds: locator.timestamp_seconds } : {}),
    ...(finite(locator.start_seconds) !== null ? { start_seconds: locator.start_seconds } : {}),
    ...(finite(locator.end_seconds) !== null ? { end_seconds: locator.end_seconds } : {}),
    ...(Number.isInteger(locator.asset_index) ? { asset_index: locator.asset_index } : {}),
    ...(Number.isInteger(locator.frame_index) ? { frame_index: locator.frame_index } : {})
  };
}

function makeAssociation(status, method, reason) {
  return { status, method, ...(text(reason) ? { reason } : {}) };
}

function makeImageUnit({ sourceId, image, ocrs, relatedAsr, association }) {
  const issues = [];
  if (!ocrs.length) issues.push({ code: 'ocr_not_present', note: '当前没有绑定 OCR 记录；不表示图片没有文字。' });
  const asrIntervals = relatedAsr.map(asrPosition);
  const position = imagePosition(image);
  if (asrIntervals.length) position.asr_intervals = asrIntervals;
  return {
    unit_id: `${sourceId}:unit:${String(image.order).padStart(4, '0')}`,
    order: image.order,
    position,
    image: {
      evidence_id: image.id,
      asset_ref: image.locator?.local_path || null,
      timestamp_seconds: finite(image.locator?.timestamp_seconds),
      status: text(image.locator?.local_path) ? 'available' : 'unavailable'
    },
    ocr: ocrs.map((item) => ({
      evidence_id: item.id,
      source_image_ref: image.id,
      text: text(item.text),
      location: locationForItem(item)
    })),
    asr: relatedAsr.map((item) => ({
      evidence_id: item.id,
      ...asrPosition(item),
      text: text(item.text)
    })),
    association: relatedAsr.length
      ? makeAssociation(association.status, association.method, association.reason)
      : makeAssociation('not_applicable', 'single_modality', '当前单元没有已确认的 ASR 内容关联。'),
    issues
  };
}

function makeAsrUnit({ sourceId, order, asr, candidates }) {
  const interval = asrInterval(asr);
  const reason = candidates.length
    ? '存在时间相近的画面候选，但尚未完成内容关系判断。'
    : '没有可靠的同期画面关联；不表示原视频此时没有画面。';
  return {
    unit_id: `${sourceId}:unit:asr:${String(order).padStart(4, '0')}`,
    order,
    position: asrPosition(asr),
    image: null,
    ocr: [],
    asr: [{ evidence_id: asr.id, ...asrPosition(asr), text: text(asr.text) }],
    association: makeAssociation('unknown', 'unresolved', reason),
    issues: [{ code: candidates.length ? 'visual_relation_unresolved' : 'visual_unassociated', note: reason }]
  };
}

function makeOrphanOcrUnit({ sourceId, order, ocr }) {
  return {
    unit_id: `${sourceId}:unit:ocr:${String(order).padStart(4, '0')}`,
    order,
    position: locationForItem(ocr),
    image: null,
    ocr: [{ evidence_id: ocr.id, source_image_ref: null, text: text(ocr.text), location: locationForItem(ocr) }],
    asr: [],
    association: makeAssociation('unknown', 'unresolved', 'OCR 没有可验证的同来源图片资产引用。'),
    issues: [{ code: 'image_asset_missing', note: '保留 OCR 原始定位，不借用其他图片。' }]
  };
}

function mapItems(units, items, sourceLevelIds) {
  const mapping = new Map();
  for (const unit of units) {
    for (const record of [...unit.ocr, ...unit.asr]) mapping.set(record.evidence_id, [unit.unit_id]);
    if (unit.image?.evidence_id) mapping.set(unit.image.evidence_id, [unit.unit_id]);
  }
  const item_mappings = items.map((item) => ({
    evidence_id: item.id,
    unit_ids: mapping.get(item.id) || [],
    scope: mapping.has(item.id) ? 'unit' : sourceLevelIds.includes(item.id) ? 'source' : 'unmapped'
  }));
  return { item_mappings, unmapped_evidence_ids: item_mappings.filter((item) => item.scope === 'unmapped').map((item) => item.evidence_id) };
}

export function organizeEvidenceDocument({ evidenceDocument, associationDecisions = [], adjacencySeconds = 1.5, priorProcessing = {} }) {
  if (!isObject(evidenceDocument) || !isObject(evidenceDocument.source) || !Array.isArray(evidenceDocument.items)) {
    throw new Error('无法组织证据单元：输入不是 canonical evidence envelope。');
  }
  const sourceId = text(evidenceDocument.source.id) || 'unknown-source';
  const items = evidenceDocument.items;
  const images = sortItems(items.filter(isImageAsset)).map((item, index) => ({ ...item, order: index + 1 }));
  const ocrItems = sortItems(items.filter((item) => item?.kind === 'ocr'));
  const asrItems = sortItems(items.filter((item) => item?.kind === 'asr'));
  const decisions = normaliseDecisions(associationDecisions);
  const imageByOcr = new Map();
  const orphanOcr = [];
  const ocrByImage = new Map(images.map((image) => [image.id, []]));
  for (const ocr of ocrItems) {
    const match = findImageForOcr(ocr, images);
    if (match.image) {
      imageByOcr.set(ocr.id, match.image.id);
      ocrByImage.get(match.image.id).push(ocr);
    } else orphanOcr.push(ocr);
  }

  const candidates = [];
  for (const asr of asrItems) {
    for (const image of images) {
      const temporal = temporalCandidate(image, asr, adjacencySeconds);
      if (!temporal) continue;
      const decision = decisions.get(decisionKey(image.id, asr.id));
      candidates.push({
        image_evidence_id: image.id,
        asr_evidence_id: asr.id,
        ...temporal,
        status: decision?.status || 'unknown',
        method: decision?.method || 'temporal_candidate',
        ...(decision?.reason ? { reason: decision.reason } : {})
      });
    }
  }

  const relatedByImage = new Map(images.map((image) => [image.id, []]));
  const relatedDecisions = [];
  for (const candidate of candidates) {
    if (candidate.status !== 'related') continue;
    const target = relatedByImage.get(candidate.image_evidence_id);
    if (!target.some((item) => item.id === candidate.asr_evidence_id)) {
      const asr = asrItems.find((item) => item.id === candidate.asr_evidence_id);
      if (asr) target.push(asr);
    }
    relatedDecisions.push(candidate);
  }
  const assignedAsr = new Set([...relatedByImage.values()].flat().map((item) => item.id));

  const units = [];
  for (const image of images) {
    const related = relatedByImage.get(image.id) || [];
    const decision = related.length
      ? relatedDecisions.find((item) => item.image_evidence_id === image.id && item.asr_evidence_id === related[0].id)
      : null;
    units.push(makeImageUnit({
      sourceId,
      image,
      ocrs: ocrByImage.get(image.id) || [],
      relatedAsr: related,
      association: decision || { status: 'related', method: 'provided', reason: '已提供关系判断。' }
    }));
  }
  for (const ocr of orphanOcr) units.push(makeOrphanOcrUnit({ sourceId, order: units.length + 1, ocr }));
  for (const asr of asrItems) {
    if (assignedAsr.has(asr.id)) continue;
    const asrCandidates = candidates.filter((item) => item.asr_evidence_id === asr.id);
    units.push(makeAsrUnit({ sourceId, order: units.length + 1, asr, candidates: asrCandidates }));
  }

  const sourceLevelIds = items.filter((item) => item.kind === 'metadata' || isSupportAsset(item) || item.kind === 'cv').map((item) => item.id);
  const mapping = mapItems(units, items, sourceLevelIds);
  const description = parseMetadataDescription(evidenceDocument);
  const counts = Object.fromEntries(['metadata', 'ocr', 'asr', 'cv', 'asset'].map((kind) => [kind, items.filter((item) => item.kind === kind).length]));
  const associationCounts = Object.fromEntries(['related', 'unrelated', 'unknown', 'not_applicable'].map((status) => [status, candidates.filter((item) => item.status === status).length]));
  const processing = {
    ...priorProcessing,
    association_policy: {
      statuses: ['related', 'unrelated', 'unknown'],
      temporal_candidates_are_not_confirmations: true,
      adjacency_seconds: adjacencySeconds,
      relation_resolver: associationDecisions.length ? 'provided_decisions' : 'not_configured'
    },
    association_candidates: candidates,
    association_decisions: [...decisions.values()],
    source_level_evidence_ids: sourceLevelIds,
    supplement: priorProcessing.supplement || { requested: false, records: [] }
  };
  return {
    protocol_version: EVIDENCE_UNITS_PROTOCOL_VERSION,
    source: {
      id: sourceId,
      title: text(evidenceDocument.source.title) || '未命名来源',
      ...(description ? { description } : {}),
      ...(parseSourceText(evidenceDocument) ? { source_text: parseSourceText(evidenceDocument) } : {}),
      ...(items.find((item) => item.kind === 'metadata')?.id ? { metadata_evidence_id: items.find((item) => item.kind === 'metadata').id } : {}),
      media_kind: text(evidenceDocument.media?.kind) || 'unknown',
      ...(text(evidenceDocument.source.source_url) ? { source_url: evidenceDocument.source.source_url } : {})
    },
    units,
    provenance: {
      source_protocol_version: evidenceDocument.protocol_version || null,
      item_mappings: mapping.item_mappings,
      unmapped_evidence_ids: mapping.unmapped_evidence_ids,
      image_ocr_binding: ocrItems.map((ocr) => ({
        ocr_evidence_id: ocr.id,
        image_evidence_id: imageByOcr.get(ocr.id) || null,
        method: imageByOcr.has(ocr.id) ? 'source_scoped_locator' : 'unresolved'
      }))
    },
    processing,
    summary: {
      unit_count: units.length,
      source_item_count: items.length,
      mapped_item_count: mapping.item_mappings.filter((item) => item.scope !== 'unmapped').length,
      unmapped_item_count: mapping.unmapped_evidence_ids.length,
      counts,
      association_candidate_counts: associationCounts
    }
  };
}

function renderPosition(position) {
  if (!position || typeof position !== 'object') return '位置未知';
  if (position.gallery_index !== undefined) return `图文第 ${position.gallery_index} 张`;
  if (position.start_seconds !== null && position.start_seconds !== undefined) {
    return `${position.start_seconds}s–${position.end_seconds ?? '?'}s`;
  }
  if (position.timestamp_seconds !== null && position.timestamp_seconds !== undefined) return `${position.timestamp_seconds}s 观测点`;
  return '位置未知';
}

export function renderUnitsForHuman(organized) {
  const lines = [`# 证据单元：${organized.source.title}`, ''];
  if (organized.source.description) lines.push(`简介：${organized.source.description}`, '');
  for (const unit of organized.units || []) {
    lines.push(`## ${unit.unit_id}`, '', `位置：${renderPosition(unit.position)}`);
    lines.push(`原图：${unit.image ? `${unit.image.evidence_id} · ${unit.image.asset_ref || '引用不可用'} · ${unit.image.status}` : '空（当前单元没有可靠图片关联）'}`);
    lines.push('OCR：');
    if (unit.ocr.length) for (const item of unit.ocr) lines.push(`- ${item.evidence_id}：${item.text || '（空文本）'}`);
    else lines.push('- 空');
    lines.push('ASR：');
    if (unit.asr.length) for (const item of unit.asr) lines.push(`- ${item.evidence_id} ${renderPosition(item)}：${item.text || '（空文本）'}`);
    else lines.push('- 空');
    lines.push(`关联状态：${unit.association.status}（${unit.association.method}）${unit.association.reason ? `；${unit.association.reason}` : ''}`);
    if (unit.issues?.length) lines.push('问题：', ...unit.issues.map((issue) => `- ${issue.code}：${issue.note}`));
    lines.push('');
  }
  return lines.join('\n');
}

export function renderUnitsForModel(organized) {
  const lines = [`来源：${organized.source.title}`];
  if (organized.source.description) lines.push(`简介：${organized.source.description}`);
  if (organized.source.source_text) lines.push('', '来源正文（原文保留）：', organized.source.source_text);
  lines.push('', '以下是按来源顺序组织的证据单元。方括号内是 unit_id，仅作分区标题；卡片 citations 必须引用下方 OCR/ASR/原图记录的 evidence_id，不得引用 unit_id。OCR 与 ASR 必须分区阅读；关联状态为 unknown 时不要强行合并。');
  for (const unit of organized.units || []) {
    lines.push('', `[${unit.unit_id}] 位置：${renderPosition(unit.position)}`);
    if (unit.image) lines.push(`原图引用：${unit.image.evidence_id}；仅有原图，本次未提供视觉输入。`);
    else lines.push('原图：空（当前单元没有可靠图片关联）。');
    lines.push('OCR：');
    for (const item of unit.ocr) lines.push(`- ${item.evidence_id}：${item.text || '（空文本）'}`);
    if (!unit.ocr.length) lines.push('- 空');
    lines.push('ASR：');
    for (const item of unit.asr) lines.push(`- ${item.evidence_id} ${renderPosition(item)}：${item.text || '（空文本）'}`);
    if (!unit.asr.length) lines.push('- 空');
    lines.push(`关联：${unit.association.status}；${unit.association.reason || '单一模态或暂无关系判断。'}`);
  }
  return lines.join('\n');
}

function modelLocator(locator = {}) {
  const allowed = ['local_path', 'timestamp_seconds', 'occurrences', 'frame_index', 'asset_index', 'start_seconds', 'end_seconds', 'video_path', 'format'];
  return Object.fromEntries(allowed.filter((key) => locator[key] !== undefined).map((key) => [key, locator[key]]));
}

export function buildModelEvidenceDocument({ evidenceDocument, organized }) {
  const ids = new Set((organized.units || []).flatMap((unit) => [
    unit.image?.evidence_id,
    ...unit.ocr.map((item) => item.evidence_id),
    ...unit.asr.map((item) => item.evidence_id)
  ].filter(Boolean)));
  const items = (evidenceDocument.items || []).filter((item) => ids.has(item.id)).map((item) => ({
    id: item.id,
    kind: item.kind,
    source_id: item.source_id,
    locator: modelLocator(item.locator),
    ...(text(item.text) ? { text: item.text } : {})
  }));
  const metadataId = organized.source.metadata_evidence_id;
  if (metadataId && organized.source.source_text) {
    const metadata = evidenceDocument.items.find((item) => item.id === metadataId);
    if (metadata) items.unshift({ id: metadata.id, kind: metadata.kind, source_id: metadata.source_id, locator: modelLocator(metadata.locator), text: metadata.text });
  }
  return {
    protocol_version: evidenceDocument.protocol_version || null,
    source: organized.source,
    media: { kind: organized.source.media_kind },
    items,
    units_text: renderUnitsForModel(organized)
  };
}

export function supplementKey({ sourceId, asrEvidenceId, configVersion = 'v1' }) {
  return `${sourceId}:${asrEvidenceId}:${configVersion}`;
}

export function localPathForEvidence(sourceDirectory, locatorPath) {
  if (!text(locatorPath)) return null;
  const root = path.resolve(sourceDirectory);
  const resolved = path.resolve(root, locatorPath);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}
