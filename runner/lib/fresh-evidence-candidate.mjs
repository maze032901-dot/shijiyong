import path from "node:path";
import { buildFreshEvidenceAiRequest } from "./ai-contract.mjs";
import { AI_CANDIDATE_SCHEMA_VERSION } from './candidate-response-contract.mjs';
import { buildCardDraftRequest, CARD_DRAFT_VERSION } from './card-draft-contract.mjs';
import { compileCardDraft } from './card-draft-compiler.mjs';
import { loadTopicContext } from "./topic-context.mjs";
import { validateCandidate } from "./candidate-validator.mjs";
import { validateCardEvidenceReferences, validateEvidenceDocument } from "./evidence-contract.mjs";
import { normaliseModelCandidate } from "./model-candidate-normalizer.mjs";
import { repairModelCandidate } from "./candidate-repair.mjs";
import { ModelCandidateParseError, callOpenAICompatible, callZhipuPlatform } from "./zhipu-platform-client.mjs";
import { nowIso, safePathSegment, writeJson, writeText } from "./utils.mjs";

function plainText(value) {
  return typeof value === "string" ? value.trim() : "";
}

const MIN_MODEL_OCR_CONFIDENCE = 0.6;

function compactText(value) {
  return plainText(value).replace(/\s+/g, " ");
}

function characterSet(value) {
  return new Set(compactText(value).replace(/[\s\p{P}\p{S}]/gu, ""));
}

function evidenceSeconds(item) {
  if (Number.isFinite(item.locator?.timestamp_seconds)) return item.locator.timestamp_seconds;
  if (Number.isFinite(item.locator?.start_seconds)) return item.locator.start_seconds;
  return 0;
}

function modelTextItem(item) {
  const locator = {};
  if (Number.isFinite(item.locator?.timestamp_seconds)) locator.timestamp_seconds = item.locator.timestamp_seconds;
  else if (Number.isFinite(item.locator?.start_seconds)) locator.start_seconds = item.locator.start_seconds;
  if (Number.isFinite(item.locator?.end_seconds)) locator.end_seconds = item.locator.end_seconds;
  return {
    id: item.id,
    kind: item.kind,
    source_id: item.source_id,
    text: compactText(item.text),
    locator: Object.keys(locator).length ? locator : { projection: "text_only" },
    confidence: item.confidence
  };
}

function compactMetadataItem({ evidenceDocument, metadata }) {
  let sourceMetadata = {};
  try { sourceMetadata = JSON.parse(metadata?.text || "{}"); } catch { /* use envelope source below */ }
  const summary = {
    title: evidenceDocument.source.title || null,
    description: sourceMetadata.description || evidenceDocument.source.title || null,
    media_kind: evidenceDocument.media.kind
  };
  return {
    id: metadata?.id || "metadata-projection",
    kind: "metadata",
    source_id: evidenceDocument.source.id,
    text: JSON.stringify(summary),
    locator: { projection: "minimal_source_summary" },
    confidence: 1
  };
}

/**
 * Produces the minimum model-readable view of a canonical bundle. It never
 * edits the bundle on disk: all IDs still refer to the original local evidence.
 * Assets, hashes, file paths, signing data and low-value OCR are intentionally
 * absent from this view.
 */
