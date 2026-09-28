import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { evaluateFreshEvidenceCandidate } from '../runner/lib/fresh-evidence-candidate.mjs';
import { publishFixture } from '../runner/lib/publish-fresh-candidate.mjs';
import { CARD_DRAFT_VERSION } from '../runner/lib/card-draft-contract.mjs';
import { AI_CANDIDATE_SCHEMA_VERSION } from '../runner/lib/candidate-response-contract.mjs';
import { safePathSegment } from '../runner/lib/utils.mjs';
import { activeProvider, providerForClient } from './ai-provider-store.mjs';

const publishableStatuses = new Set(['accepted_by_gates', 'accepted_with_warnings']);

function safeError(error) {
  return String(error?.message ?? error ?? '未知错误')
    .replace(/https?:\/\/\S+/g, '<redacted-url>')
    .slice(0, 240);
}

export function autoPublishEnabled(env = process.env) {
  return ['1', 'true', 'yes'].includes(String(env.HERMES_AUTO_PUBLISH ?? '').toLowerCase());
}

function canarySourceIdsFromEnvironment(env) {
  const raw = String(env.HERMES_DRAFT_CANARY_SOURCE_IDS || '').trim();
  if (!raw) return [];
  const ids = raw.split(',').map((id) => id.trim());
  if (ids.some((id) => !/^[\w-]+$/.test(id))) {
    throw new Error('HERMES_DRAFT_CANARY_SOURCE_IDS 必须是逗号分隔的明确来源 ID，不能使用通配符。');
  }
  return [...new Set(ids)];
}

function configuredCandidateProtocol(env, ids) {
  const configured = String(env.HERMES_CANDIDATE_PROTOCOL || CARD_DRAFT_VERSION).trim();
  if (configured !== CARD_DRAFT_VERSION) {
    throw new Error('技术预览仅支持 hermes/card-draft/v1 候选协议。');
  }
  return configured;
}

/** Validate rollout switches before the watcher starts consuming any queue. */
export function candidateWorkerConfig(env = process.env) {
  const canarySourceIds = canarySourceIdsFromEnvironment(env);
  const protocol = configuredCandidateProtocol(env, canarySourceIds);
  const reviewOnly = ['1', 'true', 'yes'].includes(String(env.HERMES_DRAFT_CANARY_REVIEW_ONLY ?? '').toLowerCase());
  if (canarySourceIds.length || reviewOnly) {
    throw new Error('公开技术预览不提供历史审核页；请移除 HERMES_DRAFT_CANARY_* 设置。');
  }
  if (reviewOnly && !canarySourceIds.length) {
    throw new Error('待审核灰度必须同时设置 HERMES_DRAFT_CANARY_SOURCE_IDS，不能覆盖全部新收藏。');
  }
  if (reviewOnly && protocol !== CARD_DRAFT_VERSION) {
    throw new Error('待审核灰度与旧版协议冲突；请取消旧版全局回退或关闭待审核开关。');
  }
  return { protocol, canarySourceIds, reviewOnly };
}

/** New worker requests stay on v3 unless draft-v1 is explicitly enabled. Saved candidate retries are unaffected. */
export function candidateProtocolForSource(sourceId, env = process.env) {
  const ids = canarySourceIdsFromEnvironment(env);
  const configured = configuredCandidateProtocol(env, ids);
  if (configured !== CARD_DRAFT_VERSION) return configured;
  if (!ids.length) return configured;
  return ids.includes(String(sourceId)) ? CARD_DRAFT_VERSION : 'legacy-v3';
}

/** Holding a candidate is opt-in and requires an explicit, finite source list. */
export function reviewOnlyCanaryForSource(sourceId, protocol, env = process.env) {
  if (!['1', 'true', 'yes'].includes(String(env.HERMES_DRAFT_CANARY_REVIEW_ONLY ?? '').toLowerCase())) return false;
  const ids = canarySourceIdsFromEnvironment(env);
  if (!ids.length) throw new Error('待审核灰度必须同时设置 HERMES_DRAFT_CANARY_SOURCE_IDS，不能覆盖全部新收藏。');
  if (ids.includes(String(sourceId)) && protocol !== CARD_DRAFT_VERSION) {
    throw new Error('待审核灰度与旧版协议冲突；请取消旧版全局回退或关闭待审核开关。');
  }
  return protocol === CARD_DRAFT_VERSION && ids.includes(String(sourceId));
}

/**
 * Runs the post-evidence part of the MVP chain. The caller decides whether
 * this mode is enabled. By default, a candidate passing the gates is published.
 * An explicit source-scoped review-only canary instead holds the saved candidate.
 */
