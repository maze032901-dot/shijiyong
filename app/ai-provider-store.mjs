import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { contextTokenLimit, outputTokenLimit } from '../runner/lib/model-request-budget.mjs';

const FILE_NAME = 'ai-providers.local.json';
const DEFAULT_ZHIPU_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

function filePath(projectDirectory) { return path.join(projectDirectory, 'runtime', FILE_NAME); }
function clean(value, fallback = '') { return String(value ?? fallback).trim(); }
function validId(value) { return /^[A-Za-z0-9._-]{3,80}$/.test(String(value ?? '')); }
function now() { return new Date().toISOString(); }

function validateEndpoint(value) {
  const raw = clean(value);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('请求地址必须是完整的 HTTPS URL'); }
  const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !localHttp) throw new Error('请求地址必须使用 HTTPS（本机地址可使用 HTTP）');
  if (parsed.username || parsed.password || parsed.hash) throw new Error('请求地址不能包含账号、密码或锚点');
  const pathname = parsed.pathname.replace(/\/+$/, '');
  // The UI accepts the base URL used by OpenAI SDKs (for example /v1 or
  // /v1beta/openai), while our fetch client calls the concrete route directly.
  // Normalise only recognisable versioned bases; leave custom routes untouched.
  if (!/\/chat\/completions$/i.test(pathname) && (pathname === '' || /\/v\d+(?:beta)?(?:\/openai)?$/i.test(pathname))) {
    parsed.pathname = `${pathname}/chat/completions`;
  } else {
    parsed.pathname = pathname;
  }
  return parsed.toString().replace(/\/+$/, '');
}

function normaliseProvider(input, { requireKey = true } = {}) {
  const id = clean(input?.id) || `provider_${randomUUID().slice(0, 8)}`;
  if (!validId(id)) throw new Error('供应商 ID 格式不正确');
  const name = clean(input?.name);
  if (!name) throw new Error('请填写供应商名称');
  const endpoint = validateEndpoint(input?.endpoint || input?.baseUrl);
  const model = clean(input?.model);
  if (!model) throw new Error('请填写默认模型名称');
  const apiKey = clean(input?.apiKey);
  if (requireKey && !apiKey && !input?.keyConfigured) throw new Error('请填写 API Key');
  return {
    id, name, endpoint, model,
    maxOutputTokens: outputTokenLimit(input?.maxOutputTokens),
    contextWindowTokens: contextTokenLimit(input?.contextWindowTokens),
    apiKey: apiKey || null,
    remark: clean(input?.remark),
    kind: clean(input?.kind, 'openai-compatible') || 'openai-compatible',
    createdAt: input?.createdAt || now(), updatedAt: now()
  };
}

async function readStored(projectDirectory) {
  try {
    const parsed = JSON.parse(await readFile(filePath(projectDirectory), 'utf8'));
    if (!parsed || !Array.isArray(parsed.providers)) throw new Error('供应商配置格式不正确');
    return { activeProviderId: parsed.activeProviderId || null, providers: parsed.providers };
  } catch (error) {
    if (error?.code === 'ENOENT') return { activeProviderId: null, providers: [] };
    throw error;
  }
}

async function writeStored(projectDirectory, value) {
  const target = filePath(projectDirectory);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
}

function envFallback(env = process.env) {
  const apiKey = clean(env.ZAI_API_KEY);
  if (!apiKey) return null;
  return {
    id: 'zhipu-env', name: '智谱（环境变量）', endpoint: DEFAULT_ZHIPU_ENDPOINT,
    model: clean(env.HERMES_AUTO_MODEL, 'glm-5.2') || 'glm-5.2', apiKey,
    maxOutputTokens: outputTokenLimit(env.HERMES_MAX_OUTPUT_TOKENS),
    contextWindowTokens: contextTokenLimit(env.HERMES_CONTEXT_WINDOW_TOKENS),
    remark: '来自 ZAI_API_KEY；保存本地供应商后可在页面切换。', kind: 'zhipu',
    source: 'environment'
  };
}

export async function loadProviderSettings(projectDirectory, env = process.env) {
  const stored = await readStored(projectDirectory);
  const providers = stored.providers.map((item) => ({ ...item, endpoint: validateEndpoint(item.endpoint), apiKey: clean(item.apiKey) || null,
    maxOutputTokens: outputTokenLimit(item.maxOutputTokens), contextWindowTokens: contextTokenLimit(item.contextWindowTokens) }));
  const fallback = envFallback(env);
  if (fallback && !providers.some((item) => item.id === fallback.id)) providers.push(fallback);
  return { activeProviderId: stored.activeProviderId || providers[0]?.id || null, providers };
}

export async function activeProvider(projectDirectory, env = process.env) {
  const settings = await loadProviderSettings(projectDirectory, env);
  return settings.providers.find((item) => item.id === settings.activeProviderId) || null;
}

