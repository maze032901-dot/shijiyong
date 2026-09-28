import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachManualMedia } from '../app/manual-media.mjs';
import { fetchCloudJobs, readCloudStatusConfig } from '../app/cloud-status.mjs';
import { validEventId } from '../app/retry-stage.mjs';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const values = { files: [] };
for (let index = 0; index < args.length; index++) {
  const option = args[index];
  if (!['--event', '--kind', '--file'].includes(option) || !args[index + 1]) {
    throw new Error('用法：npm run attach:media -- --event 事件ID --kind video|gallery --file 素材路径 [--file ...]');
  }
  if (option === '--file') values.files.push(args[++index]);
  else values[option.slice(2)] = args[++index];
}
if (!validEventId(values.event)) throw new Error('请提供有效的原收藏事件 ID');
const config = await readCloudStatusConfig(projectDirectory);
const job = (await fetchCloudJobs(config)).find((item) => item.eventId === values.event);
if (!job) throw new Error('云端未找到原收藏；不会创建新收藏');
const queued = await attachManualMedia({ projectDirectory, job, kind: values.kind, files: values.files });
console.log(`已给原收藏 ${job.eventId} 补交 ${values.files.length} 个素材，状态：${queued.status}。Mac 处理器会从识别阶段继续。`);