export function projectEvidenceForModel(evidenceDocument) {
  const items = evidenceDocument.items || [];
  const metadata = items.find((item) => item.kind === "metadata");
  const asr = items.filter((item) => item.kind === "asr" && plainText(item.text));
  const ocrCandidates = items
    .filter((item) => item.kind === "ocr")
    .map((item) => ({ item, text: compactText(item.text) }))
    .filter(({ item, text }) => item.confidence >= MIN_MODEL_OCR_CONFIDENCE && text)
    .map(({ item }) => item)
    .sort((left, right) => evidenceSeconds(left) - evidenceSeconds(right));
  const projectedItems = [
    compactMetadataItem({ evidenceDocument, metadata }),
    ...asr.map(modelTextItem),
    ...ocrCandidates.map(modelTextItem)
  ];
  const document = {
    protocol_version: evidenceDocument.protocol_version,
    source: {
      id: evidenceDocument.source.id,
      kind: evidenceDocument.source.kind,
      title: evidenceDocument.source.title,
      evidence_scope: evidenceDocument.source.evidence_scope,
      status: evidenceDocument.source.status
    },
    media: { kind: evidenceDocument.media.kind, signals: {} },
    items: projectedItems,
    summary: {
      projection: "model_minimum_v3",
      item_count: projectedItems.length,
      evidence_ids: projectedItems.map((item) => item.id)
    }
  };
  return {
    document,
    audit: {
      policy: "model_minimum_v3",
      original_item_counts: itemCounts(items),
      sent_item_counts: itemCounts(projectedItems),
      omitted_asset_count: items.filter((item) => item.kind === "asset").length,
      omitted_ocr_ids: items.filter((item) => item.kind === "ocr" && !ocrCandidates.includes(item)).map((item) => item.id),
      retained_ocr_ids: ocrCandidates.map((item) => item.id),
      ocr_selection: {
        strategy: "retain_all_high_confidence_text",
        minimum_confidence: MIN_MODEL_OCR_CONFIDENCE
      },
      omitted_fields: ["sha256", "本地路径", "素材清单", "媒体签名地址", "来源短链接", "逐段 ASR/OCR 的完整 locator"]
    }
  };
}

export function freshInputRecord(evidenceDocument) {
  return {
    source_id: evidenceDocument.source.id,
    frontmatter: { source: evidenceDocument.source.source_url || "" },
    evidence: evidenceDocument.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      locator: item.locator,
      ...(plainText(item.text) ? { text: item.text } : {})
    }))
  };
}

export function freshReferenceFixture(evidenceDocument) {
  return {
    schema_version: "card-engine/v2",
    fixture_id: "fresh_" + safePathSegment(evidenceDocument.source.id),
    source: evidenceDocument.source,
    topics: [],
    cards: [],
    collections: [],
    acceptance: {
      expected_card_count: null,
      expected_collection_count: null,
      checks: ["这是真实新鲜证据的候选，不存在预设 Golden Set 标准答案。"]
    }
  };
}

function itemCounts(items) {
  return items.reduce((counts, item) => {
    counts[item.kind] = (counts[item.kind] || 0) + 1;
    return counts;
  }, {});
}

function markdownList(items, render) {
  return items.length ? items.map((item) => "- " + render(item)).join("\n") : "- 无";
}

