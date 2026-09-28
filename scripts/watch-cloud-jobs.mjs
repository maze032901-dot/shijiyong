import { cloudRequest, processNextCloudJob, readMacWorkerConfig } from '../app/mac-worker.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { processCapturedEvidence } from '../app/gallery-ocr-automation.mjs';
import { autoPublishEnabled, candidateWorkerConfig, processEvidenceToCard } from '../app/fresh-card-automation.mjs';
import { CARD_DRAFT_VERSION } from '../runner/lib/card-draft-contract.mjs';
import { PROCESSING_STAGES, writeCardProcessingStatus } from '../app/card-processing-status.mjs';
import { drainAvailableJobs } from '../app/queue-drain.mjs';
import { enqueueLocalRetry, listQueuedLocalRetries, recoverLocalRetries, updateLocalRetry } from '../app/local-retry-queue.mjs';
import { validateRetryEvidence } from '../app/retry-stage.mjs';
import { planCapturedFollowUp } from '../app/captured-followup-plan.mjs';
import { syncAllMobilePublications, syncMobileProgress, syncMobilePublication } from '../app/mobile-publisher.mjs';
import { drainMobileCommands, mobileWorkerConfig, registerMobileWorker } from '../app/mobile-command-worker.mjs';
import { createManualMediaFetch, manualMediaResult } from '../app/manual-media.mjs';

const reconnectDelayMs = 2_000;
const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const autoPublish = autoPublishEnabled();
let captureProcessing = false;
let evidenceProcessing = false;
let cardProcessing = false;
let mobileCloudConfig = null;
let mobileCommandsProcessing = false;
let mobileRegistrationReady = false;
let mobileNextAttemptAt = 0;
let mobileFailureDelayMs = 3_000;
let mobileSyncDirty = true;
let mobileSyncInFlight = false;
let mobileSyncNextAt = 0;
let mobileSyncFailureVersion = 0;

async function reconcileMobilePublications() {
  if (!mobileCloudConfig || !mobileSyncDirty || mobileSyncInFlight || Date.now() < mobileSyncNextAt) return;
  mobileSyncInFlight = true;
  const startingFailureVersion = mobileSyncFailureVersion;
  try {
    const result = await syncAllMobilePublications({ projectDirectory, config: mobileCloudConfig });
    const incomplete = result.results.filter((item) => item.kind !== 'synced' || item.missingImages?.length);
    if (!incomplete.length && startingFailureVersion === mobileSyncFailureVersion) {
      mobileSyncDirty = false;
      console.log(`云端卡库核对完成：${result.results.length} 条已发布来源。`);
    } else {
      mobileSyncNextAt = Date.now() + 60_000;
      console.error(`云端卡库仍有 ${incomplete.length} 条来源待补同步；一分钟后再试。`);
    }
  } catch (error) {
    mobileSyncNextAt = Date.now() + 60_000;
    console.error(`云端卡库核对暂不可用：${error.message}；一分钟后再试。`);
  } finally { mobileSyncInFlight = false; }
}

async function readCloudJobs(config) {
  const response = await fetch(`${config.baseUrl}/api/intake/jobs`, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`无法检查云端收藏队列（HTTP ${response.status}）`);
  const payload = await response.json();
  if (!Array.isArray(payload?.jobs)) throw new Error('云端收藏队列返回格式不正确');
  return payload.jobs;
}

