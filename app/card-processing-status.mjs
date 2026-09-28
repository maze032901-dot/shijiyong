import fs from 'node:fs/promises';
import path from 'node:path';

const directoryName = 'card-processing-status';

// A stage is the user-facing state, while `substage` is the concrete
// operation currently running. Keeping both lets the UI explain what is
// happening without exposing implementation details such as stack traces.
export const PROCESSING_STAGES = {
  capture: { label: '正在读取作品信息', progressStep: 1, fallback: '已收到链接，正在请求作品详情。' },
  capture_detail: { label: '正在读取作品信息', progressStep: 1, fallback: '已识别作品链接，正在请求作品详情。' },
  capture_browser: { label: '正在读取公开网页', progressStep: 1, fallback: 'F2 未取得作品详情，正在通过公开网页读取视频。' },
  capture_queue: { label: '等待抓取队列', progressStep: 1, fallback: '链接已收到，等待抓取队列开始处理。' },
  capture_claimed: { label: '已接手抓取', progressStep: 1, fallback: '本机处理器已接手这条收藏。' },
  capture_request: { label: '正在发送抓取请求', progressStep: 1, fallback: '正在向抖音请求作品详情。' },
  capture_waiting: { label: '等待作品详情', progressStep: 1, fallback: '请求已发出，正在等待作品详情返回。' },
  capture_response: { label: '已收到作品响应', progressStep: 1, fallback: '已收到作品详情响应，正在检查返回内容。' },
  capture_parse: { label: '正在整理抓取结果', progressStep: 1, fallback: '正在解析作品信息和可用素材。' },
  capture_ready: { label: '抓取完成', progressStep: 1, fallback: '作品信息和素材已取得，准备进入识别。' },
  capture_result_upload: { label: '正在回传抓取结果', progressStep: 1, fallback: '正在把抓取结果回传到云端。' },
  capture_result_uploaded: { label: '抓取结果已回传', progressStep: 1, fallback: '云端已收到抓取结果，准备进入本机识别。' },
  capture_browser_request: { label: '正在请求公开网页', progressStep: 1, fallback: 'F2 未取得详情，正在请求公开网页备用入口。' },
  capture_browser_waiting: { label: '等待公开网页响应', progressStep: 1, fallback: '备用网页请求已发出，正在等待响应。' },
  capture_browser_response: { label: '已收到网页响应', progressStep: 1, fallback: '已收到公开网页响应，正在提取视频信息。' },
  media_unavailable: { label: '素材不可用', progressStep: 1, fallback: '作品详情已读取，但没有可下载的图片或视频素材。' },
  evidence_queue: { label: '等待识别队列', progressStep: 2, fallback: '作品素材已取得，等待本机识别队列处理。' },
  video_download_request: { label: '正在请求视频素材', progressStep: 2, fallback: '正在请求视频和音轨素材。' },
  video_download_waiting: { label: '等待视频素材', progressStep: 2, fallback: '视频素材请求已发出，正在等待下载响应。' },
  video_download: { label: '正在下载视频', progressStep: 2, fallback: '作品信息已取得，正在保存视频素材。' },
  video_download_received: { label: '视频素材已收到', progressStep: 2, fallback: '视频素材已保存，准备处理音频。' },
  audio_mux: { label: '正在合成视频', progressStep: 2, fallback: '画面和音轨已取得，正在合成完整视频。' },
  image_download_request: { label: '正在请求图片素材', progressStep: 2, fallback: '正在请求图文中的图片素材。' },
  image_download_waiting: { label: '等待图片素材', progressStep: 2, fallback: '图片素材请求已发出，正在等待下载响应。' },
  image_download: { label: '正在下载图片', progressStep: 2, fallback: '作品信息已取得，正在保存图文素材。' },
  image_download_received: { label: '图片素材已收到', progressStep: 2, fallback: '图片素材已保存，准备进行 OCR。' },
  audio_extract: { label: '正在提取音轨', progressStep: 2, fallback: '视频已保存，正在提取语音音轨。' },
  audio_extract_received: { label: '音轨已准备好', progressStep: 2, fallback: '音轨已提取，准备发送给 ASR。' },
  asr_request: { label: '正在启动 ASR', progressStep: 2, fallback: '正在准备 whisper.cpp large-v3-turbo 转写。' },
  asr_waiting: { label: '等待 ASR 转写', progressStep: 2, fallback: '音频已交给 whisper.cpp，正在等待转写结果。' },
  asr: { label: '正在转写语音', progressStep: 2, fallback: '正在使用 whisper.cpp large-v3-turbo 转写语音。' },
  asr_received: { label: 'ASR 已完成', progressStep: 2, fallback: '已收到语音转写结果，准备识别画面文字。' },
  video_ocr_request: { label: '正在准备画面 OCR', progressStep: 2, fallback: '正在抽取视频关键帧并准备 RapidOCR。' },
  video_ocr_waiting: { label: '等待画面 OCR', progressStep: 2, fallback: '关键帧已提交给 RapidOCR，正在等待识别结果。' },
  video_ocr: { label: '正在识别画面文字', progressStep: 2, fallback: '正在用 RapidOCR 检查视频关键帧。' },
  video_ocr_received: { label: '画面 OCR 已完成', progressStep: 2, fallback: '已收到关键帧文字识别结果。' },
  ocr_request: { label: '正在准备图片 OCR', progressStep: 2, fallback: '正在准备 RapidOCR 图片识别。' },
  ocr_waiting: { label: '等待图片 OCR', progressStep: 2, fallback: '图片已提交给 RapidOCR，正在等待识别结果。' },
  ocr: { label: '正在识别图片文字', progressStep: 2, fallback: '正在用 RapidOCR 识别图文内容。' },
  ocr_received: { label: '图片 OCR 已完成', progressStep: 2, fallback: '已收到图片文字识别结果。' },
  evidence_validation: { label: '正在校验证据', progressStep: 2, fallback: '正在核对识别结果和本地素材。' },
  evidence_validated: { label: '证据已校验', progressStep: 2, fallback: '识别结果和素材已通过证据校验。' },
  card_queue: { label: '等待成卡队列', progressStep: 3, fallback: '证据已经生成，等待本机成卡队列处理。' },
  card_prepare: { label: '正在准备模型输入', progressStep: 3, fallback: '正在读取证据并整理成模型输入。' },
  card_provider: { label: '模型配置已就绪', progressStep: 3, fallback: '已确认模型和供应商配置，准备发送请求。' },
  card_model_request: { label: '正在发送给模型', progressStep: 3, fallback: '正在把证据和整理要求发送给模型。' },
  card_model_waiting: { label: '等待模型响应', progressStep: 3, fallback: '模型请求已发出，正在等待模型返回。' },
  card_model_response: { label: '已收到模型响应', progressStep: 3, fallback: '已收到模型返回内容，正在读取候选卡片。' },
  card_model_parse: { label: '正在解析模型结果', progressStep: 3, fallback: '正在解析模型返回的 JSON 卡片结果。' },
  card_model_failed: { label: '模型请求失败', progressStep: 3, fallback: '模型没有返回可用结果，可以从成卡阶段重试。' },
  card_validate: { label: '正在检查卡片', progressStep: 3, fallback: '正在检查卡片结构、引用和可用性。' },
  candidate_review: { label: '候选待审核', progressStep: 3, fallback: '新版候选已经生成，等待内容审核；尚未发布。' },
  card_publish: { label: '正在发布卡片', progressStep: 3, fallback: '卡片已通过检查，正在写入卡片库。' },
  cloud_complete: { label: '正在结束云端任务', progressStep: 4, fallback: '本地卡片已发布，正在结束云端任务。' },
  evidence_ready: { label: '等待生成卡片', progressStep: 3, fallback: '内容已经提取，等待整理成卡片。' },
  retry_evidence: { label: '等待继续识别', progressStep: 2, fallback: '复用已有素材，从识别步骤继续。' },
  retry_card: { label: '等待继续成卡', progressStep: 3, fallback: '复用已有证据，从生成卡片继续。' },
  card: { label: '正在生成卡片', progressStep: 3, fallback: '内容已经提取，正在整理成卡片。' },
  published: { label: '处理完成', progressStep: 4, fallback: '卡片已经生成并写入卡片库。' }
};