export function buildFreshCandidateReview({ evidenceDocument, outcome, topicNormalization = [], rawDraft = null }) {
  const counts = itemCounts(evidenceDocument.items);
  const normalised = outcome.normalised;
  const candidate = normalised?.fixture;
  const lines = [
    "# 拾即用新鲜收藏候选审核",
    "",
    "这份报告不是正式卡片，也没有与 Golden Set 对照；它用于检查模型是否只依据本次保存的证据形成候选。评估器本身不写入卡片库；是否发布由手动发布或显式自动模式决定。",
    "",
    "## 来源与证据",
    "",
    "- 来源：" + (evidenceDocument.source.title || "未命名收藏"),
    "- 来源 ID：`" + evidenceDocument.source.id + "`",
    "- 媒体：" + (evidenceDocument.media?.kind || "unknown"),
    "- 证据计数：" + Object.entries(counts).map(([kind, count]) => kind + " " + count).join("；"),
    "- 结构校验：" + (outcome.evidence_validation.status === "passed" ? "通过" : "未通过"),
    "",
    "## 模型如何理解",
    ""
  ];
  if (normalised?.semantic_analysis) {
    lines.push("- 推断的找回目标：" + normalised.semantic_analysis.inferred_retrieval_goal);
    lines.push(markdownList(normalised.semantic_analysis.topics, (topic) => "Topic：**" + topic.title + "**（" + topic.basis + "）— " + topic.rationale));
    lines.push(markdownList(normalised.semantic_analysis.cards, (card) => "Card：**" + card.card_title + "**（" + card.content_role + "）— " + card.specific_object + "；卡面问题：" + card.front_question));
  } else if (outcome.candidate_protocol === CARD_DRAFT_VERSION && rawDraft?.draft_version === CARD_DRAFT_VERSION) {
    lines.push('- 模型输出：语义草稿；来源、卡组、证据 ID 和卡面结构由程序编译。');
    lines.push(markdownList(rawDraft.cards || [], (card) => `**${card.title || '未命名'}**（${card.type || '未归类'}）— ${card.front?.point?.text || '未给出重点'}；操作：${card.front?.action?.text || '未给出操作'}`));
  } else {
    lines.push("- 模型没有提供可用的语义判断。" );
  }
  lines.push("", "## 拟输出", "");
  if (candidate) {
    lines.push("- Topic：" + (candidate.topics || []).map((topic) => "**" + topic.title + "**").join("；"));
    lines.push(markdownList(candidate.cards || [], (card) => {
      const featured = [
        ...(card.presentation?.featured_field_labels || []),
        ...(card.presentation?.featured_path_titles || [])
      ];
      return "**" + card.title + "**（" + card.type + "，" + card.status + "）"
        + "；卡面先展示：" + (featured.join("、") || "未选择")
        + "；引用：" + (card.citations || []).map((citation) => citation.evidence_kind).join("、");
    }));
  } else {
    lines.push("- 候选未通过本地结构闸门，以下请查看校验问题。" );
  }
  lines.push("", "## Topic 归一化（产品层）", "");
  if (topicNormalization.length) {
    lines.push(markdownList(topicNormalization, (item) => {
      if (item.status === "matched") {
        return "原始 Topic：**" + item.raw_title + "** → 规范 Topic：**" + (item.canonical_title || item.display_title) + "**（已匹配" + (item.match_kind ? " " + item.match_kind : "") + "）";
      }
      if (item.status === "needs_review") {
        const suggestion = item.suggestions?.[0];
        return "原始 Topic：**" + item.raw_title + "** → 建议规范 Topic：**" + (suggestion?.title || item.display_title) + "**（待确认；命中 " + (item.matched_terms || []).join("、") + "）";
      }
      return "原始 Topic：**" + item.raw_title + "** → 临时 Topic：**" + item.display_title + "**（尚未匹配分类表）";
    }));
  } else {
    lines.push("- 未执行 Topic 归一化。" );
  }
  lines.push("", "## 校验与待判断", "");
  lines.push("- 候选结构：" + outcome.status);
  lines.push("- 引用校验：" + (outcome.citation_validation?.status || "未执行"));
  lines.push(markdownList(outcome.issues || [], (item) => "[" + item.level + "] " + item.message));
  lines.push("", "## 人工审核问题", "", "1. 这次收藏的未来找回目标，是否被模型理解对了？", "2. 主题是否能聚合同类收藏，类型是否符合具体内容？", "3. 子卡是否能独立使用；总览是否有比较或导航价值，是否误拆或漏拆？", "4. 卡面是否简短且抓住重点，操作是否有用，来源与资源是否区分清楚？");
  return lines.join("\n") + "\n";
}

