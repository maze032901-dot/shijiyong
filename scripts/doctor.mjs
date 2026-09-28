import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeProvider } from '../app/ai-provider-store.mjs';
import { readCloudStatusConfig } from '../app/cloud-status.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const mode = args[args.indexOf('--mode') + 1] || 'mac';
const asJson = args.includes('--json');
if (!['mac', 'cloud'].includes(mode)) throw new Error('用法：npm run doctor -- --mode mac|cloud [--json]');
const checks = [];
const add = (name, ok, detail) => checks.push({ name, status: ok ? 'ok' : 'missing', detail });
const exists = async (file) => access(file).then(() => true, () => false);
const runnable = (command, args = ['--version']) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000, stdio: 'ignore' });
  return result.status === 0;
};
const secretOkay = (value) => typeof value === 'string' && value.length >= 24 && !/replace|example|your-|unused/i.test(value);

if (mode === 'cloud') {
  let file = {};
  try {
    const raw = await readFile(path.join(root, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match) file[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch { /* report below */ }
  const env = { ...file, ...process.env };
  const domain = String(env.HERMES_DOMAIN || '');
  add('域名', Boolean(domain && domain.includes('.') && !/example|localhost|127\.0\.0\.1/i.test(domain)), '需将域名指向这台服务器，并开放 80/443。');
  for (const key of ['HERMES_INTAKE_TOKEN', 'HERMES_MOBILE_TOKEN', 'HERMES_MOBILE_PUBLISH_TOKEN']) {
    add(key, secretOkay(env[key]), '需要独立的至少 24 字符随机值；不会显示密钥。');
  }
  const tokens = [env.HERMES_INTAKE_TOKEN, env.HERMES_MOBILE_TOKEN, env.HERMES_MOBILE_PUBLISH_TOKEN];
  add('凭据隔离', tokens.every((value, i) => tokens.indexOf(value) === i), '三种凭据不能复用。');
  add('网页登录', Boolean(env.HERMES_DASHBOARD_USER && env.HERMES_DASHBOARD_PASSWORD_HASH && !/replace|example/i.test(env.HERMES_DASHBOARD_PASSWORD_HASH)), '使用 Caddy 密码哈希，不是明文密码。');
  add('Docker Compose', runnable('docker', ['compose', 'version']), '需安装 Docker Compose 插件。');
} else {
  add('macOS', process.platform === 'darwin', '正式处理平台为 macOS。');
  add('Node.js 22+', Number(process.versions.node.split('.')[0]) >= 22, '需要 Node.js 22 或更新版本。');
  try {
    const config = await readCloudStatusConfig(root);
    add('云端连接', true, '已配置 HTTPS 云端地址和接收凭据。');
    add('Mac 发布凭据', secretOkay(config.mobilePublishToken || process.env.HERMES_MOBILE_PUBLISH_TOKEN), '运行 npm run configure:cloud-status 设置独立的发布凭据。');
  } catch {
    add('云端连接', false, '运行 npm run configure:cloud-status。');
    add('Mac 发布凭据', false, '运行 npm run configure:cloud-status。');
  }
  const f2Python = process.env.HERMES_F2_PYTHON || path.join(root, 'runtime/f2-capture-spike/.venv/bin/python');
  const ocrPython = process.env.HERMES_RAPIDOCR_PYTHON || path.join(root, 'runtime/ocr-compare/.venv/bin/python');
  add('F2 抓取环境', runnable(f2Python, ['-c', 'import f2; import httpx']), '运行 ./scripts/setup-mac.sh。');
  add('RapidOCR 环境', runnable(ocrPython, ['-c', 'import rapidocr, onnxruntime, PIL']), '运行 ./scripts/setup-mac.sh。');
  add('ffmpeg', runnable(process.env.HERMES_FFMPEG_PATH || 'ffmpeg', ['-version']), '需安装 ffmpeg。');
  // Browser capture launches Playwright's system Chrome channel, not its
  // separately downloaded Chromium for Testing executable.
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  add('Google Chrome 备用抓取', await exists(chromePath), '公开网页备用抓取使用本机 Chrome；未安装时 F2 仍可运行，但备用入口不可用。');
  const whisperBinary = process.env.HERMES_WHISPER_CPP_PATH || path.join(root, 'runtime/asr/whisper.cpp/build/bin/whisper-cli');
  const whisperModel = process.env.HERMES_WHISPER_CPP_MODEL || path.join(root, 'runtime/asr/whisper.cpp/models/ggml-large-v3-turbo.bin');
  add('whisper.cpp 程序', await exists(whisperBinary), '配置 HERMES_WHISPER_CPP_PATH。');
  add('large-v3-turbo 模型', await exists(whisperModel), '配置 HERMES_WHISPER_CPP_MODEL；模型文件不随仓库发布。');
  const provider = await activeProvider(root).catch(() => null);
  add('AI 供应商', Boolean(provider?.apiKey && provider?.endpoint && provider?.model), '在本机 /providers 页面配置并启用模型。');
  add('自动成卡启动项', true, 'npm run watch:cloud 会启用自动成卡；直接运行脚本时需设置 HERMES_AUTO_PUBLISH=1。');
}
const result = { mode, ready: checks.every((item) => item.status === 'ok'), checks };
if (asJson) console.log(JSON.stringify(result));
else for (const item of checks) console.log(`${item.status === 'ok' ? '✓' : '✗'} ${item.name}${item.status === 'ok' ? '' : `：${item.detail}`}`);
if (!result.ready) process.exitCode = 1;