function publicProvider(item) {
  return {
    id: item.id, name: item.name, endpoint: item.endpoint, model: item.model,
    maxOutputTokens: outputTokenLimit(item.maxOutputTokens), contextWindowTokens: contextTokenLimit(item.contextWindowTokens),
    remark: item.remark || '', kind: item.kind || 'openai-compatible',
    keyConfigured: Boolean(item.apiKey), keyHint: item.apiKey ? `••••${item.apiKey.slice(-4)}` : '',
    source: item.source || 'local', createdAt: item.createdAt, updatedAt: item.updatedAt
  };
}

export async function listPublicProviders(projectDirectory, env = process.env) {
  const settings = await loadProviderSettings(projectDirectory, env);
  return { activeProviderId: settings.activeProviderId, providers: settings.providers.map(publicProvider) };
}

export async function saveProvider(projectDirectory, input) {
  const settings = await readStored(projectDirectory);
  const existing = settings.providers.find((item) => item.id === input?.id);
  const provider = normaliseProvider({ ...existing, ...input, apiKey: clean(input?.apiKey) || existing?.apiKey || null, createdAt: existing?.createdAt }, { requireKey: true });
  const providers = settings.providers.filter((item) => item.id !== provider.id);
  providers.push(provider);
  const activeProviderId = settings.activeProviderId || provider.id;
  await writeStored(projectDirectory, { activeProviderId, providers });
  return provider;
}

export async function activateProvider(projectDirectory, id) {
  const settings = await readStored(projectDirectory);
  const visible = await loadProviderSettings(projectDirectory);
  if (!visible.providers.some((item) => item.id === id)) throw new Error('未找到该供应商');
  await writeStored(projectDirectory, { ...settings, activeProviderId: id });
  return id;
}

export async function removeProvider(projectDirectory, id) {
  const settings = await readStored(projectDirectory);
  const providers = settings.providers.filter((item) => item.id !== id);
  if (providers.length === settings.providers.length) throw new Error('未找到该供应商');
  const activeProviderId = settings.activeProviderId === id ? providers[0]?.id || null : settings.activeProviderId;
  await writeStored(projectDirectory, { activeProviderId, providers });
}

export function providerForClient(provider) {
  if (!provider?.apiKey || !provider?.endpoint || !provider?.model) throw new Error('供应商尚未配置完整');
  return { id: provider.id, name: provider.name, endpoint: validateEndpoint(provider.endpoint), model: provider.model, apiKey: provider.apiKey, kind: provider.kind,
    maxOutputTokens: outputTokenLimit(provider.maxOutputTokens), contextWindowTokens: contextTokenLimit(provider.contextWindowTokens) };
}

export async function testProviderConnection(provider, fetchImpl = fetch) {
  const configured = providerForClient(provider);
  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(configured.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${configured.apiKey}` },
      body: JSON.stringify({ model: configured.model, messages: [{ role: 'user', content: '只回复 OK' }], max_tokens: 8, stream: false }),
      signal: AbortSignal.timeout(15_000)
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.code === 'UND_ERR_ABORTED') {
      throw new Error(`连接超时（${new URL(configured.endpoint).hostname}），请检查地址、代理或供应商状态`);
    }
    const host = (() => { try { return new URL(configured.endpoint).hostname; } catch { return configured.endpoint; } })();
    const causeCode = error?.cause?.code || error?.code;
    const detail = causeCode ? `，${causeCode}` : '';
    throw new Error(`无法连接供应商：${host}${detail}。请检查当前网络/代理是否能访问该地址；这不是 API Key 或余额响应`);
  }
  const raw = await response.text();
  if (!response.ok) {
    let detail = '';
    try { detail = JSON.parse(raw).error?.message || JSON.parse(raw).message || ''; } catch { /* omit provider response */ }
    throw new Error(`${provider.name || '供应商'}返回 HTTP ${response.status}${detail ? `：${String(detail).slice(0, 160)}` : ''}`);
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error(`${provider.name || '供应商'}返回的 HTTP 响应不是 JSON`); }
  if (!Array.isArray(payload.choices) || !payload.choices[0]) {
    const detail = payload.error?.message || payload.message || '';
    const usageHint = payload.usage?.total_tokens === 0 ? '，且 usage=0' : '';
    throw new Error(`${provider.name || '供应商'}返回空结果（choices 为空${usageHint}）${detail ? `：${String(detail).slice(0, 160)}` : '，可能是额度耗尽、模型限流、暂不可用或请求格式不兼容'}`);
  }
  return { ok: true, latencyMs: Date.now() - started, model: configured.model };
}

export { DEFAULT_ZHIPU_ENDPOINT, validateEndpoint };