function failureSummary(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Produces a candidate audit for a fresh evidence bundle. It never writes to
 * the product card database and intentionally has no Golden Set comparison.
 */
export async function evaluateFreshEvidenceCandidate({ root, evidenceDocument, apiKey, model = "glm-5.2", provider = null, send = false, candidateProtocol = null, publicationPolicy = null, topicContextOverride = null, callModel = null, onProgress = async () => {} }) {
  candidateProtocol = candidateProtocol || process.env.HERMES_CANDIDATE_PROTOCOL || CARD_DRAFT_VERSION;
  if (candidateProtocol === 'legacy-v3') candidateProtocol = AI_CANDIDATE_SCHEMA_VERSION;
  if (![CARD_DRAFT_VERSION, AI_CANDIDATE_SCHEMA_VERSION].includes(candidateProtocol)) {
    throw new Error('HERMES_CANDIDATE_PROTOCOL 只能是 hermes/card-draft/v1 或 legacy-v3。');
  }
  if (publicationPolicy !== null && !['automatic', 'review_required'].includes(publicationPolicy)) {
    throw new Error('无效的候选发布策略');
  }
  const evidenceValidation = validateEvidenceDocument(evidenceDocument);
  const runId = safePathSegment("fresh_" + evidenceDocument.source.id + "_" + nowIso());
  const directory = path.join(root, "runtime", "fresh-candidates", safePathSegment(evidenceDocument.source.id), runId);
  const projection = projectEvidenceForModel(evidenceDocument);
  const topicContext = topicContextOverride || await loadTopicContext(root);
  const baseRequest = buildFreshEvidenceAiRequest({ evidenceDocument: projection.document, topicContext });
  const request = candidateProtocol === CARD_DRAFT_VERSION ? buildCardDraftRequest(baseRequest) : baseRequest;
  await onProgress({ stage: 'card_prepare', message: '正在读取证据并整理成模型输入。' });
  writeJson(path.join(directory, "request.json"), request);
  writeJson(path.join(directory, "evidence.json"), evidenceDocument);
  writeJson(path.join(directory, "evidence-validation.json"), evidenceValidation);
  writeJson(path.join(directory, "model-evidence.json"), projection.document);
  writeJson(path.join(directory, "model-evidence-projection.json"), projection.audit);

  const prepared = {
    status: "prepared",
    directory,
    request_path: path.join(directory, "request.json"),
    evidence_validation: evidenceValidation,
    model_evidence_path: path.join(directory, "model-evidence.json"),
    model_evidence_projection_path: path.join(directory, "model-evidence-projection.json"),
    candidate_protocol: candidateProtocol,
    ...(publicationPolicy ? { publication_policy: publicationPolicy } : {}),
    source_id: evidenceDocument.source.id,
    source_title: evidenceDocument.source.title
  };
  if (evidenceValidation.status !== "passed" || !send) return prepared;

  try {
    await onProgress({ stage: 'card_provider', message: `模型配置已就绪，将使用 ${provider?.model || model} 处理这条收藏。` });
    const result = callModel
      ? await callModel({ request, provider, apiKey, model, onProgress })
      : provider
      ? await callOpenAICompatible({
          request,
          apiKey: provider.apiKey || apiKey,
          model: provider.model || model,
          endpoint: provider.endpoint,
          providerName: provider.name || 'AI 供应商',
          providerId: provider.kind === 'zhipu' ? 'zhipu' : (provider.id || 'custom'),
          maxOutputTokens: provider.maxOutputTokens,
          contextWindowTokens: provider.contextWindowTokens,
          onProgress
        })
      : await callZhipuPlatform({ request, apiKey, model, onProgress });
    await onProgress({ stage: 'card_validate', message: '模型结果已收到，正在检查卡片结构、引用和可用性。' });
    const inputRecord = freshInputRecord(evidenceDocument);
    const referenceFixture = freshReferenceFixture(evidenceDocument);
    if (candidateProtocol === CARD_DRAFT_VERSION) writeJson(path.join(directory, 'draft-raw.json'), result.candidate);
    const compilation = candidateProtocol === CARD_DRAFT_VERSION
      ? compileCardDraft({ draft: result.candidate, evidenceDocument, request, topicCatalog: topicContext,
        requireSemanticSegments: true })
      : null;
    if (compilation) {
      writeJson(path.join(directory, 'compile-audit.json'), { ...compilation.audit, errors: compilation.errors, warnings: compilation.warnings });
    }
    const rawCandidate = compilation ? compilation.candidate : result.candidate;
    const repaired = rawCandidate
      ? repairModelCandidate({ candidate: rawCandidate, evidenceDocument, evidenceUnits: request.evidence_units })
      : { candidate: null, repairs: [] };
    const normalised = repaired.candidate
      ? normaliseModelCandidate({ referenceFixture, inputRecord, candidate: repaired.candidate })
      : { status: 'rejected', errors: compilation?.errors || [] };
    const candidateValidation = normalised.status === "normalised"
      ? validateCandidate({ root, fixture: normalised.fixture, inputRecord })
      : { status: "failed", issues: normalised.errors || [] };
    const citationValidation = repaired.candidate
      ? validateCardEvidenceReferences({ candidate: repaired.candidate, evidenceDocument })
      : { status: 'failed', issues: [] };
    const topicNormalization = normalised.status === "normalised"
      ? (compilation
          ? repaired.candidate.topics.map((topic) => ({
              raw_title: topic.title, display_title: topic.title,
              status: topic.catalog_id ? 'matched' : 'provisional',
              canonical_topic_id: topic.catalog_id || null, canonical_title: topic.catalog_id ? topic.title : null,
              suggestions: []
            }))
          : [])
      : [];
    const issues = [
      ...(compilation?.warnings || []),
      ...(repaired.repairs.length ? [{ level: 'warning', code: 'candidate_repaired', message: `已确定性修复 ${repaired.repairs.length} 处模型输出结构或引用偏差；原始候选已保留。` }] : []),
      ...(normalised.errors || []),
      ...(normalised.warnings || []),
      ...(candidateValidation.issues || []),
      ...(citationValidation.issues || [])
    ];
    const passed = normalised.status === "normalised" && candidateValidation.status === "passed" && citationValidation.status === "passed";
    const status = passed ? (compilation?.warnings?.length || normalised.warnings?.length || repaired.repairs.length
      ? "accepted_with_warnings" : "accepted_by_gates") : "rejected_by_gates";
    const outcome = {
      ...prepared,
      status,
      receipt: result.receipt,
      candidate_repairs: repaired.repairs,
      normalised,
      candidate_validation: candidateValidation,
      citation_validation: citationValidation,
      topic_normalization: topicNormalization,
      issues
    };
    if (rawCandidate) {
      if (repaired.repairs.length) {
        // Keep the pre-repair output for audit. The publication candidate must
        // be exactly the version that passed normalisation and both gates.
        writeJson(path.join(directory, "candidate-unrepaired.json"), rawCandidate);
        writeJson(path.join(directory, "candidate-repaired.json"), repaired.candidate);
      }
      writeJson(path.join(directory, "candidate.json"), repaired.candidate);
    }
    writeJson(path.join(directory, "receipt.json"), result.receipt);
    writeJson(path.join(directory, "candidate-validation.json"), candidateValidation);
    writeJson(path.join(directory, "citation-validation.json"), citationValidation);
    writeJson(path.join(directory, "topic-normalization.json"), topicNormalization);
    writeJson(path.join(directory, "outcome.json"), outcome);
    const reviewPath = path.join(root, "outputs", "fresh-candidate-reviews", safePathSegment(evidenceDocument.source.id), runId + ".md");
    writeText(reviewPath, buildFreshCandidateReview({ evidenceDocument, outcome, topicNormalization,
      rawDraft: candidateProtocol === CARD_DRAFT_VERSION ? result.candidate : null }));
    return { ...outcome, review_path: reviewPath };
  } catch (error) {
    if (error instanceof ModelCandidateParseError) {
      writeText(path.join(directory, "raw-model-content.txt"), error.rawContent);
      writeJson(path.join(directory, "parse-diagnostic.json"), {
        provider_receipt: error.receipt,
        error_code: error.code,
        parse_mode: error.parseMode,
        message: error.message
      });
    }
    const outcome = { ...prepared, status: "call_failed", message: failureSummary(error) };
    writeJson(path.join(directory, "outcome.json"), outcome);
    return outcome;
  }
}
