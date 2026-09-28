export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export function outputTokenLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_MAX_OUTPUT_TOKENS;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 512 || number > 131072) {
    throw new Error('输出上限须为 512–131072 的整数，并且不能超过模型实际支持的上限。');
  }
  return number;
}

export function contextTokenLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 4096 || number > 4_000_000) {
    throw new Error('上下文容量须为 4096–4000000 的整数；不确定时可留空。');
  }
  return number;
}

// The complete canonical evidence stays in the saved request and local gates.
// Send one chronological, citation-ID-bearing view to the model. Previously
// the same ASR/OCR appeared in the document, unit objects and rendered text.
export function modelUserPayload(request) {
  const unitsText = request.evidence_units_text || request.model_evidence_document?.units_text;
  const evidenceDocument = unitsText
    ? { protocol_version: request.evidence_protocol_version || null, representation: 'ordered_evidence_units', text: unitsText }
    : request.model_evidence_document || request.evidence_document || null;
  return {
    source: request.source,
    evidence_protocol_version: request.evidence_protocol_version || null,
    evidence_document: evidenceDocument,
    topic_context: request.topic_context || null,
    // Legacy prepared requests may have only a compact evidence array.
    ...(!evidenceDocument && request.evidence?.length ? { evidence: request.evidence } : {}),
    response_contract: request.response_contract
  };
}

export function checkModelRequestBudget({ messages, maxOutputTokens, contextWindowTokens }) {
  const characterCount = JSON.stringify(messages).length;
  // A deliberately conservative estimate, not an exact tokenizer. When the
  // model capacity is unknown we do not pretend a universal safe limit exists.
  const estimatedInputTokens = Math.ceil(characterCount * 1.2);
  if (contextWindowTokens && estimatedInputTokens + maxOutputTokens > Math.floor(contextWindowTokens * 0.9)) {
    const error = new Error(`预计输入约 ${estimatedInputTokens} token，加上预留输出 ${maxOutputTokens} token，超过配置的 ${contextWindowTokens} token 上下文安全预算。请求未发送；请核对模型容量或缩减证据，避免无效计费。`);
    error.code = 'model_request_budget_exceeded';
    throw error;
  }
  return { characterCount, estimatedInputTokens, maxOutputTokens, contextWindowTokens: contextWindowTokens || null };
}
