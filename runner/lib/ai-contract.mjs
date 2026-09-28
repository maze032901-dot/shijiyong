import { buildEvidenceDocument, EVIDENCE_PROTOCOL_VERSION } from "./evidence-contract.mjs";
import { generationRules, GENERATION_RULES_VERSION, cardGranularity } from './generation-policy.mjs';
import { buildModelEvidenceDocument, organizeEvidenceDocument, renderUnitsForModel } from "./evidence-units.mjs";
import { AI_CANDIDATE_SCHEMA_VERSION, buildResponseContract, emptyCandidateTemplate } from "./candidate-response-contract.mjs";
import { cardTypeIds, cardTypePromptGuide } from './card-type-registry.mjs';

export { AI_CANDIDATE_SCHEMA_VERSION, emptyCandidateTemplate } from "./candidate-response-contract.mjs";

const protocolInstructions = `
候选协议适配（规则版本 ${GENERATION_RULES_VERSION}）：
1. 只输出紧凑 JSON（不要 Markdown、解释文字或多余缩进），严格遵守 response_contract.output_template。schema_version 必须等于 schema_version_exact；source_understanding 是对象，citations 每项是 {"evidence_id":"证据 ID"}。
2. 不生成数据库 ID、用户行为、无证据的推荐或排序。semantic_analysis 仅给出简短的组织依据、找回目标与卡面问题，不宣称真实收藏动机，不补充外部事实。presentation 只选择本卡已生成的字段或路径，不新增事实。
3. 每张模型卡至少引用一个真正支持本卡内容的 evidence_id；只选能支撑卡片核心内容的必要证据，不把相似的 ASR/OCR 片段全部列进 citations。不存在的地址、Prompt 原文或图片细节放 missing，不编造。
4. 原视频、原帖 URL 由 citations 关联作为来源入口，不放 resources 或冒充工具入口。评论区等获取线索用 source_claim 内容字段与 paths 表达“打开来源后查找”；resources 可标 missing，不能因此把有用内容自动判 unavailable。
5. type 从 response_contract.allowed_values.card_type 中选，依据下方运行时类型目录及内容用途判断，不靠标题关键词硬匹配。没有具体推荐对象的知识清单可用 knowledge + subtype=list，不为清单另造类型。当前目录都不贴切时用 generic_unknown，并在 subtype 写明具体内容形态，不能为凑类型歪曲内容。仅做效果预览不选 image_asset。主题动态，不等于类型。
6. status 仅为 ready、partial、needs_confirmation、unavailable：ready 为具备最低可用内容；有用但缺部分资源可 partial；关键事实分歧需确认用 needs_confirmation；没有可用内容也无获取线索用 unavailable。不要为了写失败原因凑一个空的成功卡。
7. content_fields.kind 仅为 text、prompt、list、image_reference；claim_kind 仅为 observed_fact、source_claim、source_opinion、ai_summary、externally_verified。口播效果数字、性能、准确率、承诺用 source_claim，偏好排名用 source_opinion，不得仅凭识别结果写已验证。
8. resources.type 仅为 github、website、app_store、plugin_page、prompt_text、image_file、other；availability 仅为 available、missing、unverified。available 的网站资源必须有输入中的 URL；未核实的地址标 unverified。Prompt 卡包含 prompt_text 资源状态；有完整文本时用 content_fields 的 prompt 字段保存，并使操作指向可复制正文，正文缺失时资源标 missing。
9. presentation.intent 仅为 function_entry、method_options、experience_judgement、prompt_use、concept_learning、visual_reference、general_retrieval。featured_field_labels / featured_path_titles 必须逐字引用本卡字段名/路径名，至少一项；路径名只能放在 featured_path_titles，不能当成字段名。专门生成简短重点字段并选择它，不要求展示全量条目。
10. 卡片类型及可用卡面意图以运行时类型目录为准。类型表示用户日后如何使用内容，卡面意图表示当前卡面突出什么；两者独立判断。来源中有体验评价才用 experience_judgement，并注明观点来源。方法字段与同一完整步骤路径不能同时前置。实际可复制指令用 prompt_use。
11. 只在证据确有冲突时输出 identity_conflicts。collections 仅表示同一来源的两张及以上卡片：如果本次只生成一张卡，必须输出 "collections": []，不能为这张卡建立单成员集合。集合不能替代有内容的总览卡。当前生产协议尚无持久化卡片引用字段：把总览/子项的简短组织说明放 source_understanding.notes，用 collections 表示同源，不虚构 related_card_ids 或假装关系已保存；主题聚类不写成同一来源。
12. 只按响应协议输出字段。不要求用户填写禁止生成内容，不读取旧 Golden Set 卡片答案，不按历史示例的卡数生成。
`;