async function recordCardStatus(eventId, update) {
  if (!eventId) return;
  try {
    const stageInfo = PROCESSING_STAGES[update.stage];
    await writeCardProcessingStatus(projectDirectory, eventId, {
      ...update,
      progressStep: update.progressStep ?? stageInfo?.progressStep ?? null,
      progressTotal: update.progressTotal ?? 4,
      phase: update.phase ?? (stageInfo?.progressStep === 1 ? '抓取' : stageInfo?.progressStep === 2 ? '识别' : stageInfo?.progressStep === 3 ? '成卡' : null)
    });
    void syncMobileProgress({ eventId, update, config: mobileCloudConfig }).catch((error) => {
      console.error(`手机解析进度同步失败：${error.message}`);
    });
  } catch (error) {
    console.error(`卡片状态记录失败：${error.message}`);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function report(outcome) {
  console.log(`已回传：${outcome.complete.event_id} → ${outcome.complete.status}`);
  const events = outcome.result.diagnostic?.f2_events ?? [];
  const httpStatus = events.find((event) => Number.isInteger(event.http_status))?.http_status
    ?? outcome.result.diagnostic?.platform_status;
  if (outcome.complete.status === 'retryable' || outcome.complete.status === 'failed') {
    const awemeId = outcome.result.aweme_id ?? outcome.job?.awemeId;
    console.log(`作品详情获取未完成${awemeId ? `（作品 ID ${awemeId} 已识别）` : ''}：${httpStatus ? `F2 请求返回 HTTP ${httpStatus}` : outcome.result.error ?? '未知错误'}；素材 ${outcome.result.media_manifest?.length ?? 0} 条，未进入 ASR/OCR。`);
    return;
  }
  console.log(`作品类型：${outcome.result.media_kind ?? '未知'}；素材条目：${outcome.result.media_manifest?.length ?? 0}`);
}

async function maybePublishCard(followUp, { candidateRunDirectory = null } = {}) {
  if (followUp.kind !== 'processed') return { kind: 'not_applicable' };
  if (!autoPublish) {
    await recordCardStatus(followUp.eventId, { status: 'processing', stage: 'evidence_ready' });
    return { kind: 'disabled' };
  }
  if (followUp.result?.validation !== 'passed') {
    console.error('证据校验未通过，跳过 AI 卡片发布；证据包仍保留。');
    await recordCardStatus(followUp.eventId, { status: 'failed', stage: 'evidence', message: '内容证据校验未通过，需要检查后重试。' });
    return { kind: 'failed', stage: 'evidence' };
  }
  await recordCardStatus(followUp.eventId, { status: 'processing', stage: 'card_prepare', message: '正在读取证据并整理成模型输入。' });
  const result = await processEvidenceToCard({
    projectDirectory,
    evidencePath: path.join(followUp.result.output_directory, 'evidence.json'),
    resumeRunDirectory: candidateRunDirectory,
    enabled: true,
    onProgress: async ({ stage, message }) => {
      await recordCardStatus(followUp.eventId, { status: 'processing', stage, message });
    }
  });
  if (result.kind === 'published') {
    console.log(`AI 候选已自动发布：${result.publication.publication_path}；卡片 ${result.publication.fixture.cards.length} 张。`);
    await recordCardStatus(followUp.eventId, { status: 'completed', stage: 'published', message: '卡片已经生成并写入卡片库。' });
    try {
      const sourceId = String(result.publication.fixture.source?.id || '');
      const synced = await syncMobilePublication({ projectDirectory, sourceId, config: mobileCloudConfig });
      if (synced.kind === 'synced') console.log(`手机卡库已同步：${sourceId}，${synced.cards} 张卡片、${synced.images} 张图片。`);
      if (synced.missingImages?.length) {
        mobileSyncDirty = true;
        mobileSyncFailureVersion += 1;
        mobileSyncNextAt = Date.now() + 60_000;
        console.error(`来源 ${sourceId} 有 ${synced.missingImages.length} 张图片未同步；稍后再试。`);
      }
    } catch (error) {
      mobileSyncDirty = true;
      mobileSyncFailureVersion += 1;
      mobileSyncNextAt = Date.now() + 60_000;
      console.error(`卡片已在 Mac 发布，但手机卡库同步未完成：${error.message}`);
    }
  } else if (result.kind === 'review_pending') {
    console.log(`灰度候选等待内容审核：${result.run_directory}；没有发布，也不会自动结案。`);
    const reviewUrl = null;
    const reviewMessage = '候选待审核；公开技术预览不提供历史审核页。';
    await recordCardStatus(followUp.eventId, { status: 'review_pending', stage: 'candidate_review', message: reviewMessage,
      runDirectory: result.run_directory, reviewUrl });
  } else if (result.kind === 'not_published') {
    console.error(`AI 候选未发布（${result.status}）：${result.message}`);
    await recordCardStatus(followUp.eventId, { status: 'failed', stage: 'card_validate', message: result.message || '卡片没有通过发布检查。', runDirectory: result.run_directory });
  } else if (result.kind === 'failed') {
    console.error(`AI 卡片链路未完成（${result.stage}）：${result.error}`);
    const stage = result.stage === 'publish' ? 'card_publish' : ['provider', 'read_evidence', 'input'].includes(result.stage) ? 'card_prepare' : result.stage || 'card';
    await recordCardStatus(followUp.eventId, { status: 'failed', stage, message: result.error || '卡片生成没有完成。', runDirectory: result.run_directory });
  }
  return result;
}

async function enqueueCapturedOutcome(outcome) {
  if (outcome.kind !== 'processed' || outcome.complete?.status !== 'captured') return;
  const eventId = outcome.job?.eventId;
  if (!eventId) return;
  const mediaKind = outcome.result?.media_kind;
  const followUpPlan = ['video', 'gallery'].includes(mediaKind)
    ? await planCapturedFollowUp({ projectDirectory, job: { ...outcome.job, result: outcome.result } })
    : null;
  if (followUpPlan?.kind === 'completed') {
    await recordCardStatus(eventId, { status: 'completed', stage: 'published', message: '已保存的卡片可用，无需重新处理视频。' });
    return;
  }
  if (followUpPlan?.kind === 'card') {
    console.log(`已有合格证据，跳过重复视频/图片处理：${eventId}`);
    await enqueueLocalRetry(projectDirectory, eventId, {
      kind: 'card', evidenceDirectory: followUpPlan.evidenceDirectory,
      candidateRunDirectory: followUpPlan.candidateRunDirectory
    });
    await recordCardStatus(eventId, { status: 'processing', stage: 'card_queue', message: '已有证据，等待成卡队列处理。' });
    return;
  }
  if (!['video', 'gallery'].includes(mediaKind)) {
    const usableAssets = outcome.result?.media_manifest?.length ?? 0;
    await recordCardStatus(eventId, {
      status: 'failed',
      stage: usableAssets ? 'evidence_validation' : 'media_unavailable',
      message: usableAssets
        ? '作品素材类型暂不支持自动识别，需要检查后处理。'
        : '作品链接已解析，但作品详情没有提供可用图片或视频素材；ASR/OCR 未启动。'
    });
    return;
  }
  const outputDirectory = followUpPlan?.outputDirectory ?? null;
  await enqueueLocalRetry(projectDirectory, eventId, {
    kind: 'evidence', outputDirectory,
    resumeFromDirectory: followUpPlan?.resumeFromDirectory ?? null,
    retryStage: followUpPlan?.retryStage ?? null
  });
  await recordCardStatus(eventId, { status: 'processing', stage: 'evidence_queue', message: '作品素材已取得，等待本机识别队列处理。' });
}

async function processEvidenceRequest(config, request) {
  let lastStage = request.retryStage || 'evidence_validation';
  await updateLocalRetry(projectDirectory, request.eventId, { status: 'processing' });
  try {
    const job = (await readCloudJobs(config)).find((item) => item.eventId === request.eventId);
    if (!job || job.status === 'dismissed') throw new Error('云端收藏不存在或已删除');
    if (!request.manualMedia && (!['captured', 'partial'].includes(job.status) || !job.result?.media_kind)) {
      throw new Error('云端抓取结果已不可用，不能从本机识别阶段继续');
    }
    const retryDirectory = request.outputDirectory || path.join(projectDirectory, 'runtime', 'mac-intake-retries', request.eventId, new Date().toISOString().replace(/[:.]/g, '-'));
    const result = request.manualMedia ? manualMediaResult(job, request) : job.result;
    const outcome = { kind: 'processed', job, result, complete: { status: 'captured', event_id: request.eventId } };
    const followUp = await processCapturedEvidence(outcome, {
      projectDirectory,
      outputDirectory: retryDirectory,
      resumeFromDirectory: request.resumeFromDirectory,
      retryStage: request.retryStage,
      fetchImpl: request.manualMedia ? createManualMediaFetch(projectDirectory, request.eventId, request.manualMedia) : fetch,
      onStage: async ({ stage, message }) => {
        lastStage = stage;
        await recordCardStatus(request.eventId, { status: 'processing', stage, message });
      }
    });
    if (followUp.kind !== 'processed') throw new Error(followUp.error || '本机证据处理未完成');
    if (followUp.mediaKind === 'video') {
      console.log(`视频证据已生成：ASR ${followUp.result.asr_segments} 段；画面 ${followUp.result.video_ocr_frames} 段文字。`);
    } else {
      console.log(`图文 OCR 已生成：${followUp.result.images_downloaded} 张图片。`);
    }
    await updateLocalRetry(projectDirectory, request.eventId, {
      kind: 'card', status: 'queued', evidenceDirectory: followUp.result.output_directory,
      outputDirectory: null, resumeFromDirectory: null, retryStage: null, error: null
    });
    await recordCardStatus(request.eventId, { status: 'processing', stage: 'card_queue', message: '证据已生成，等待本机成卡队列处理。' });
  } catch (error) {
    const message = String(error?.message || error).replace(/https?:\/\/\S+/g, '<redacted-url>').slice(0, 240);
    console.error(`本机识别 ${request.eventId} 未完成：${message}`);
    await recordCardStatus(request.eventId, { status: 'failed', stage: lastStage, message });
    await updateLocalRetry(projectDirectory, request.eventId, { status: 'failed', error: message });
  }
}

async function drainLocalEvidenceRetries(config) {
  if (evidenceProcessing) return;
  evidenceProcessing = true;
  try {
    while (true) {
      const request = (await listQueuedLocalRetries(projectDirectory)).find((item) => item.kind === 'evidence');
      if (!request) return;
      await processEvidenceRequest(config, request);
    }
  } finally {
    evidenceProcessing = false;
  }
}

async function processCardRequest(config, request) {
  await updateLocalRetry(projectDirectory, request.eventId, { status: 'processing' });
  try {
    if (!request.evidenceDirectory || !await validateRetryEvidence(request.evidenceDirectory)) {
      throw new Error('已保存的证据不完整，不能直接继续成卡');
    }
    const followUp = { kind: 'processed', eventId: request.eventId, result: { validation: 'passed', output_directory: request.evidenceDirectory } };
    const result = await maybePublishCard(followUp, { candidateRunDirectory: request.candidateRunDirectory });
    if (result.kind === 'published') {
      const completed = await cloudRequest(config, '/api/intake/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_id: request.eventId })
      });
      if (!completed.ok) throw new Error(`卡片已发布，但云端任务未能结案（HTTP ${completed.status}）`);
      await updateLocalRetry(projectDirectory, request.eventId, { status: 'completed' });
    } else if (result.kind === 'disabled') {
      await updateLocalRetry(projectDirectory, request.eventId, { status: 'evidence_ready' });
    } else if (result.kind === 'review_pending') {
      await updateLocalRetry(projectDirectory, request.eventId, {
        status: 'review_pending', candidateRunDirectory: result.run_directory, error: null
      });
    } else {
      await updateLocalRetry(projectDirectory, request.eventId, { status: 'failed', error: result.error || result.message || '卡片未能发布' });
    }
  } catch (error) {
    const message = String(error?.message || error).replace(/https?:\/\/\S+/g, '<redacted-url>').slice(0, 240);
    console.error(`本机成卡 ${request.eventId} 未完成：${message}`);
    await recordCardStatus(request.eventId, { status: 'failed', stage: 'card', message });
    await updateLocalRetry(projectDirectory, request.eventId, { status: 'failed', error: message });
  }
}

async function drainLocalCardRetries(config) {
  if (cardProcessing) return;
  cardProcessing = true;
  try {
    while (true) {
      const request = (await listQueuedLocalRetries(projectDirectory)).find((item) => item.kind === 'card');
      if (!request) return;
      await processCardRequest(config, request);
    }
  } finally {
    cardProcessing = false;
  }
}

async function drainQueue(config) {
  if (captureProcessing) return;
  captureProcessing = true;
  try {
    await drainAvailableJobs({
      nextJob: () => processNextCloudJob(config, {
        onStage: ({ eventId, stage, message, substage }) => recordCardStatus(eventId, { status: 'processing', stage, substage, message })
      }),
      afterJob: async (outcome) => {
        report(outcome);
        if (outcome.complete?.status !== 'captured') {
          const result = outcome.result || {};
          await recordCardStatus(outcome.job?.eventId, {
            status: outcome.complete?.status === 'retryable' ? 'retryable' : 'failed',
            stage: 'capture_parse',
            message: result.error || '抓取没有取得可用作品素材，已保留在队列中等待重试。'
          });
          return;
        }
        await enqueueCapturedOutcome(outcome);
        void drainLocalEvidenceRetries(config);
        void drainLocalCardRetries(config);
      },
      onJobError: async (outcome, error) => {
        console.error(`收藏 ${outcome.job?.awemeId || outcome.job?.eventId} 后续处理失败：${error.message}；继续处理下一条。`);
        await recordCardStatus(outcome.job?.eventId, {
          status: 'failed',
          stage: 'capture_detail',
          message: `后续处理失败：${error.message}`
        });
      }
    });
  } catch (error) {
    console.error(`自动处理失败：${error.message}`);
  } finally {
    captureProcessing = false;
  }
}

async function drainRemoteMobileCommands(config) {
  if (mobileCommandsProcessing || !mobileCloudConfig || Date.now() < mobileNextAttemptAt) return;
  mobileCommandsProcessing = true;
  try {
    if (!mobileRegistrationReady) {
      await registerMobileWorker({ projectDirectory, config: mobileCloudConfig });
      mobileRegistrationReady = true;
    }
    await drainMobileCommands({ projectDirectory, cloudConfig: config, onResult: (item) => {
      console.log(`手机命令 ${item.action}：${item.ok ? '完成' : '未完成'} · ${item.result}`);
    } });
    mobileFailureDelayMs = 3_000;
    mobileNextAttemptAt = 0;
  } catch (error) {
    mobileRegistrationReady = false;
    mobileNextAttemptAt = Date.now() + mobileFailureDelayMs;
    mobileFailureDelayMs = Math.min(60_000, mobileFailureDelayMs * 2);
    throw error;
  } finally { mobileCommandsProcessing = false; }
}

async function consumeSse(response, onEvent) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('云端 SSE 没有返回事件流');
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let data = [];
  const dispatch = () => {
    if (data.length > 0) onEvent(eventName, data.join('\n'));
    eventName = 'message';
    data = [];
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lineEnd;
    while ((lineEnd = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
      buffer = buffer.slice(lineEnd + 1);
      if (line === '') dispatch();
      else if (line.startsWith('event:')) eventName = line.slice(6).trim() || 'message';
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
  }
}

try {
  // Reject an unsafe or contradictory rollout config before recovering local
  // work or claiming a cloud job. Do not print keys or provider settings.
  const candidateMode = autoPublish ? candidateWorkerConfig(process.env) : null;
  const config = await readMacWorkerConfig();
  mobileCloudConfig = mobileWorkerConfig(config);
  if (mobileCloudConfig) {
    try { await registerMobileWorker({ projectDirectory, config: mobileCloudConfig }); mobileRegistrationReady = true; }
    catch (error) { console.error(`手机控制通道尚未注册：${error.message}`); }
  }
  await recoverLocalRetries(projectDirectory);
  const drainPipeline = () => {
    void reconcileMobilePublications();
    void drainLocalEvidenceRetries(config).catch((error) => console.error(`本机识别队列检查失败：${error.message}`));
    void drainLocalCardRetries(config).catch((error) => console.error(`本机成卡队列检查失败：${error.message}`));
    void drainQueue(config).catch((error) => console.error(`抓取队列检查失败：${error.message}`));
    void drainRemoteMobileCommands(config).catch((error) => console.error(`手机命令检查失败：${error.message}`));
  };
  setInterval(drainPipeline, 3_000).unref();
  console.log('Mac 自动处理器已启动；等待手机收藏。按 Ctrl+C 停止。');
  console.log(autoPublish
    ? '自动卡片模式已开启：证据校验通过后会调用模型；发布或待审核以以下配置为准。'
    : '当前仅自动生成证据；如需自动调用模型并发布 JSON，请显式设置 HERMES_AUTO_PUBLISH=1。');
  if (candidateMode?.protocol === CARD_DRAFT_VERSION && candidateMode.canarySourceIds.length) {
    console.log(`新版草稿灰度来源：${candidateMode.canarySourceIds.join(', ')}；${candidateMode.reviewOnly ? '候选通过后等待人工审核' : '候选通过后自动发布'}。`);
    console.log('灰度名单只选择成卡规则，不限制队列领取；名单外来源仍按旧版规则自动处理。');
  } else if (candidateMode?.protocol === CARD_DRAFT_VERSION) {
    console.log('新版草稿已对全部新来源启用；候选通过后会自动发布。');
  } else if (candidateMode) {
    console.log('成卡规则：legacy-v3。');
    if (candidateMode.canarySourceIds.length) console.log('已配置的灰度名单当前被全局旧版协议覆盖，不会生效。');
  }
  while (true) {
    try {
      // Capture, evidence and card queues are deliberately independent. A
      // long ASR/OCR/model run must not prevent the next capture from starting.
      await Promise.all([
        drainLocalEvidenceRetries(config),
        drainLocalCardRetries(config),
        drainQueue(config),
        drainRemoteMobileCommands(config)
      ]);
      const response = await fetch(`${config.baseUrl}/api/mac/events`, {
        headers: { Authorization: `Bearer ${config.token}`, Accept: 'text/event-stream' }
      });
      if (!response.ok) throw new Error(`无法建立 SSE 连接（HTTP ${response.status}）`);
      mobileSyncDirty = true;
      mobileSyncNextAt = 0;
      void reconcileMobilePublications();
      console.log('已连接云端通知。');
      await consumeSse(response, (eventName) => {
        if (eventName === 'job_available') drainPipeline();
      });
      console.log('云端通知连接已断开，正在重连…');
    } catch (error) {
      console.error(`云端通知不可用：${error.message}`);
    }
    await sleep(reconnectDelayMs);
  }
} catch (error) {
  console.error(`Mac 自动处理器未启动：${error.message}`);
  process.exitCode = 1;
}
