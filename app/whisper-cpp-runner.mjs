import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultBinary = path.join(projectDirectory, 'runtime', 'asr', 'whisper.cpp', 'build', 'bin', 'whisper-cli');
const defaultModel = path.join(projectDirectory, 'runtime', 'asr', 'whisper.cpp', 'models', 'ggml-large-v3-turbo.bin');

function clamp(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function offsetSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number / 1000 : 0;
}

function runProcess(executable, args, logPath, spawnImpl) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, { cwd: projectDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', async (code, signal) => {
      try {
        await writeFile(logPath, `${stdout}${stderr ? `\n${stderr}` : ''}`, 'utf8');
      } catch (error) {
        reject(new Error(`whisper.cpp 日志写入失败：${error.message}`));
        return;
      }
      if (code !== 0) return reject(new Error(`whisper.cpp 失败（退出码 ${code}${signal ? `，${signal}` : ''}）：${stderr.slice(-1200)}`));
      resolve();
    });
  });
}

export async function transcribeWithWhisperCpp(audioPath, {
  outputDirectory = null,
  durationSeconds = null,
  binaryPath = process.env.HERMES_WHISPER_CPP_PATH || defaultBinary,
  modelPath = process.env.HERMES_WHISPER_CPP_MODEL || defaultModel,
  threads = Number.parseInt(process.env.HERMES_WHISPER_CPP_THREADS || '8', 10),
  spawnImpl = spawn
} = {}) {
  const temporaryDirectory = outputDirectory ? null : await mkdtemp(path.join(os.tmpdir(), 'hermes-whispercpp-'));
  const directory = outputDirectory ? path.resolve(outputDirectory) : temporaryDirectory;
  await mkdir(directory, { recursive: true });
  const prefix = path.join(directory, 'whispercpp-transcript');
  const rawPath = `${prefix}.json`;
  const logPath = path.join(directory, 'whispercpp.log');
  const started = process.hrtime.bigint();
  try {
    await runProcess(binaryPath, [
      '-m', modelPath,
      '-f', audioPath,
      '-l', 'auto',
      '-t', String(Number.isFinite(threads) && threads > 0 ? threads : 8),
      '-p', '1',
      '-ojf',
      '-of', prefix
    ], logPath, spawnImpl);
    const raw = JSON.parse(await readFile(rawPath, 'utf8'));
    if (!Array.isArray(raw.transcription) || raw.transcription.length === 0) {
      throw new Error('whisper.cpp 没有返回转写片段');
    }
    const segments = raw.transcription.map((item, index) => {
      const words = (item.tokens || [])
        .filter((token) => token?.text && !String(token.text).startsWith('[_'))
        .map((token) => ({
          start: offsetSeconds(token.offsets?.from),
          end: offsetSeconds(token.offsets?.to),
          text: String(token.text),
          probability: token.p == null ? null : clamp(token.p)
        }));
      const probabilities = words.map((word) => word.probability).filter((value) => value !== null);
      return {
        index: index + 1,
        start: offsetSeconds(item.offsets?.from),
        end: offsetSeconds(item.offsets?.to),
        text: String(item.text || '').trim(),
        confidence: probabilities.length
          ? probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length
          : 0,
        words
      };
    }).filter((segment) => segment.text);
    if (segments.length === 0) throw new Error('whisper.cpp 转写结果为空');
    const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    const inferredDuration = Math.max(...segments.map((segment) => segment.end));
    return {
      schema_version: 'hermes/asr-transcript/v1',
      engine: 'whisper.cpp',
      model: 'large-v3-turbo',
      backend: 'native automatic backend selection',
      compute_type: 'ggml',
      language: raw.result?.language || raw.params?.language || 'unknown',
      language_probability: null,
      duration_seconds: Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 0
        ? Number(Number(durationSeconds).toFixed(3))
        : Number(inferredDuration.toFixed(3)),
      segments,
      text: segments.map((segment) => segment.text).join('\n'),
      run: {
        raw_output_path: outputDirectory ? path.basename(rawPath) : null,
        log_path: outputDirectory ? path.basename(logPath) : null,
        elapsed_seconds: Number(elapsedSeconds.toFixed(3))
      }
    };
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
