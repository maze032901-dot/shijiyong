const ZHIPU_PLATFORM_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
export const MODEL_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;

function buildReceipt(payload, model) {
  const choice = payload.choices?.[0] || {};
  return {
    provider: "zhipu-platform",
    endpoint: ZHIPU_PLATFORM_ENDPOINT,
    model: payload.model || model,
    request_id: payload.request_id || payload.id || null,
    usage: payload.usage || null,
    finish_reason: choice.finish_reason || null
  };
}

export class ModelCandidateParseError extends Error {
  constructor({ message, rawContent, receipt, parseMode = "unparsed", code = "model_candidate_invalid_json" }) {
    super(message);
    this.name = "ModelCandidateParseError";
    this.code = code;
    this.rawContent = rawContent;
    this.receipt = receipt;
    this.parseMode = parseMode;
  }
}

function parseJson(value) {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function parseModelCandidateContent(content, receipt) {
  const trimmed = content.trim();
  const direct = parseJson(trimmed);
  if (direct.ok) return { candidate: direct.value, parseMode: "direct_json" };

  // 只处理内容完全由一个 JSON 代码围栏包裹的情况，避免从混杂文本中猜测性截取 JSON。
  const fenced = trimmed.match(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i);
  if (fenced) {
    const fencedJson = parseJson(fenced[1]);
    if (fencedJson.ok) return { candidate: fencedJson.value, parseMode: "json_fence" };
    throw new ModelCandidateParseError({
      message: "模型返回了 JSON 代码围栏，但围栏内不是有效 JSON；候选结果未被采纳。",
      rawContent: content,
      receipt,
      parseMode: "invalid_json_fence"
    });
  }

  throw new ModelCandidateParseError({
    message: "模型返回内容不是有效 JSON，且不是单独的 JSON 代码围栏；候选结果未被采纳。",
    rawContent: content,
    receipt
  });
}

function responseError(status, body, providerName = '智谱平台') {
  let detail = "";
  try {
    const parsed = JSON.parse(body);
    detail = parsed.error?.message || parsed.message || "";
  } catch {
    detail = body.slice(0, 240);
  }
  return new Error(providerName + "请求失败（HTTP " + status + "）" + (detail ? "：" + detail : ""));
}

function isZhipuEndpoint(endpoint) {
  try {
    return new URL(endpoint).hostname === 'open.bigmodel.cn';
  } catch {
    return false;
  }
}

export function zhipuThinkingOptions(model) {
  const normalized = String(model || '').trim().toLowerCase();
  // The 5.3 family always thinks. The China endpoint accepts low/high/max;
  // use the lowest accepted tier for structured extraction.
  if (/^glm-5\.3(?:-|$)/u.test(normalized)) {
    return { thinking: { type: 'enabled' }, reasoning_effort: 'low' };
  }
  // This exact model has previously accepted disabled thinking in the local
  // production chain. Do not extrapolate that behavior to later GLM models.
  if (normalized === 'glm-5.2') return { thinking: { type: 'disabled' } };
  // Unknown model capabilities: omit the parameter and use provider default.
  return {};
}

export async function callOpenAICompatible({ request, apiKey, model, endpoint, providerName = 'AI 供应商', providerId = 'custom', maxOutputTokens, contextWindowTokens, fetchImpl = fetch, onProgress = async () => {} }) {
  if (!apiKey) throw new Error("当前供应商没有配置 API Key。");
  if (!endpoint) throw new Error("当前供应商没有配置请求地址。");
  if (!model) throw new Error("当前供应商没有配置模型名称。");

  const outputLimit = outputTokenLimit(maxOutputTokens);
  const contextLimit = contextTokenLimit(contextWindowTokens);
  const messages = [
    { role: "system", content: request.system_prompt },
    { role: "user", content: JSON.stringify(modelUserPayload(request)) }
  ];
  const budget = checkModelRequestBudget({ messages, maxOutputTokens: outputLimit, contextWindowTokens: contextLimit });
  const body = {
    model,
    messages,
    response_format: { type: "json_object" },
    stream: false,
    temperature: 0.1,
    max_tokens: outputLimit
  };
  // The settings page allows the official Zhipu endpoint to be saved as a
  // custom OpenAI-compatible provider. Detect the host as well as the legacy
  // provider id, then apply only model capabilities that are known here.
  if (providerId === 'zhipu' || isZhipuEndpoint(endpoint)) {
    Object.assign(body, zhipuThinkingOptions(model));
  }
  // ModelScope exposes reasoning models through an OpenAI-compatible endpoint,
  // but uses its OpenAI client's extra_body convention to disable hidden
  // thinking. Without this, the model can spend the entire output budget on
  // reasoning and return an empty `message.content` with finish_reason=length.
  try {
    if (new URL(endpoint).hostname === 'api-inference.modelscope.cn') {
      // DeepSeek V4 on ModelScope accepts the native REST switch at the top
      // level. Keep the extra-body variants too because ModelScope routes
      // different hosted model templates through slightly different adapters.
      body.enable_thinking = false;
      body.extra_body = {
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false }
      };
    }
  } catch { /* endpoint validation happens in the provider store */ }
  let response;
  await onProgress({ stage: 'card_model_request', message: `正在发送给模型（${model}），预计输入约 ${budget.estimatedInputTokens} token，预留输出 ${outputLimit} token。` });
  await onProgress({ stage: 'card_model_waiting', message: `模型请求已发出，最长等待 ${providerName} 5 分钟返回结果。` });
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(MODEL_RESPONSE_TIMEOUT_MS)
    });
  } catch (error) {
    await onProgress({ stage: 'card_model_failed', message: `${providerName} 暂未返回结果：${error.message}` });
    if (error.name === "TimeoutError" || error.name === "AbortError" || error.cause?.code === 'UND_ERR_HEADERS_TIMEOUT') {
      throw new Error(providerName + "在 5 分钟内未返回结果；候选结果未被保存。请先检查供应商状态，不要连续付费重试。");
    }
    throw new Error(`无法连接${providerName}：` + error.message);
  }
  const rawBody = await response.text();
  if (!response.ok) {
    const error = responseError(response.status, rawBody, providerName);
    await onProgress({ stage: 'card_model_failed', message: error.message });
    throw error;
  }
  await onProgress({ stage: 'card_model_response', message: `已收到 ${providerName} 响应，正在读取模型内容。` });

  let payload;
  try { payload = JSON.parse(rawBody); } catch {
    const error = new Error(providerName + "返回的 HTTP 响应不是 JSON。");
    await onProgress({ stage: 'card_model_failed', message: error.message });
    throw error;
  }
  if (!Array.isArray(payload.choices) || !payload.choices[0]) {
    const detail = payload.error?.message || payload.message || '';
    const usageHint = payload.usage?.total_tokens === 0 ? "，且 usage=0" : "";
    const error = new Error(providerName + "返回空结果（choices 为空" + usageHint + "）" + (detail ? `：${String(detail).slice(0, 180)}` : "。常见原因是额度耗尽、限流、暂不可用或请求格式不兼容。"));
    await onProgress({ stage: 'card_model_failed', message: error.message });
    throw error;
  }
  const content = payload.choices[0]?.message?.content;
  if (typeof content !== "string") {
    const error = new Error(providerName + "返回了候选结果，但内容不是文本 JSON。");
    await onProgress({ stage: 'card_model_failed', message: error.message });
    throw error;
  }
  const receipt = { ...buildReceipt(payload, model), provider: providerId, endpoint, request_budget: budget };
  if (payload.choices[0]?.finish_reason === 'length') {
    const error = new ModelCandidateParseError({
      message: `${providerName} 的输出达到 ${outputLimit} token 上限，JSON 可能被截断；候选未采纳。可在供应商设置中提高输出上限（须受模型支持），或缩短证据。不会自动付费重试。`,
      rawContent: content,
      receipt,
      parseMode: 'output_truncated',
      code: 'model_candidate_output_truncated'
    });
    await onProgress({ stage: 'card_model_failed', message: error.message });
    throw error;
  }
  await onProgress({ stage: 'card_model_parse', message: '正在解析模型返回的 JSON 卡片结果。' });
  let parsed;
  try { parsed = parseModelCandidateContent(content, receipt); }
  catch (error) {
    await onProgress({ stage: 'card_model_failed', message: error.message });
    throw error;
  }

  return {
    candidate: parsed.candidate,
    receipt: { ...receipt, candidate_parse_mode: parsed.parseMode }
  };
}

export async function callZhipuPlatform({ request, apiKey, model = "glm-5.2", fetchImpl = fetch, onProgress = async () => {} }) {
  if (!apiKey) throw new Error("未检测到 ZAI_API_KEY。请由用户在本机环境变量中配置，不能写入项目文件。");
  return callOpenAICompatible({
    request, apiKey, model, fetchImpl,
    endpoint: ZHIPU_PLATFORM_ENDPOINT, providerName: '智谱平台', providerId: 'zhipu', onProgress
  });
}
import { checkModelRequestBudget, contextTokenLimit, modelUserPayload, outputTokenLimit } from './model-request-budget.mjs';
