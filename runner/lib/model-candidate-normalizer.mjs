import { AI_CANDIDATE_SCHEMA_VERSION } from "./ai-contract.mjs";
import { shortHash } from "./utils.mjs";
import { cardTypeById, cardTypeAllowsIntent } from './card-type-registry.mjs';

const allowedStatuses = new Set(["ready", "partial", "needs_confirmation", "unavailable"]);
const allowedContentKinds = new Set(["text", "prompt", "list", "image_reference"]);
const allowedClaimKinds = new Set(["observed_fact", "source_claim", "source_opinion", "ai_summary", "externally_verified"]);
const allowedResourceTypes = new Set(["github", "website", "app_store", "plugin_page", "prompt_text", "image_file", "other"]);
const allowedResourceAvailability = new Set(["available", "missing", "unverified"]);
const allowedPresentationIntents = new Set(["function_entry", "method_options", "experience_judgement", "prompt_use", "concept_learning", "visual_reference", "general_retrieval"]);

function object(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalisedTitle(value) {
  return text(value).replace(/\s+/g, " ").toLowerCase();
}

function uniqueId(prefix, title, occupiedIds) {
  const base = prefix + "_" + shortHash(title || prefix);
  let id = base;
  let suffix = 2;
  while (occupiedIds.has(id)) {
    id = base + "_" + suffix;
    suffix += 1;
  }
  occupiedIds.add(id);
  return id;
}

function error(errors, code, message) {
  errors.push({ level: "error", code, message });
}

function warning(warnings, code, message) {
  warnings.push({ level: "warning", code, message });
}

function uniqueNonEmptyStrings(value) {
  if (!Array.isArray(value) || !value.every((item) => text(item))) return null;
  const values = value.map(text);
  return new Set(values).size === values.length ? values : null;
}

function normalisePresentation({ card, title, errors, warnings }) {
  const presentation = card.presentation;
  if (!object(presentation) || !allowedPresentationIntents.has(presentation.intent)) {
    error(errors, "candidate_presentation", "卡片“" + (title || "未命名") + "”的 presentation.intent 不合法或缺失。");
    return null;
  }
  if (cardTypeById.has(card.type) && !cardTypeAllowsIntent(card.type, presentation.intent)) {
    error(errors, "candidate_presentation_type", "卡片“" + (title || "未命名") + "”的类型“" + card.type + "”不能使用卡面意图“" + presentation.intent + "”。");
    return null;
  }
  let fieldLabels = uniqueNonEmptyStrings(presentation.featured_field_labels);
  let pathTitles = uniqueNonEmptyStrings(presentation.featured_path_titles);
  if (!fieldLabels || !pathTitles || fieldLabels.length + pathTitles.length === 0) {
    error(errors, "candidate_presentation", "卡片“" + (title || "未命名") + "”的 presentation 必须选择至少一个不重复的字段名或路径名。");
    return null;
  }
  const ownFieldLabels = new Set((Array.isArray(card.content_fields) ? card.content_fields : []).map((field) => text(field?.label)));
  const ownPathTitles = new Set((Array.isArray(card.paths) ? card.paths : []).map((item) => text(item?.title)));
  if (presentation.intent === "method_options" && fieldLabels.length > 0 && pathTitles.length > 0) {
    // A model may name an existing path in both lists. Repair only references
    // that exist on this card; never hide an unrelated invalid reference.
    const unknownFields = fieldLabels.filter((label) => !ownFieldLabels.has(label) && !ownPathTitles.has(label));
    const unknownPaths = pathTitles.filter((pathTitle) => !ownPathTitles.has(pathTitle) && !ownFieldLabels.has(pathTitle));
    if (unknownFields.length === 0 && unknownPaths.length === 0) {
      const actualFields = fieldLabels.filter((label) => ownFieldLabels.has(label));
      const actualPaths = pathTitles.filter((pathTitle) => ownPathTitles.has(pathTitle));
      if (actualFields.length > 0) {
        fieldLabels = actualFields;
        pathTitles = [];
        warning(warnings, "candidate_presentation_repaired_method", "方法卡“" + (title || "未命名") + "”同时选择了说明和步骤路径；已保留实际存在的说明字段在卡面，完整步骤放入详情。");
      } else if (actualPaths.length > 0) {
        fieldLabels = [];
        pathTitles = actualPaths;
        warning(warnings, "candidate_presentation_repaired_method", "方法卡“" + (title || "未命名") + "”把步骤路径误写成卡面字段；已保留实际存在的步骤路径。");
      }
    }
  }
  const missingFields = fieldLabels.filter((label) => !ownFieldLabels.has(label));
  const missingPaths = pathTitles.filter((pathTitle) => !ownPathTitles.has(pathTitle));
  if (missingFields.length || missingPaths.length) {
    error(errors, "candidate_presentation_reference", "卡片“" + (title || "未命名") + "”的卡面选择引用了本卡不存在的字段或路径：" + [...missingFields, ...missingPaths].join("、"));
    return null;
  }
  return { intent: presentation.intent, featured_field_labels: fieldLabels, featured_path_titles: pathTitles };
}

const allowedTopicBases = new Set(["retrieval_goal", "parent_family", "capability"]);

function normaliseSemanticAnalysis({ candidate, topics, cards, warnings }) {
  // Draft-v1 keeps semantic decisions in each card rather than asking the
  // model to repeat them in a second analysis tree.
  if (candidate.compiler_origin === 'hermes/card-draft/v1') return null;
  const analysis = candidate.semantic_analysis;
  if (!object(analysis) || !text(analysis.inferred_retrieval_goal) || !Array.isArray(analysis.topics) || !Array.isArray(analysis.cards)) {
    warning(warnings, "candidate_semantic_analysis", "semantic_analysis 缺失或形状不完整；正文候选仍可审核，但无法查看模型的完整语义判断。");
    return null;
  }
  const topicTitles = new Set(topics.map((topic) => normalisedTitle(topic.title)));
  const cardByTitle = new Map(cards.map((card) => [normalisedTitle(card.title), card]));
  const semanticTopics = [];
  const semanticTopicKeys = new Set();
  analysis.topics.forEach((item, index) => {
    const title = text(item?.title);
    if (!object(item) || !title || !allowedTopicBases.has(item.basis) || !text(item.rationale)) {
      warning(warnings, "candidate_semantic_topic", "第 " + (index + 1) + " 条 Topic 语义解释不完整，已保留正文候选供审核。");
      return;
    }
    const key = normalisedTitle(title);
    if (!topicTitles.has(key)) warning(warnings, "candidate_semantic_topic_reference", "语义解释中的 Topic“" + title + "”未对应正式输出 Topic。");
    if (semanticTopicKeys.has(key)) warning(warnings, "candidate_semantic_topic_duplicate", "语义解释重复说明了 Topic“" + title + "”。");
    semanticTopicKeys.add(key);
    semanticTopics.push({ title, basis: item.basis, rationale: text(item.rationale) });
  });
  const semanticCards = [];
  const semanticCardKeys = new Set();
  analysis.cards.forEach((item, index) => {
    const title = text(item?.card_title);
    if (!object(item) || !title || !cardTypeById.has(item.content_role) || !text(item.specific_object) || !text(item.front_question)) {
      warning(warnings, "candidate_semantic_card", "第 " + (index + 1) + " 条 Card 语义解释不完整，已保留正文候选供审核。");
      return;
    }
    const key = normalisedTitle(title);
    const card = cardByTitle.get(key);
    if (!card) warning(warnings, "candidate_semantic_card_reference", "语义解释中的 Card“" + title + "”未对应正式输出 Card。");
    else if (item.content_role !== card.type) warning(warnings, "candidate_semantic_card_type", "语义解释将 Card“" + title + "”称为“" + item.content_role + "”，但正式 Card 类型是“" + card.type + "”。");
    if (semanticCardKeys.has(key)) warning(warnings, "candidate_semantic_card_duplicate", "语义解释重复说明了 Card“" + title + "”。");
    semanticCardKeys.add(key);
    semanticCards.push({
      card_title: title,
      content_role: item.content_role,
      specific_object: text(item.specific_object),
      front_question: text(item.front_question)
    });
  });
  if (semanticTopics.length !== topics.length || semanticCards.length !== cards.length || semanticTopicKeys.size !== topicTitles.size || semanticCardKeys.size !== cardByTitle.size) {
    warning(warnings, "candidate_semantic_coverage", "semantic_analysis 未完整且唯一地解释每一个正式 Topic 与 Card。");
  }
  return {
    inferred_retrieval_goal: text(analysis.inferred_retrieval_goal),
    topics: semanticTopics,
    cards: semanticCards
  };
}

export function normaliseModelCandidate({ referenceFixture, inputRecord, candidate }) {
  const errors = [];
  const warnings = [];
  if (!candidate || typeof candidate !== "object") {
    return { status: "rejected", errors: [{ level: "error", code: "candidate_empty", message: "模型候选结果不是 JSON 对象。" }] };
  }
  if (candidate.schema_version !== AI_CANDIDATE_SCHEMA_VERSION) {
    error(errors, "candidate_schema", "模型候选结果的 schema_version 不正确。");
  }
  if (candidate.source_id !== referenceFixture.source.id) {
    error(errors, "candidate_source", "模型候选结果的 source_id 与当前来源不一致。");
  }
  const understanding = candidate.source_understanding;
  if (!object(understanding)
    || typeof understanding.needs_visual !== "boolean"
    || typeof understanding.needs_lookup !== "boolean"
    || !Array.isArray(understanding.notes)
    || !understanding.notes.every((item) => typeof item === "string")) {
    error(errors, "candidate_source_understanding", "source_understanding 必须是含 needs_visual、needs_lookup 和 notes 的对象。");
  }
  if (!Array.isArray(candidate.topics) || !Array.isArray(candidate.cards) || !Array.isArray(candidate.collections) || !Array.isArray(candidate.candidate_conflicts)) {
    error(errors, "candidate_top_level_shape", "topics、cards、collections 和 candidate_conflicts 必须都是数组。");
  }

  const topicIds = new Set();
  const topicsByTitle = new Map();
  const topics = [];
  (candidate.topics || []).forEach((topic) => {
    const title = text(topic.title);
    const key = normalisedTitle(title);
    if (!title || topicsByTitle.has(key)) {
      error(errors, "candidate_topic", "主题标题为空或重复：" + (title || "未命名主题"));
      return;
    }
    const id = uniqueId("topic_ai", title, topicIds);
    topicsByTitle.set(key, id);
    topics.push({ id, title, aliases: Array.isArray(topic.aliases) ? topic.aliases.filter((item) => text(item)) : [] });
  });
  if (topics.length === 0) error(errors, "candidate_topic", "模型至少要输出一个主题。");

  const evidenceById = new Map((inputRecord.evidence || []).map((item) => [item.id, item]));
  const sourceUrl = text(inputRecord.frontmatter?.source);
  const cardIds = new Set();
  const sourceScopedIds = candidate.compiler_origin === 'hermes/card-draft/v1';
  const idBasis = (title) => sourceScopedIds
    ? `${referenceFixture.source.id}\u0000${normalisedTitle(title)}` : title;
  const cardsByTitle = new Map();
  const cards = [];
  (candidate.cards || []).forEach((card, index) => {
    const title = text(card.title);
    const topicTitles = Array.isArray(card.topic_titles) ? card.topic_titles : [];
    const resolvedTopicIds = topicTitles.map((item) => topicsByTitle.get(normalisedTitle(item))).filter(Boolean);
    if (!title) error(errors, "candidate_card", "第 " + (index + 1) + " 张卡没有标题。");
    if (resolvedTopicIds.length !== topicTitles.length || resolvedTopicIds.length === 0) {
      error(errors, "candidate_card_topic", "卡片“" + (title || index + 1) + "”关联了不存在或为空的主题。");
    }
    if (!allowedStatuses.has(card.status)) {
      error(errors, "candidate_status", "卡片“" + (title || index + 1) + "”的状态不合法。");
    }
    if (!cardTypeById.has(card.type)) {
      error(errors, "candidate_type", "卡片“" + (title || index + 1) + "”的类型不合法。");
    }
    if (card.type === 'generic_unknown' && !text(card.subtype)) {
      error(errors, "candidate_subtype", "卡片“" + (title || index + 1) + "”使用待归类类型时必须写明具体内容形态。");
    }
    if (!Array.isArray(card.citations)) {
      error(errors, "candidate_citation_shape", "卡片“" + (title || index + 1) + "”的 citations 必须是数组。");
    }
    const citations = (Array.isArray(card.citations) ? card.citations : []).map((citation) => {
      if (!object(citation) || typeof citation.evidence_id !== "string") {
        error(errors, "candidate_citation_shape", "卡片“" + (title || index + 1) + "”的每条引用必须是 { evidence_id } 对象。");
        return null;
      }
      const evidence = evidenceById.get(citation.evidence_id);
      if (!evidence) {
        error(errors, "candidate_citation", "卡片“" + (title || index + 1) + "”引用了不存在的 evidence_id。\n");
        return null;
      }
      return { source_id: referenceFixture.source.id, evidence_kind: evidence.kind, locator: evidence.locator };
    }).filter(Boolean);
    if (citations.length === 0) error(errors, "candidate_citation", "卡片“" + (title || index + 1) + "”至少要引用一条证据。");
    if (cardsByTitle.has(normalisedTitle(title))) error(errors, "candidate_card", "模型输出了重复卡片标题：" + title);

    if (!Array.isArray(card.content_fields)) {
      error(errors, "candidate_content_field_shape", "卡片“" + (title || index + 1) + "”的 content_fields 必须是数组。");
    } else {
      card.content_fields.forEach((field) => {
        if (!object(field) || !text(field.label) || !text(field.value) || !allowedContentKinds.has(field.kind) || !allowedClaimKinds.has(field.claim_kind)) {
          error(errors, "candidate_content_field_shape", "卡片“" + (title || index + 1) + "”含有不合法的内容字段。");
        }
        if (object(field) && field.segments !== undefined && (
          !Array.isArray(field.segments) || !field.segments.length || field.kind === 'prompt'
          || !field.segments.every((segment) => object(segment) && text(segment.text)
            && (segment.label === undefined || typeof segment.label === 'string'))
        )) error(errors, "candidate_detail_segments", "卡片“" + (title || index + 1) + "”的详情分段不合法。");
      });
    }
    if (!Array.isArray(card.resources)) {
      error(errors, "candidate_resource_shape", "卡片“" + (title || index + 1) + "”的 resources 必须是数组。");
    } else {
      card.resources.forEach((resource) => {
        if (!object(resource) || !allowedResourceTypes.has(resource.type) || !allowedResourceAvailability.has(resource.availability)) {
          error(errors, "candidate_resource_shape", "卡片“" + (title || index + 1) + "”含有不合法的资源字段。");
        }
        if (sourceUrl && text(resource.url) === sourceUrl) {
          error(errors, "candidate_source_resource", "卡片“" + (title || index + 1) + "”把原始来源 URL 写成了资源入口；来源应只通过 citations 关联。");
        }
      });
    }
    if (!Array.isArray(card.paths)) {
      error(errors, "candidate_path_shape", "卡片“" + (title || index + 1) + "”的 paths 必须是数组。");
    } else {
      card.paths.forEach((item) => {
        if (!object(item) || !text(item.title) || !Array.isArray(item.steps) || !item.steps.every((step) => text(step)) || !allowedStatuses.has(item.status)) {
          error(errors, "candidate_path_shape", "卡片“" + (title || index + 1) + "”含有不合法的使用路径。");
        }
      });
    }

    const presentation = normalisePresentation({ card, title, errors, warnings });
    const id = uniqueId("card_ai", idBasis(title || String(index)), cardIds);
    cardsByTitle.set(normalisedTitle(title), id);
    cards.push({
      id,
      type: card.type,
      ...(text(card.subtype) ? { subtype: text(card.subtype) } : {}),
      title,
      topic_ids: resolvedTopicIds,
      status: card.status,
      ...(presentation ? { presentation } : {}),
      content_fields: Array.isArray(card.content_fields) ? card.content_fields : [],
      paths: Array.isArray(card.paths) ? card.paths : [],
      resources: Array.isArray(card.resources) ? card.resources : [],
      citations,
      missing: Array.isArray(card.missing) ? card.missing : [],
      identity_conflicts: Array.isArray(card.identity_conflicts) ? card.identity_conflicts : []
    });
  });
  if (cards.length === 0) error(errors, "candidate_card", "模型没有输出任何具体内容卡。\n");

  const collectionIds = new Set();
  const collections = [];
  (candidate.collections || []).forEach((collection, index) => {
    const title = text(collection.title);
    const memberTitles = Array.isArray(collection.member_card_titles) ? collection.member_card_titles : [];
    const memberCardIds = memberTitles.map((item) => cardsByTitle.get(normalisedTitle(item))).filter(Boolean);
    if (!title) error(errors, "candidate_collection", "第 " + (index + 1) + " 个来源集合没有标题。");
    if (memberCardIds.length !== memberTitles.length || memberCardIds.length === 0) {
      error(errors, "candidate_collection", "来源集合“" + (title || index + 1) + "”引用了不存在或为空的卡片标题。");
    }
    if (memberCardIds.length === 1) {
      error(errors, "candidate_collection_minimum", "来源集合“" + (title || index + 1) + "”只有一张卡，应省略 collections。");
    }
    collections.push({
      id: uniqueId("collection_ai", idBasis(title || String(index)), collectionIds),
      kind: "source_collection",
      title,
      member_card_ids: memberCardIds
    });
  });

  const semanticAnalysis = normaliseSemanticAnalysis({ candidate, topics, cards, warnings });

  if (errors.length) return { status: "rejected", errors };

  return {
    status: "normalised",
    warnings,
    semantic_analysis: semanticAnalysis,
    fixture: {
      schema_version: "card-engine/v2",
      fixture_id: referenceFixture.fixture_id + "_ai_candidate",
      source: referenceFixture.source,
      topics,
      cards,
      collections,
      acceptance: {
        expected_card_count: cards.length,
        expected_collection_count: collections.length,
        checks: ["由模型生成的候选结果；必须与人工 Golden Set 对照后才能被采纳。"]
      }
    }
  };
}
