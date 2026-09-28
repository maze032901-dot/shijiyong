import fs from "node:fs";
import path from "node:path";
import { cardTypeById } from './card-type-registry.mjs';

const placeholderPattern = /(具体.?prompt|这里给可能|待填写|aaaa+)/i;
const allowedCitationKinds = new Set([
  "note_text",
  "attachment_image",
  "source_video",
  "metadata",
  "asset",
  "ocr",
  "asr",
  "transcript",
  "external_page"
]);

function issue(level, code, message, cardId = null) {
  return { level, code, message, card_id: cardId };
}

export function validateCandidate({ root, fixture, inputRecord }) {
  const issues = [];
  const topicIds = new Set((fixture.topics || []).map((topic) => topic.id));
  const cardIds = new Set();
  const evidenceKinds = new Set((inputRecord.evidence || []).map((evidence) => evidence.kind));

  if (fixture.schema_version !== "card-engine/v2") {
    issues.push(issue("error", "schema_version", "候选数据的 schema_version 必须为 card-engine/v2。"));
  }
  if (!fixture.source || fixture.source.id !== inputRecord.source_id) {
    issues.push(issue("error", "source_mismatch", "候选卡的来源必须与当前笔记输入一致。"));
  }

  (fixture.cards || []).forEach((card) => {
    if (!card.id || cardIds.has(card.id)) {
      issues.push(issue("error", "card_id", "卡片 ID 缺失或重复。", card.id || null));
    }
    cardIds.add(card.id);

    if (!cardTypeById.has(card.type)) {
      issues.push(issue("error", "card_type", "不支持的卡片类型：" + card.type, card.id));
    }
    if (card.type === 'generic_unknown' && !String(card.subtype ?? '').trim()) {
      issues.push(issue("error", "card_subtype", "待归类卡片必须写明具体内容形态。", card.id));
    }
    if (!card.title) {
      issues.push(issue("error", "card_title", "卡片标题不能为空。", card.id));
    }
    if (!Array.isArray(card.topic_ids) || card.topic_ids.length === 0) {
      issues.push(issue("error", "topic_missing", "具体内容卡必须关联至少一个主题。", card.id));
    } else {
      card.topic_ids.forEach((topicId) => {
        if (!topicIds.has(topicId)) {
          issues.push(issue("error", "topic_reference", "关联了不存在的主题：" + topicId, card.id));
        }
      });
    }

    const citations = card.citations || [];
    if (!citations.some((citation) => citation.source_id === inputRecord.source_id)) {
      issues.push(issue("error", "citation_missing", "具体内容卡必须引用当前来源。", card.id));
    }
    citations.forEach((citation) => {
      if (!allowedCitationKinds.has(citation.evidence_kind)) {
        issues.push(issue("error", "citation_kind", "不支持的引用类型：" + citation.evidence_kind, card.id));
      }
      if (!evidenceKinds.has(citation.evidence_kind)) {
        issues.push(issue("error", "citation_unavailable", "引用的证据类型当前不在证据包中：" + citation.evidence_kind, card.id));
      }
    });

    (card.content_fields || []).forEach((field) => {
      if (!field.label || !field.value) {
        issues.push(issue("error", "content_field", "内容字段必须有名称和内容。", card.id));
      }
      if (placeholderPattern.test(field.value || "")) {
        issues.push(issue("error", "placeholder", "占位文字不能写入卡片事实：" + field.value, card.id));
      }
    });

    const resources = card.resources || [];
    if (card.type === "prompt" && !resources.some((resource) => resource.type === "prompt_text")) {
      issues.push(issue("error", "prompt_resource", "Prompt 卡必须明确 prompt_text 的资源状态。", card.id));
    }
    resources.forEach((resource) => {
      const isLink = new Set(["github", "website", "app_store", "plugin_page"]).has(resource.type);
      if (resource.availability === "available" && isLink && !resource.url) {
        issues.push(issue("error", "resource_url", "可用的外部资源必须有 URL。", card.id));
      }
      if (resource.availability === "available" && resource.type === "image_file") {
        const assetPath = resource.local_path && path.join(root, resource.local_path);
        if (!assetPath || !fs.existsSync(assetPath)) {
          issues.push(issue("error", "asset_missing", "可用图片资源的本地文件不存在。", card.id));
        }
      }
    });
  });

  (fixture.collections || []).forEach((collection) => {
    (collection.member_card_ids || []).forEach((memberId) => {
      if (!cardIds.has(memberId)) {
        issues.push(issue("error", "collection_member", "来源集合引用了不存在的卡片：" + memberId, collection.id));
      }
    });
  });

  return {
    status: issues.some((item) => item.level === "error") ? "failed" : "passed",
    checked_at: new Date().toISOString(),
    issues,
    summary: {
      errors: issues.filter((item) => item.level === "error").length,
      warnings: issues.filter((item) => item.level === "warning").length,
      card_count: (fixture.cards || []).length,
      collection_count: (fixture.collections || []).length
    }
  };
}
