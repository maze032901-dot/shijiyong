import { readFile } from 'node:fs/promises';
import path from 'node:path';

export class CloudStatusError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message);
    this.name = 'CloudStatusError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function readCloudStatusConfig(projectDirectory, env = process.env) {
  if (env.HERMES_CLOUD_URL && env.HERMES_CLOUD_TOKEN) {
    return validateConfig({ baseUrl: env.HERMES_CLOUD_URL, token: env.HERMES_CLOUD_TOKEN, mobilePublishToken: env.HERMES_MOBILE_PUBLISH_TOKEN });
  }

  const configPath = path.join(projectDirectory, 'runtime', 'cloud-status.local.json');
  try {
    const raw = await readFile(configPath, 'utf8');
    return validateConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof CloudStatusError) throw error;
    if (error?.code === 'ENOENT') {
      throw new CloudStatusError('CONFIG_MISSING', '尚未配置云端连接，请先运行 npm run configure:cloud-status', 503);
    }
    throw new CloudStatusError('CONFIG_INVALID', '云端连接配置无法读取，请重新运行配置命令', 503);
  }
}

export function validateConfig(input) {
  const baseUrl = String(input?.baseUrl ?? '').trim().replace(/\/+$/, '');
  const token = String(input?.token ?? '').trim();
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new CloudStatusError('CONFIG_INVALID', '云端地址格式不正确', 503);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CloudStatusError('CONFIG_INVALID', '云端地址必须是无账号、参数和锚点的 HTTPS 基础地址', 503);
  }
  if (token.length < 20) {
    throw new CloudStatusError('CONFIG_INVALID', '接收密钥格式不正确', 503);
  }
  const mobilePublishToken = String(input?.mobilePublishToken ?? '').trim();
  if (mobilePublishToken && mobilePublishToken.length < 24) throw new CloudStatusError('CONFIG_INVALID', 'Mac 发布凭据至少需要 24 个字符', 503);
  return { baseUrl, token, mobilePublishToken: mobilePublishToken || null };
}

export async function fetchCloudJobs(config, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}/api/intake/jobs`, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new CloudStatusError(
      timeout ? 'CLOUD_TIMEOUT' : 'CLOUD_UNREACHABLE',
      timeout ? '连接云端超时，请稍后重试' : '无法连接云端，请检查网络和临时地址是否有效',
      502
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new CloudStatusError('AUTH_FAILED', '云端接收密钥无效，请重新配置', 502);
  }
  if (response.status === 404) {
    throw new CloudStatusError('ENDPOINT_NOT_FOUND', '云端队列接口不存在，临时地址可能已经变化', 502);
  }
  if (!response.ok) {
    throw new CloudStatusError('CLOUD_ERROR', `云端暂时不可用（HTTP ${response.status}）`, 502);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CloudStatusError('INVALID_RESPONSE', '云端返回了无法识别的数据', 502);
  }
  if (!Array.isArray(payload?.jobs)) {
    throw new CloudStatusError('INVALID_RESPONSE', '云端返回缺少任务列表', 502);
  }
  return payload.jobs;
}

export async function manageCloudJob(config, action, eventId, fetchImpl = fetch) {
  if (!['retry', 'dismiss', 'complete'].includes(action) || !/^[A-Za-z0-9._-]{6,128}$/.test(eventId)) {
    throw new CloudStatusError('INVALID_ACTION', '收藏操作无效', 400);
  }
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}/api/intake/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(action === 'retry' ? { event_id: eventId, reason: 'manual' } : { event_id: eventId }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    throw new CloudStatusError('CLOUD_UNREACHABLE', '云端暂时无法连接，请稍后重试', 502);
  }
  if (response.status === 404) throw new CloudStatusError('ENDPOINT_NOT_FOUND', '云端尚未更新此操作，或收藏记录已不存在', 502);
  if (response.status === 401 || response.status === 403) throw new CloudStatusError('AUTH_FAILED', '云端接收密钥无效，请重新配置', 502);
  if (response.status === 409) throw new CloudStatusError('INVALID_STATUS', '这条收藏的状态已变化，请刷新后重试', 409);
  if (!response.ok) throw new CloudStatusError('CLOUD_ERROR', `云端操作未完成（HTTP ${response.status}）`, 502);
  return response.json();
}

export function summarizeCloudJobs(jobs) {
  const summary = { total: jobs.length, captured: 0, partial: 0, processing: 0, retryable: 0, failed: 0, queued: 0, published: 0, dismissed: 0 };
  for (const job of jobs) {
    if (Object.hasOwn(summary, job.status)) summary[job.status] += 1;
  }
  return summary;
}
