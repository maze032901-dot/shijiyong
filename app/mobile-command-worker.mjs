import { activateProvider, listPublicProviders, loadProviderSettings, removeProvider, saveProvider, testProviderConnection } from './ai-provider-store.mjs';
import { readCloudStatusConfig } from './cloud-status.mjs';
import { enqueueLocalRetry } from './local-retry-queue.mjs';
import { decryptMobileCommand, mobileCommandKeyPair } from './mobile-command-crypto.mjs';
import { loadCardProcessingStatuses, writeCardProcessingStatus } from './card-processing-status.mjs';
import { resolveRetryStage } from './retry-stage.mjs';

async function request(config, pathname, { method = 'GET', body } = {}, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.baseUrl}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok && response.status !== 204) throw new Error(`手机命令服务返回 HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export function mobileWorkerConfig(cloudConfig, env = process.env) {
  const token = String(env.HERMES_MOBILE_PUBLISH_TOKEN || cloudConfig?.mobilePublishToken || '').trim();
  return cloudConfig?.baseUrl && token.length >= 24 ? { baseUrl: cloudConfig.baseUrl, token } : null;
}

export async function registerMobileWorker({ projectDirectory, config, fetchImpl = fetch }) {
  if (!config) return { kind: 'not_configured' };
  const pair = await mobileCommandKeyPair(projectDirectory);
  await request(config, '/api/mac/mobile/public-key', { method: 'PUT', body: { publicKey: pair.publicKey } }, fetchImpl);
  await request(config, '/api/mac/mobile/providers', { method: 'PUT', body: await listPublicProviders(projectDirectory) }, fetchImpl);
  return { kind: 'registered', fingerprint: pair.fingerprint };
}

async function performCommand({ projectDirectory, command, cloudConfig, privateKey, fetchImpl }) {
  if (command.action === 'dismiss') {
    const result = await request({ baseUrl: cloudConfig.baseUrl, token: cloudConfig.token }, '/api/intake/dismiss', { method: 'POST', body: { event_id: command.eventId } }, fetchImpl);
    return `已移出待处理：${result.event_id}`;
  }
  if (command.action === 'retry') {
    const intakeConfig = { baseUrl: cloudConfig.baseUrl, token: cloudConfig.token };
    const jobs = await request(intakeConfig, '/api/intake/jobs', {}, fetchImpl);
    const job = jobs.jobs.find((item) => item.eventId === command.eventId);
    if (!job) throw new Error('收藏任务不存在');
    const statuses = await loadCardProcessingStatuses(projectDirectory);
    const plan = await resolveRetryStage({ projectDirectory, job, localStatus: statuses.get(command.eventId) });
    if (plan.kind === 'unavailable') throw new Error(plan.reason);
    if (plan.kind === 'completed') {
      await request(intakeConfig, '/api/intake/complete', { method: 'POST', body: { event_id: command.eventId } }, fetchImpl);
      return '已有正式卡片，已确认完成';
    }
    if (plan.kind === 'card' || plan.kind === 'evidence') {
      await enqueueLocalRetry(projectDirectory, command.eventId, plan);
      await writeCardProcessingStatus(projectDirectory, command.eventId, { status: 'processing', stage: plan.kind === 'card' ? 'retry_card' : 'retry_evidence', message: `${plan.label}，等待本机处理器接手。` });
      return plan.label;
    }
    await request(intakeConfig, '/api/intake/retry', { method: 'POST', body: { event_id: command.eventId, reason: 'manual' } }, fetchImpl);
    return '抓取阶段已重新入队';
  }
  if (command.action.startsWith('provider_')) {
    const input = decryptMobileCommand(command.payload, privateKey);
    let result;
    try {
      if (command.action === 'provider_save') result = `已保存供应商 ${String((await saveProvider(projectDirectory, input)).name).slice(0, 80)}`;
      else if (command.action === 'provider_activate') result = `已启用供应商 ${await activateProvider(projectDirectory, String(input.id || ''))}`;
      else if (command.action === 'provider_delete') { await removeProvider(projectDirectory, String(input.id || '')); result = '供应商已删除'; }
      else if (command.action === 'provider_test') {
        const saved = input.id ? (await loadProviderSettings(projectDirectory)).providers.find((item) => item.id === input.id) : null;
        const tested = await testProviderConnection({ ...saved, ...input, apiKey: input.apiKey || saved?.apiKey });
        result = `连接成功：${tested.model} · ${tested.latencyMs} ms`;
      }
    } catch (error) {
      const secret = String(input.apiKey || '');
      if (secret) error.message = String(error.message).split(secret).join('[REDACTED]');
      throw error;
    }
    await request(mobileWorkerConfig(cloudConfig), '/api/mac/mobile/providers', { method: 'PUT', body: await listPublicProviders(projectDirectory) }, fetchImpl);
    return result;
  }
  throw new Error('不支持的手机命令');
}

export async function drainMobileCommands({ projectDirectory, cloudConfig, fetchImpl = fetch, onResult = () => {} }) {
  cloudConfig ||= await readCloudStatusConfig(projectDirectory);
  const config = mobileWorkerConfig(cloudConfig);
  if (!config) return { kind: 'not_configured', count: 0 };
  const pair = await mobileCommandKeyPair(projectDirectory);
  let count = 0;
  while (count < 20) {
    const next = await request(config, '/api/mac/mobile/commands/next', { method: 'POST' }, fetchImpl);
    if (!next?.command) break;
    const command = next.command;
    let result;
    try { result = { ok: true, result: await performCommand({ projectDirectory, command, cloudConfig, privateKey: pair.privateKey, fetchImpl }) }; }
    catch (error) { result = { ok: false, result: String(error?.message || error).replace(/https?:\/\/\S+/g, '<redacted-url>').slice(0, 240) }; }
    await request(config, `/api/mac/mobile/commands/${command.id}/result`, { method: 'POST', body: result }, fetchImpl);
    onResult({ id: command.id, action: command.action, ...result });
    count += 1;
  }
  return { kind: 'drained', count };
}
