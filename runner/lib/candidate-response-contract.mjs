import { cardTypeIds, cardTypes } from './card-type-registry.mjs';

export const AI_CANDIDATE_SCHEMA_VERSION = "card-engine/ai-candidate/v3";

export function emptyCandidateTemplate(sourceId) {
  return {
    schema_version: AI_CANDIDATE_SCHEMA_VERSION,
    source_id: sourceId,
    source_understanding: { needs_visual: false, needs_lookup: false, notes: [] },
    semantic_analysis: {
      inferred_retrieval_goal: "",
      topics: [],
      cards: []
    },
    topics: [],
    cards: [],
    collections: [],
    candidate_conflicts: []
  };
}

export function buildResponseContract({ sourceId, evidenceIds }) {
  return {
    schema_version_exact: AI_CANDIDATE_SCHEMA_VERSION,
    required_top_level_keys: [
      "schema_version",
      "source_id",
      "source_understanding",
      "semantic_analysis",
      "topics",
      "cards",
      "collections",
      "candidate_conflicts"
    ],
    output_template: emptyCandidateTemplate(sourceId),
    citation_id_rule: "citations.evidence_id 只能使用证据单元内 OCR/ASR/原图记录的 evidence_id；方括号中的 unit_id 仅用于分区阅读，不能作为引用 ID。",
    format_examples: {
      source_understanding: { needs_visual: false, needs_lookup: false, notes: [] },
      semantic_analysis: {
        inferred_retrieval_goal: "<根据证据推断的未来找回目标，不宣称这是用户真实动机>",
        topics: [{ title: "<必须等于 topics 中的一项>", basis: "parent_family", rationale: "<为什么它能聚合同类具体内容>" }],
        cards: [{ card_title: "<必须等于 cards 中的一项>", content_role: "knowledge", specific_object: "<这次收藏的具体对象>", front_question: "<用户打开卡面时最需要先回答的问题>" }]
      },
      citation: { evidence_id: evidenceIds[0] || "<evidence_id>" },
      topic: { title: "<可容纳多张卡的找回类别，例如：导出博主文案的工具>", aliases: [] },
      card: {
        type: "tool",
        title: "<具体收藏对象或功能；正式名称不明时不用平台名>",
        topic_titles: ["<上面的找回类别>"],
        status: "partial",
        presentation: {
          intent: "<从 presentation_intent 中选择的卡面意图>",
          featured_field_labels: ["<本卡已有、应前置的字段名>"],
          featured_path_titles: []
        },
        content_fields: [],
        paths: [],
        resources: [],
        citations: [{ evidence_id: evidenceIds[0] || "<evidence_id>" }],
        missing: [],
        identity_conflicts: []
      },
      content_field: { label: "<字段名>", value: "<证据中的内容>", kind: "text", claim_kind: "observed_fact" },
      presentation: {
        method_example: { intent: "method_options", featured_field_labels: ["路径一", "路径二"], featured_path_titles: [] },
        experience_example: { intent: "experience_judgement", featured_field_labels: ["实际表现", "已知问题", "评测结论"], featured_path_titles: [] },
        function_example: { intent: "function_entry", featured_field_labels: ["工具作用", "工具缺点"], featured_path_titles: [] }
      },
      resource: { type: "other", availability: "missing", note: "<证据未保存入口时说明缺失原因>" }
    },
    topic_shape: { title: "string", aliases: "string[]" },
    semantic_analysis_shape: {
      inferred_retrieval_goal: "string",
      topics: "[{title,basis,rationale}]",
      cards: "[{card_title,content_role,specific_object,front_question}]"
    },
    card_shape: {
      type: "allowed card type",
      subtype: "string or omitted",
      title: "string",
      topic_titles: "string[]",
      status: "allowed status",
      presentation: "{intent,featured_field_labels,featured_path_titles}",
      content_fields: "[{label,value,kind,claim_kind}]",
      paths: "[{title,steps,status}]",
      resources: "[{type,availability,url?,local_path?,note?}]",
      citations: "[{evidence_id}]",
      missing: "[{field,reason}]",
      identity_conflicts: "[{field,candidates,reason}]"
    },
    allowed_values: {
      card_type: cardTypeIds,
      card_type_guide: cardTypes.map(({ id, label, description, intents }) => ({ id, label, description, intents })),
      card_status: ["ready", "partial", "needs_confirmation", "unavailable"],
      presentation_intent: ["function_entry", "method_options", "experience_judgement", "prompt_use", "concept_learning", "visual_reference", "general_retrieval"],
      content_kind: ["text", "prompt", "list", "image_reference"],
      claim_kind: ["observed_fact", "source_claim", "source_opinion", "ai_summary", "externally_verified"],
      resource_type: ["github", "website", "app_store", "plugin_page", "prompt_text", "image_file", "other"],
      resource_availability: ["available", "missing", "unverified"]
    },
    collection_shape: { title: "string", kind: "source_collection", member_card_titles: "string[]" }
  };
}