function systemPromptFor(topicContext) {
  const contextInstruction = topicContext
    ? `\n运行时主题上下文：topic_context 是当前产品的宽主题目录。语义匹配时，topics.title 优先逐字使用目录中的已有主题名称；当前候选协议不输出主题 ID。aliases 和 examples 只是辅助理解，不是关键词硬匹配。确实不匹配时，输出可容纳同类内容的新主题名称，不造 ID，也不要为单条内容写过窄的文件夹名。\n`
    : "";
  return generationRules + contextInstruction + protocolInstructions + `\n运行时卡片类型目录（${cardTypeIds.length} 类）：${cardTypePromptGuide()}\n`;
}

function serialiseEvidence(evidence) {
  const result = {
    evidence_id: evidence.id,
    evidence_kind: evidence.kind,
    locator: evidence.locator,
    sha256: evidence.sha256
  };
  if (evidence.kind === "note_text") result.text = evidence.text;
  return result;
}

export function buildAiRequest({ fixture, inputRecord, mediaKind, mediaSignals, topicContext = null }) {
  const evidenceIds = inputRecord.evidence.map((item) => item.id);
  const evidenceDocument = buildEvidenceDocument({ source: fixture.source, inputRecord, mediaKind, mediaSignals });
  return buildRequestFromEvidenceDocument({
    source: fixture.source,
    evidenceDocument,
    evidenceIds,
    legacyEvidence: inputRecord.evidence.map(serialiseEvidence),
    topicContext
  });
}

/**
 * Prepares a model request from a real-time capture without inventing a Golden
 * Set fixture. The complete canonical envelope is retained, including ASR and
 * OCR items; this is deliberately separate from the compatibility-only legacy
 * evidence list used by old note fixtures.
 */
export function buildFreshEvidenceAiRequest({ evidenceDocument, topicContext = null }) {
  if (!evidenceDocument?.source?.id || !Array.isArray(evidenceDocument.items)) {
    throw new Error("新鲜证据包缺少 source.id 或 items，无法生成候选请求。");
  }
  return buildRequestFromEvidenceDocument({
    source: evidenceDocument.source,
    evidenceDocument,
    evidenceIds: evidenceDocument.items.map((item) => item.id),
    legacyEvidence: [],
    topicContext
  });
}

function buildRequestFromEvidenceDocument({ source, evidenceDocument, evidenceIds, legacyEvidence, topicContext = null }) {
  const evidenceUnits = organizeEvidenceDocument({ evidenceDocument });
  const citableUnitEvidenceIds = [...new Set(evidenceUnits.units.flatMap((unit) => [
    unit.image?.evidence_id,
    ...unit.ocr.map((item) => item.evidence_id),
    ...unit.asr.map((item) => item.evidence_id)
  ].filter(Boolean)))];
  return {
    request_version: "hermes-ai-request/v1",
    candidate_schema_version: AI_CANDIDATE_SCHEMA_VERSION,
    evidence_protocol_version: EVIDENCE_PROTOCOL_VERSION,
    mode: "prepare_only",
    generation_rules_version: GENERATION_RULES_VERSION,
    system_prompt: systemPromptFor(topicContext),
    source: {
      id: source.id,
      kind: source.kind,
      title: source.title,
      evidence_scope: source.evidence_scope,
      status: source.status
    },
    evidence_document: evidenceDocument,
    // The canonical envelope remains available for local audit and citation
    // validation. The model-facing projection is deliberately smaller: it is
    // organized by units and omits hashes, engine logs and support assets.
    evidence_units: evidenceUnits,
    evidence_units_text: renderUnitsForModel(evidenceUnits),
    model_evidence_document: buildModelEvidenceDocument({ evidenceDocument, organized: evidenceUnits }),
    evidence: legacyEvidence,
    ...(topicContext ? { topic_context: topicContext } : {}),
    response_contract: buildResponseContract({ sourceId: source.id, evidenceIds: citableUnitEvidenceIds.length ? citableUnitEvidenceIds : evidenceIds }),
    card_granularity: { ...cardGranularity },
    key_handling: {
      api_key_not_included: true,
      expected_environment_variable: "ZAI_API_KEY"
    }
  };
}
