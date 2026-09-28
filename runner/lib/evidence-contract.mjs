import { sha256 } from "./utils.mjs";

export const EVIDENCE_PROTOCOL_VERSION = "hermes-evidence/v1";

const allowedMediaKinds = new Set(["video", "gallery", "unknown"]);
const allowedEvidenceKinds = new Set(["metadata", "ocr", "asr", "cv", "asset"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function canonicalKind(kind) {
  switch (kind) {
    case "note_text":
      return "metadata";
    case "attachment_image":
    case "attachment_video":
      return "asset";
    default:
      return allowedEvidenceKinds.has(kind) ? kind : "asset";
  }
}

function canonicalLocator(locator, originalKind) {
  if (isObject(locator)) return locator;
  if (text(locator)) {
    return originalKind === "note_text"
      ? { path: locator, field: "note_text" }
      : { path: locator };
  }
  return { unknown: true };
}

function defaultConfidence(kind, evidence) {
  if (number(evidence.confidence) !== null) return evidence.confidence;
  // Raw metadata and preserved local assets are not model guesses. They are
  // confidence 1.0 as an extraction operation; OCR/ASR/CV must provide the
  // engine's own confidence when those items are appended later.
  return kind === "metadata" || kind === "asset" ? 1 : null;
}

function normaliseSource({ source, inputRecord }) {
  return {
    id: source?.id || inputRecord?.source_id || null,
    kind: source?.kind || inputRecord?.source_kind || "other",
    title: source?.title || inputRecord?.title_from_note || "未命名来源",
    evidence_scope: source?.evidence_scope || inputRecord?.evidence_scope || "fresh_source",
    status: source?.status || inputRecord?.source_status || "unverified",
    ...(text(source?.source_url) ? { source_url: text(source.source_url) } : {}),
    ...(text(inputRecord?.frontmatter?.source) ? { source_url: text(inputRecord.frontmatter.source) } : {})
  };
}

function makeSummary(items) {
  return {
    item_count: items.length,
    counts: Object.fromEntries([...allowedEvidenceKinds].map((kind) => [
      kind,
      items.filter((item) => item.kind === kind).length
    ]))
  };
}

/**
 * Converts the legacy Runner input record into the versioned evidence envelope.
 * The legacy evidence array is intentionally left untouched for backwards
 * compatibility; this document is the canonical boundary for new OCR/ASR/CV
 * producers.
 */
export function buildEvidenceDocument({
  source,
  inputRecord,
  mediaKind = inputRecord?.media_kind || "unknown",
  mediaSignals = inputRecord?.media_signals || {}
}) {
  const sourceDocument = normaliseSource({ source, inputRecord });
  const items = (inputRecord?.evidence || []).map((evidence, index) => {
    const kind = canonicalKind(evidence.kind);
    const item = {
      id: text(evidence.id) || `evidence_${sourceDocument.id || "source"}_${index + 1}`,
      kind,
      source_id: sourceDocument.id,
      locator: canonicalLocator(evidence.locator, evidence.kind),
      confidence: defaultConfidence(kind, evidence)
    };
    if (text(evidence.text)) item.text = evidence.text;
    if (text(evidence.sha256)) item.sha256 = evidence.sha256;
    return item;
  });

  const normalisedMediaKind = allowedMediaKinds.has(mediaKind) ? mediaKind : "unknown";
  return {
    protocol_version: EVIDENCE_PROTOCOL_VERSION,
    source: sourceDocument,
    media: {
      kind: normalisedMediaKind,
      signals: isObject(mediaSignals) ? mediaSignals : {}
    },
    items,
    summary: makeSummary(items)
  };
}

/**
 * Creates a canonical evidence envelope for a newly captured source, where
 * there is no legacy Runner note to adapt.  Producers remain responsible for
 * providing raw, traceable evidence items; this helper deliberately does not
 * infer text or model conclusions.
 */
export function buildFreshEvidenceDocument({
  source,
  mediaKind = "unknown",
  mediaSignals = {},
  items = []
}) {
  const sourceDocument = normaliseSource({ source });
  const normalisedMediaKind = allowedMediaKinds.has(mediaKind) ? mediaKind : "unknown";
  return {
    protocol_version: EVIDENCE_PROTOCOL_VERSION,
    source: sourceDocument,
    media: {
      kind: normalisedMediaKind,
      signals: isObject(mediaSignals) ? mediaSignals : {}
    },
    items: Array.isArray(items) ? items : [],
    summary: makeSummary(Array.isArray(items) ? items : [])
  };
}

function addIssue(issues, code, path, message) {
  issues.push({ level: "error", code, path, message });
}

export function validateEvidenceDocument(document) {
  const issues = [];
  if (!isObject(document)) {
    addIssue(issues, "document_shape", "$", "证据文档必须是 JSON 对象。");
    return { status: "failed", issues, summary: { errors: issues.length, item_count: 0 } };
  }
  if (document.protocol_version !== EVIDENCE_PROTOCOL_VERSION) {
    addIssue(issues, "protocol_version", "protocol_version", `必须为 ${EVIDENCE_PROTOCOL_VERSION}。`);
  }
  if (!isObject(document.source) || !text(document.source.id)) {
    addIssue(issues, "source_shape", "source", "source 必须包含非空 id。");
  }
  if (!isObject(document.media) || !allowedMediaKinds.has(document.media.kind)) {
    addIssue(issues, "media_shape", "media.kind", "media.kind 必须是 video、gallery 或 unknown。");
  } else if (!isObject(document.media.signals)) {
    addIssue(issues, "media_signals", "media.signals", "media.signals 必须是对象。");
  }

  if (!Array.isArray(document.items) || document.items.length === 0) {
    addIssue(issues, "items_shape", "items", "证据文档至少需要一条证据。");
  }

  const ids = new Set();
  (document.items || []).forEach((item, index) => {
    const itemPath = `items[${index}]`;
    if (!isObject(item)) {
      addIssue(issues, "item_shape", itemPath, "证据项必须是对象。");
      return;
    }
    if (!text(item.id)) addIssue(issues, "item_id", `${itemPath}.id`, "证据项必须有 id。");
    else if (ids.has(item.id)) addIssue(issues, "item_id_duplicate", `${itemPath}.id`, `证据 ID 重复：${item.id}。`);
    else ids.add(item.id);
    if (!allowedEvidenceKinds.has(item.kind)) addIssue(issues, "item_kind", `${itemPath}.kind`, `不支持的证据类型：${item.kind}。`);
    if (document.source?.id && item.source_id !== document.source.id) {
      addIssue(issues, "item_source", `${itemPath}.source_id`, "证据项 source_id 必须与文档 source.id 一致。");
    }
    if (!isObject(item.locator) || Object.keys(item.locator).length === 0) {
      addIssue(issues, "item_locator", `${itemPath}.locator`, "证据项必须说明来源位置。");
    }
    if (number(item.confidence) === null || item.confidence < 0 || item.confidence > 1) {
      addIssue(issues, "item_confidence", `${itemPath}.confidence`, "confidence 必须是 0 到 1 之间的数字。");
    }
    if (["metadata", "ocr", "asr"].includes(item.kind) && !text(item.text)) {
      addIssue(issues, "item_text", `${itemPath}.text`, `${item.kind} 证据必须包含 text。`);
    }
    if (item.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(item.sha256)) {
      addIssue(issues, "item_sha256", `${itemPath}.sha256`, "sha256 必须是 64 位十六进制字符串。");
    }
  });

  return {
    status: issues.length ? "failed" : "passed",
    issues,
    summary: {
      errors: issues.length,
      item_count: Array.isArray(document.items) ? document.items.length : 0,
      evidence_ids: [...ids]
    }
  };
}

/**
 * Validates raw model citations before normalisation. This is deliberately
 * separate from card field/type checks: it only answers whether a citation
 * points at an evidence item that exists in this exact evidence document.
 */
export function validateCardEvidenceReferences({ candidate, evidenceDocument }) {
  const issues = [];
  const evidenceIds = new Set((evidenceDocument?.items || []).map((item) => item.id));
  if (!isObject(candidate) || !Array.isArray(candidate.cards)) {
    addIssue(issues, "card_shape", "cards", "Card 候选必须包含 cards 数组。");
    return { status: "failed", issues };
  }
  candidate.cards.forEach((card, cardIndex) => {
    const cardPath = `cards[${cardIndex}]`;
    if (!Array.isArray(card?.citations) || card.citations.length === 0) {
      addIssue(issues, "citation_missing", `${cardPath}.citations`, "每张 Card 至少需要一条引用。");
      return;
    }
    card.citations.forEach((citation, citationIndex) => {
      const citationPath = `${cardPath}.citations[${citationIndex}]`;
      if (!isObject(citation) || !text(citation.evidence_id)) {
        addIssue(issues, "citation_shape", citationPath, "引用必须是 { evidence_id } 对象。");
      } else if (!evidenceIds.has(citation.evidence_id)) {
        addIssue(issues, "citation_unknown", citationPath, `引用了不存在的 evidence_id：${citation.evidence_id}。`);
      }
    });
  });
  return { status: issues.length ? "failed" : "passed", issues };
}

export function appendEvidenceItems(document, additions = []) {
  const next = structuredClone(document);
  next.items = [...(next.items || []), ...additions];
  next.summary = makeSummary(next.items);
  return next;
}

export function makeTextEvidence({ id, kind, sourceId, text: value, locator, confidence, rawValueForHash = value }) {
  const item = {
    id,
    kind,
    source_id: sourceId,
    text: value,
    locator,
    confidence
  };
  if (rawValueForHash !== undefined && rawValueForHash !== null) item.sha256 = sha256(String(rawValueForHash));
  return item;
}
