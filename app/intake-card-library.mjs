import { PROCESSING_STAGES } from './card-processing-status.mjs';

function cleanTitle(description, fallback = '新收藏') {
  const firstSentence = String(description ?? '').split(/[。！#]/)[0].trim();
  return firstSentence || fallback;
}

function savedAt(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (Number.isFinite(Number(value))) {
    const date = new Date(Number(value));
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return null;
}

function failureDetail(job) {
  const result = job.result && typeof job.result === 'object' ? job.result : {};
  const diagnostic = result.diagnostic ?? job.diagnostic ?? {};
  const events = Array.isArray(diagnostic.f2_events) ? diagnostic.f2_events : [];
  const status403 = diagnostic.platform_status === 403 || events.some((event) => event?.http_status === 403);
  if (status403 || /no aweme_detail/i.test(String(job.error ?? result.error ?? ''))) {
    const awemeId = result.aweme_id ?? job.awemeId;
    const idText = awemeId ? `（作品 ID ${awemeId} 已识别）` : '';
    const statusText = status403 ? 'F2 请求抖音作品详情时收到 HTTP 403，访问被拒绝' : 'F2 没有取得抖音作品详情';
    const browserFailure = diagnostic.browser_fallback?.status === 'failed'
      ? `；公开网页备用抓取也未取得视频（${diagnostic.browser_fallback.reason || '原因未知'}）`
      : '';
    return `链接已识别${idText}，但${statusText}${browserFailure}；没有拿到素材，因此本次未进入下载、ASR 或 OCR。`;
  }
  return '这次没有取得可处理的作品素材，任务已保留，等待重试。';
}

function stateFor(job, localStatus) {
  const localStage = PROCESSING_STAGES[localStatus?.stage];
  if (localStatus?.status === 'review_pending') {
    const reviewUrl = /^\/card-draft-trial-\d{12,22}\.html$/.test(String(localStatus.review_url || ''))
      ? localStatus.review_url : null;
    return {
      status: 'review_pending',
      label: '已生成，待确认',
      detail: localStatus.message || '新版卡片已生成，正在等待内容检查。',
      reviewUrl,
      history: localStatus.history || []
    };
  }
  if (localStatus?.status === 'failed') {
    return {
      status: 'failed', label: localStage ? `${localStage.label.replace(/^正在/, '')}未完成` : '解析失败',
      detail: localStatus.message || localStage?.fallback || '处理没有完成，可以检查后台记录后重试。',
      progressStep: localStatus.progress_step ?? localStage?.progressStep ?? 2,
      progressTotal: localStatus.progress_total ?? 4,
      phase: localStatus.phase ?? null,
      substage: localStatus.substage ?? null,
      history: localStatus.history || [], progressError: true
    };
  }
  if (localStatus?.status === 'retryable') {
    return {
      status: 'retryable', label: localStage?.label || '等待重试',
      detail: localStatus.message || localStage?.fallback || '本次抓取暂未完成，可以稍后重试。',
      progressStep: localStatus.progress_step ?? localStage?.progressStep ?? 1,
      progressTotal: localStatus.progress_total ?? 4,
      phase: localStatus.phase ?? null,
      substage: localStatus.substage ?? null,
      history: localStatus.history || [], progressError: true
    };
  }
  if (localStatus?.status === 'processing' && localStage) {
    return {
      status: 'processing', label: localStage.label, detail: localStatus.message || localStage.fallback,
      progressStep: localStatus.progress_step ?? localStage.progressStep, progressTotal: localStatus.progress_total ?? 4,
      phase: localStatus.phase ?? null, substage: localStatus.substage ?? null, history: localStatus.history || []
    };
  }
  if (job.status === 'retryable') {
    return {
      status: 'retryable',
      label: '抓取作品受阻',
      detail: failureDetail(job),
      progressStep: 1,
      progressError: true
    };
  }
  if (job.status === 'failed') {
    return {
      status: 'failed',
      label: '解析失败',
      detail: job.error || '处理没有完成，可以检查后台记录后重试。',
      progressStep: 1,
      progressError: true
    };
  }
  if (job.status === 'captured' || job.status === 'partial') {
    return { status: 'processing', label: '准备识别素材', detail: '作品信息已取得，接下来会下载素材并开始 ASR/OCR。', progressStep: 2 };
  }
  if (job.status === 'processing') {
    return { status: 'processing', label: '正在读取作品信息', detail: '后台正在请求作品详情，随后会下载素材并开始识别。', progressStep: 1 };
  }
  return { status: 'processing', label: '排队等待处理', detail: '链接已经收到，后台取到任务后会开始读取作品信息。', progressStep: 0 };
}

export function mergeIntakeJobs(localJobs = [], cloudJobs = []) {
  const jobs = new Map();
  for (const job of localJobs) {
    if (job?.eventId) jobs.set(job.eventId, job);
  }
  // Cloud is authoritative for the shared intake queue. It overwrites a local
  // copy of the same event while local-only development events remain visible.
  for (const job of cloudJobs) {
    if (job?.eventId) jobs.set(job.eventId, job);
  }
  return [...jobs.values()].sort((a, b) => Number(b.savedAt ?? 0) - Number(a.savedAt ?? 0));
}

export function intakeCardFromJob(job, { localStatus = null } = {}) {
  const result = job.result && typeof job.result === 'object' ? job.result : {};
  const jobUpdatedAt = Date.parse(job.updatedAt ?? '');
  const localUpdatedAt = Date.parse(localStatus?.updated_at ?? '');
  const currentLocalStatus = Number.isFinite(jobUpdatedAt) && Number.isFinite(localUpdatedAt) && localUpdatedAt < jobUpdatedAt
    ? null
    : localStatus;
  const state = stateFor(job, currentLocalStatus);
  const sourceUrl = result.canonical_url || job.sourceUrl || null;
  const awemeId = result.aweme_id ?? job.awemeId;
  const sourceTitle = cleanTitle(result.description, awemeId ? `抖音作品 ${awemeId}` : '新收藏');
  return {
    id: `intake_${job.eventId}`,
    type: 'generic_unknown',
    subtype: null,
    title: sourceTitle,
    topics: [],
    status: state.status,
    content: [],
    paths: [],
    resources: [],
    sources: [{
      id: `source_intake_${job.eventId}`,
      title: sourceTitle,
      author: result.author ?? null,
      kind: result.media_kind === 'gallery' ? 'note' : result.media_kind === 'video' ? 'video' : 'other',
      originKind: 'douyin',
      originalUrl: sourceUrl,
      savedCopyUrl: null,
      savedAt: savedAt(job.savedAt ?? result.captured_at ?? job.createdAt)
    }],
    missing: [],
    media: null,
    origin: 'intake_placeholder',
    featuredContent: [],
    processingState: state,
    eventId: job.eventId
  };
}
