import { createReadStream } from 'node:fs';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import path from 'node:path';
import { validEventId } from './retry-stage.mjs';
import { enqueueLocalRetry } from './local-retry-queue.mjs';

const imageTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const videoTypes = { '.mp4': 'video/mp4' };

export function manualMediaResult(job, request) {
  if (!request?.manualMedia?.assets?.length) throw new Error('缺少本地补交素材');
  const mediaKind = request.manualMedia.kind;
  return {
    ...(job.result || {}),
    status: 'captured',
    media_kind: mediaKind,
    aweme_id: job.awemeId || job.result?.aweme_id || job.sourceUrl?.match(/\/(?:video|note)\/(\d+)/)?.[1] || job.eventId,
    canonical_url: job.result?.canonical_url || job.sourceUrl,
    description: job.result?.description || '',
    captured_at: new Date().toISOString(),
    media_manifest: request.manualMedia.assets.map((asset, index) => ({
      kind: mediaKind === 'video' ? 'video' : 'image', index,
      url: `hermes-manual://asset/${index}`
    }))
  };
}

export async function attachManualMedia({ projectDirectory, job, kind, files }) {
  if (!validEventId(job?.eventId)) throw new Error('原收藏事件 ID 无效');
  if (job.status === 'dismissed' || job.status === 'published') throw new Error('该收藏已删除或发布，不能补交素材');
  if (!['video', 'gallery'].includes(kind)) throw new Error('素材类型必须是 video 或 gallery');
  if (!Array.isArray(files) || !files.length || (kind === 'video' && files.length !== 1) || files.length > 20) {
    throw new Error('视频只能补交一个 MP4；图文可补交 1–20 张图片');
  }
  const types = kind === 'video' ? videoTypes : imageTypes;
  const checked = [];
  for (const file of files) {
    const source = await realpath(file);
    const info = await stat(source);
    const extension = path.extname(source).toLowerCase();
    const limit = kind === 'video' ? 250 * 1024 * 1024 : 30 * 1024 * 1024;
    if (!info.isFile() || !info.size || info.size > limit || !types[extension]) {
      throw new Error(`素材格式或大小不符合要求：${path.basename(file)}`);
    }
    checked.push({ source, extension, contentType: types[extension] });
  }
  const directory = path.join(projectDirectory, 'runtime', 'manual-media', job.eventId, randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const assets = [];
  for (const [index, file] of checked.entries()) {
    const target = path.join(directory, `asset-${String(index).padStart(3, '0')}${file.extension}`);
    await copyFile(file.source, target, constants.COPYFILE_EXCL);
    assets.push({ path: target, contentType: file.contentType });
  }
  return enqueueLocalRetry(projectDirectory, job.eventId, {
    kind: 'evidence', manualMedia: { kind, assets }
  });
}

export function createManualMediaFetch(projectDirectory, eventId, manualMedia) {
  if (!validEventId(eventId) || !manualMedia || !Array.isArray(manualMedia.assets)) throw new Error('补交素材记录无效');
  const root = path.resolve(projectDirectory, 'runtime', 'manual-media', eventId);
  return async (url) => {
    const match = /^hermes-manual:\/\/asset\/(\d+)$/.exec(String(url));
    if (!match) throw new Error('补交素材地址无效');
    const asset = manualMedia.assets[Number(match[1])];
    if (!asset?.path) throw new Error('补交素材不存在');
    const [target, actualRoot] = await Promise.all([realpath(asset.path), realpath(root)]);
    if (!target.startsWith(`${actualRoot}${path.sep}`)) throw new Error('补交素材路径越界');
    const info = await stat(target);
    if (!info.isFile()) throw new Error('补交素材不是文件');
    return new Response(Readable.toWeb(createReadStream(target)), {
      status: 200,
      headers: { 'Content-Type': asset.contentType, 'Content-Length': String(info.size) },
      duplex: 'half'
    });
  };
}
