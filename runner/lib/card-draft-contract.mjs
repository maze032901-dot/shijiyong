import { generationRules } from './generation-policy.mjs';
import { cardTypes } from './card-type-registry.mjs';

export const CARD_DRAFT_VERSION = 'hermes/card-draft/v1';

const draftInstructions = `
草稿协议（${CARD_DRAFT_VERSION}）：
只输出一个紧凑 JSON 对象，不要 Markdown。模型只判断语义，不填写来源 ID、数据库 ID、卡组结构、媒体 URL、正式卡面字段引用或正式证据 ID。
按独立使用价值决定 cards 数量，不能为了组卡而多造总览卡；每张卡都必须有可用内容，不能发布空卡。
每张卡选择现有 topic_context 中的稳定 existing_id；真正没有合适主题时才提出可复用的 new_title 与 reason。类型按运行时目录的用途判断，不凭标题关键词。
front.point 是简短重点，front.action 是有用的下一步；完整、可复制的 Prompt 放 details 中 kind=prompt，不可用摘要冒充。OCR/ASR 拼接、修正或改写后的 Prompt 标作“整理后的提示词”，不要称为逐字“原文”；只有来源可逐字核对时才可称原文。每条关键内容的 evidence_refs 只用下方 E 编号；它们一对一对应原始证据项，不能编造。OCR/ASR 可能有误，来源观点和未经核实的效果用 source_claim/source_opinion，不写 externally_verified。
front.action 只写已可执行、对使用者有帮助的动作，不把 availability.missing 或“尚未取得”反复写到卡面。缺少的地址、链接、营业信息等放进 availability.missing 或 resource_mentions.note；只有证据明确提供入口，才说可从某处取得，不猜测来源中有定位或下载链接。
来源 URL 不放 resource_mentions。没有已取得的资源直链时保留获取线索，availability 标 missing 或 unverified，不猜 URL。有用但缺部分资源可 usable=true 并列 missing；完全没有最低可用内容则 usable=false，由程序送待处理。
resource_mentions 非空时，每项用 type（github/website/app_store/plugin_page/prompt_text/image_file/other）、availability（available/missing/unverified）、label（名称）及可选 note/url。只有名称而没有明确链接的地点、产品等线索用 type=other、availability=unverified；不要用 name 代替 label。
只使用 response_contract.output_template 的字段。普通详情用 details[].segments 数组表达内容，text 留空或省略；完整可复制的 Prompt 才用 details[].text 字符串，kind=prompt 时不要输出 segments。步骤用 steps 字符串数组；没有步骤或资源时输出空数组。不要输出 topics、collections、source_id、presentation、citations 等正式发布字段。
详情按语义分层：details 是主题段，segments 是该主题下可独立阅读的最小信息单元。一个 segment 只表达一个观点、对象或一组紧密相关的事实；并列对象、不同归属、结论与核查提醒各自分段，不把它们串进同一 text。可用 label 标示来源明确给出的分组，来源没给标签时 label 留空，不自造分类。kind=list 用于并列清单，kind=text 用于解释段落；真正有先后顺序的操作写入 steps。按内容决定段数，不设固定数量或字数；没有可核对的事实不因排版需要而补造。保持每个详情的 evidence_refs 对应其所有 segments。
分类、例子和未核实提醒遵循来源：OCR/ASR 识别不清的名称与归属明确标为待核查，版面上的分组不代表外部事实已验证。
`;

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function position(value = {}) {
  if (Number.isInteger(value.gallery_index)) return `图文第 ${value.gallery_index} 张`;
  if (Number.isFinite(value.start_seconds)) return `${value.start_seconds}s–${value.end_seconds ?? '?'}s`;
  if (Number.isFinite(value.timestamp_seconds)) return `${value.timestamp_seconds}s`;
  return '位置未知';
}

/** Model-visible handles always identify one original evidence item, never a multi-item unit. */
export function draftEvidenceHandles(request) {
  const handles = {};
  const byEvidenceId = new Map();
  const lines = [`来源：${request.evidence_units?.source?.title || request.source?.title || '未命名来源'}`];
  const source = request.evidence_units?.source || {};
  if (source.description) lines.push(`简介：${source.description}`);
  if (source.source_text) lines.push(`来源正文：${source.source_text}`);
  lines.push('以下 E 编号各对应一条原始证据；仅用 E 编号引用。图片只提供定位和 OCR，没有图片像素输入；时间相近的 ASR 不自动证明图片内容。');

  const add = (record, kind, prefix = '') => {
    const id = text(record?.evidence_id);
    if (!id) return null;
    let handle = byEvidenceId.get(id);
    if (!handle) {
      handle = `E${String(byEvidenceId.size + 1).padStart(4, '0')}`;
      byEvidenceId.set(id, handle);
      handles[handle] = id;
    }
    lines.push(`${prefix}${handle} ${kind}：${text(record?.text) || '仅有素材定位，未提供图片像素。'}`);
    return handle;
  };

  const metadataId = source.metadata_evidence_id;
  if (metadataId) {
    const metadata = request.evidence_document?.items?.find((item) => item.id === metadataId);
    if (metadata?.text) add({ evidence_id: metadataId, text: metadata.text }, '发布简介');
  }
  for (const unit of request.evidence_units?.units || []) {
    lines.push(`\n位置：${position(unit.position)}；画面/口播关系：${unit.association?.status || 'unknown'}`);
    if (unit.image) add(unit.image, '原图');
    for (const item of unit.ocr || []) add(item, 'OCR');
    for (const item of unit.asr || []) add(item, `ASR ${position(item)}`);
  }
  return { handles, text: lines.join('\n') };
}

export function buildCardDraftRequest(request) {
  const evidence = draftEvidenceHandles(request);
  return {
    ...request,
    request_version: 'hermes-ai-request/draft-v1',
    candidate_schema_version: CARD_DRAFT_VERSION,
    system_prompt: generationRules + '\n' + draftInstructions
      + '\n运行时类型目录：' + cardTypes.map(({ id, label, description }) => `${id}（${label}：${description}）`).join('；') + '\n',
    evidence_units_text: evidence.text,
    evidence_handles: evidence.handles,
    response_contract: {
      draft_version_exact: CARD_DRAFT_VERSION,
      output_template: {
        draft_version: CARD_DRAFT_VERSION,
        group_label: '<同来源有多张卡时使用的简短语义标题>',
        source_needs: { visual: false, lookup: false },
        cards: [{
          title: '<语义短标题>', type: '<类型 ID>', subtype: '',
          topic: { existing_id: '<topic_context 中的 ID；新主题时改用 new_title 和 reason>' },
          front: {
            point: { text: '<简短重点>', claim_kind: 'ai_summary', evidence_refs: ['E0001'] },
            action: { text: '<有用操作>', evidence_refs: ['E0001'] }
          },
          details: [{ heading: '<语义段标题>', segments: [{ label: '', text: '<一个独立信息单元>' }], text: '', kind: 'text', claim_kind: 'source_claim', evidence_refs: ['E0001'] }],
          steps: [], resource_mentions: [],
          availability: { usable: true, missing: [], conflicts: [] }
        }]
      },
      card_types: cardTypes.map(({ id, label }) => ({ id, label })),
      evidence_ref_rule: '只引用模型输入中的 E 编号；每个编号由程序映射到恰好一个原始 evidence_id。'
    }
  };
}
