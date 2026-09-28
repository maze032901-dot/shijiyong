import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readCloudStatusConfig } from './cloud-status.mjs';
import { captureDouyinBrowser, shouldTryBrowserCapture } from './douyin-browser-capture.mjs';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(appDirectory, '..');
const pythonPath = process.env.HERMES_F2_PYTHON || path.join(projectDirectory, 'runtime', 'f2-capture-spike', '.venv', 'bin', 'python');
const workerPath = path.join(projectDirectory, 'app', 'capture_douyin_snapshot.py');

function safeErrorMessage(error) {
  return String(error?.message ?? error ?? '未知错误').replace(/https?:\/\/\S+/g, '<redacted-url>').slice(0, 240);
}

export async function readMacWorkerConfig() {
  return readCloudStatusConfig(projectDirectory);
}

export async function cloudRequest(config, pathname, options = {}) {
  return fetch(`${config.baseUrl}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/json',
      ...(options.headers ?? {})
    },
    signal: AbortSignal.timeout(30_000)
  });
}

function runCapture(sourceUrl, eventId) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [workerPath, '--url', sourceUrl, '--output-root', path.join(projectDirectory, 'runtime', 'mac-intake', eventId), '--no-persist'], {
      cwd: projectDirectory,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      const line = stdout.trim().split('\n').filter(Boolean).at(-1);
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`本机 F2 没有返回有效 JSON${stderr ? `：${stderr.slice(-240)}` : ''}`));
      }
    });
  });
}

export async function captureWithFallback({
  sourceUrl,
  eventId,
  onStage = async () => {},
  f2Capture = runCapture,
  browserCapture = captureDouyinBrowser
}) {
  let result;
  await onStage({
    eventId,
    stage: 'capture_request',
    message: '正在向抖音请求作品详情。'
  });
  await onStage({
    eventId,
    stage: 'capture_waiting',
    message: '抓取请求已发出，正在等待作品详情返回。'
  });
  try {
    result = await f2Capture(sourceUrl, eventId);
  } catch (error) {
    result = { status: 'failed', retryable: true, error_type: 'MacWorkerError', error: safeErrorMessage(error) };
  }
  await onStage({
    eventId,
    stage: 'capture_response',
    message: '已收到抓取响应，正在检查返回内容。'
  });
  await onStage({
    eventId,
    stage: 'capture_parse',
    message: result?.status === 'captured' ? '正在整理作品信息和可用素材。' : '正在整理失败信息，判断是否可以重试。'
  });
  if (!shouldTryBrowserCapture(result)) {
    if (result?.status === 'captured') {
      await onStage({ eventId, stage: 'capture_ready', message: '作品信息和可用素材已取得，准备进入识别。' });
    }
    return result;
  }

  const f2Result = result;
  await onStage({
    eventId,
    stage: 'capture_browser_request',
    message: 'F2 未取得作品详情，正在请求公开网页备用入口。'
  });
  await onStage({
    eventId,
    stage: 'capture_browser_waiting',
    message: '备用网页请求已发出，正在等待响应。'
  });
  try {
    result = await browserCapture({ sourceUrl, awemeId: f2Result.aweme_id });
    await onStage({
      eventId,
      stage: 'capture_browser_response',
      message: '已收到公开网页响应，正在提取视频信息。'
    });
    result.diagnostic = {
      ...f2Result.diagnostic,
      browser_fallback: { status: 'captured' }
    };
    await onStage({ eventId, stage: 'capture_ready', message: '公开网页已取得作品素材，准备进入识别。' });
    return result;
  } catch (error) {
    await onStage({
      eventId,
      stage: 'capture_browser_response',
      message: `公开网页备用抓取未成功：${safeErrorMessage(error)}`
    });
    return {
      ...f2Result,
      retryable: true,
      diagnostic: {
        ...f2Result.diagnostic,
        browser_fallback: { status: 'failed', reason: safeErrorMessage(error) }
      }
    };
  }
}

export async function processNextCloudJob(config, { onStage = async () => {}, excludeEventIds = [] } = {}) {
  const nextResponse = await cloudRequest(config, '/api/mac/next', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exclude_event_ids: excludeEventIds })
  });
  if (nextResponse.status === 204) return { kind: 'idle' };
  if (!nextResponse.ok) throw new Error(`无法获取待处理任务（HTTP ${nextResponse.status}）`);
  const payload = await nextResponse.json();
  const job = payload?.job;
  if (!job?.eventId || !job?.sourceUrl) throw new Error('云端返回的任务不完整');

  await onStage({
    eventId: job.eventId,
    job,
    stage: 'capture_claimed',
    message: '链接已进入本机处理，抓取器已接手。'
  });

  const result = await captureWithFallback({
    sourceUrl: job.sourceUrl,
    eventId: job.eventId,
    onStage: (stage) => onStage({ ...stage, job })
  });

  await onStage({
    eventId: job.eventId,
    job,
    stage: 'capture_result_upload',
    message: '抓取完成，正在把作品信息和素材清单回传云端。'
  });
  const completeResponse = await cloudRequest(config, '/api/mac/results', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event_id: job.eventId, result })
  });
  if (!completeResponse.ok) throw new Error(`无法回传本机结果（HTTP ${completeResponse.status}）`);
  const complete = await completeResponse.json();
  await onStage({
    eventId: job.eventId,
    job,
    stage: 'capture_result_uploaded',
    message: complete.status === 'captured' ? '云端已收到抓取结果，准备进入本机识别。' : '云端已收到抓取结果，正在保留失败信息。'
  });
  return { kind: 'processed', job, result, complete };
}