export async function processEvidenceToCard({
  projectDirectory,
  evidencePath,
  apiKey = process.env.ZAI_API_KEY,
  model = process.env.HERMES_AUTO_MODEL || 'glm-5.2',
  enabled = autoPublishEnabled(),
  acceptSuggestions = false,
  resumeRunDirectory = null,
  provider = null,
  env = process.env,
  evaluate = evaluateFreshEvidenceCandidate,
  publish = publishFixture,
  onProgress = async () => {}
} = {}) {
  if (!enabled) return { kind: 'disabled', reason: 'HERMES_AUTO_PUBLISH 未开启' };
  if (!projectDirectory || !evidencePath) return { kind: 'failed', stage: 'input', error: '缺少项目目录或 evidence.json 路径' };

  await onProgress({ stage: 'card_prepare', message: '正在读取证据并整理成模型输入。' });

  let selectedProvider = provider;
  if (!selectedProvider) {
    try { selectedProvider = await activeProvider(projectDirectory); }
    catch (error) { return { kind: 'failed', stage: 'provider', error: safeError(error) }; }
  }
  let clientProvider = null;
  try { clientProvider = selectedProvider ? providerForClient(selectedProvider) : null; }
  catch (error) { return { kind: 'failed', stage: 'provider', error: safeError(error) }; }
  const effectiveApiKey = clientProvider?.apiKey || apiKey;
  const effectiveModel = clientProvider?.model || model;

  let evidenceDocument;
  try {
    evidenceDocument = JSON.parse(await readFile(evidencePath, 'utf8'));
  } catch (error) {
    return { kind: 'failed', stage: 'read_evidence', error: safeError(error) };
  }

  let selectedProtocol = null;
  let reviewOnlyCanary = false;
  if (!resumeRunDirectory) {
    try {
      selectedProtocol = candidateProtocolForSource(evidenceDocument.source?.id, env);
      reviewOnlyCanary = reviewOnlyCanaryForSource(evidenceDocument.source?.id, selectedProtocol, env);
    }
    catch (error) { return { kind: 'failed', stage: 'candidate_config', error: safeError(error) }; }
  }

  let outcome;
  if (resumeRunDirectory) {
    try {
      const root = path.resolve(projectDirectory, 'runtime', 'fresh-candidates') + path.sep;
      if (!path.resolve(resumeRunDirectory).startsWith(root)) throw new Error('候选目录不在本机运行目录内');
      const candidateEvidence = JSON.parse(await readFile(path.join(resumeRunDirectory, 'evidence.json'), 'utf8'));
      const savedOutcome = JSON.parse(await readFile(path.join(resumeRunDirectory, 'outcome.json'), 'utf8'));
      const savedCandidate = JSON.parse(await readFile(path.join(resumeRunDirectory, 'candidate.json'), 'utf8'));
      if (JSON.stringify(candidateEvidence) !== JSON.stringify(evidenceDocument)
        || !publishableStatuses.has(savedOutcome.status)) throw new Error('已存候选与当前证据不一致或未通过发布检查');
      outcome = { status: savedOutcome.status, directory: resumeRunDirectory };
      selectedProtocol = savedCandidate.compiler_origin === CARD_DRAFT_VERSION ? CARD_DRAFT_VERSION : 'legacy-v3';
      if (selectedProtocol === CARD_DRAFT_VERSION) {
        // Older draft runs have no durable policy. Hold them rather than treating
        // a missing flag (or a changed worker environment) as approval to publish.
        reviewOnlyCanary = savedOutcome.publication_policy !== 'automatic'
          || reviewOnlyCanaryForSource(evidenceDocument.source?.id, selectedProtocol, env);
      }
    } catch (error) {
      return { kind: 'failed', stage: 'candidate', error: safeError(error) };
    }
  } else {
    try {
      outcome = await evaluate({ root: projectDirectory, evidenceDocument, apiKey: effectiveApiKey, model: effectiveModel, provider: clientProvider,
        candidateProtocol: selectedProtocol, publicationPolicy: reviewOnlyCanary ? 'review_required' : 'automatic', send: true, onProgress });
    } catch (error) {
      return { kind: 'failed', stage: 'candidate', error: safeError(error) };
    }
  }

  if (!publishableStatuses.has(outcome?.status)) {
    return {
      kind: 'not_published',
      stage: 'candidate',
      status: outcome?.status ?? 'unknown',
      message: outcome?.message ?? '候选未通过发布闸门',
      run_directory: outcome?.directory ?? null
    };
  }

  let previousDifferentRun = false;
  if (selectedProtocol === CARD_DRAFT_VERSION) {
    try {
      const publishedPath = path.join(projectDirectory, 'runtime', 'card-library', 'published', `${safePathSegment(evidenceDocument.source?.id)}.json`);
      const previous = JSON.parse(await readFile(publishedPath, 'utf8'));
      if (previous.source_id !== evidenceDocument.source?.id) throw new Error('旧发布物的来源 ID 不一致');
      previousDifferentRun = path.resolve(projectDirectory, previous.candidate_run_directory || '')
        !== path.resolve(outcome.directory);
    } catch (error) {
      if (error?.code !== 'ENOENT') return { kind: 'failed', stage: 'publish', error: safeError(error), run_directory: outcome.directory };
    }
  }

  if (reviewOnlyCanary || previousDifferentRun) {
    const message = previousDifferentRun
      ? '该来源已有正式卡片；新候选等待人工核对，尚未替换旧版。'
      : '候选已生成并通过结构检查，等待内容审核；尚未发布。';
    await onProgress({ stage: 'candidate_review', message });
    return {
      kind: 'review_pending',
      status: outcome.status,
      run_directory: outcome.directory,
      message
    };
  }

  try {
    await onProgress({ stage: 'card_publish', message: '卡片已通过检查，正在写入卡片库。' });
    const publication = publish({
      root: projectDirectory,
      runDirectory: outcome.directory,
      databasePath: path.join(projectDirectory, 'runtime', 'card-engine.sqlite'),
      acceptSuggestions
    });
    return {
      kind: 'published',
      status: outcome.status,
      run_directory: outcome.directory,
      publication
    };
  } catch (error) {
    return {
      kind: 'failed',
      stage: 'publish',
      status: outcome.status,
      run_directory: outcome.directory,
      error: safeError(error)
    };
  }
}