function safeName(eventId) {
  const value = String(eventId ?? '');
  if (!/^[A-Za-z0-9._-]{6,128}$/.test(value)) throw new Error('无效收藏事件 ID');
  return value;
}

export async function writeCardProcessingStatus(projectDirectory, eventId, update) {
  const id = safeName(eventId);
  const directory = path.join(projectDirectory, 'runtime', directoryName);
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, `${id}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  let previous = null;
  try { previous = JSON.parse(await fs.readFile(target, 'utf8')); } catch { /* first write or a partial file */ }
  const updatedAt = new Date().toISOString();
  const entry = {
    status: update.status,
    stage: update.stage ?? null,
    substage: update.substage ?? null,
    message: update.message ?? null,
    updated_at: updatedAt
  };
  const previousHistory = Array.isArray(previous?.history) ? previous.history : [];
  const last = previousHistory.at(-1);
  const history = last && last.status === entry.status && last.stage === entry.stage
    && last.substage === entry.substage && last.message === entry.message
    ? [...previousHistory.slice(0, -1), entry]
    : [...previousHistory, entry].slice(-40);
  const payload = {
    event_id: id,
    status: update.status,
    stage: update.stage ?? null,
    substage: update.substage ?? null,
    message: update.message ?? null,
    run_directory: update.runDirectory ?? null,
    review_url: update.status === 'review_pending' ? update.reviewUrl ?? null : null,
    phase: update.phase ?? previous?.phase ?? null,
    progress_step: update.progressStep ?? previous?.progress_step ?? null,
    progress_total: update.progressTotal ?? previous?.progress_total ?? 4,
    history,
    updated_at: updatedAt
  };
  await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, target);
  return payload;
}

export async function loadCardProcessingStatuses(projectDirectory) {
  const directory = path.join(projectDirectory, 'runtime', directoryName);
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
  const statuses = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const value = JSON.parse(await fs.readFile(path.join(directory, entry.name), 'utf8'));
      if (value?.event_id) statuses.set(value.event_id, value);
    } catch {
      // Ignore a partial or damaged diagnostic file; queue state still renders.
    }
  }
  return statuses;
}
