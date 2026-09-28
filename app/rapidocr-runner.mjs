import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultPython = path.join(projectDirectory, 'runtime', 'ocr-compare', '.venv', 'bin', 'python');
const defaultScript = path.join(projectDirectory, 'scripts', 'run-rapidocr-batch.py');

function runProcess(executable, args, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, { cwd: projectDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`RapidOCR 批处理失败（退出码 ${code}）：${stderr.slice(-1200)}`));
      resolve({ stdout, stderr });
    });
  });
}

export async function runRapidOcrBatch(images, {
  pythonPath = process.env.HERMES_RAPIDOCR_PYTHON || defaultPython,
  scriptPath = process.env.HERMES_RAPIDOCR_SCRIPT || defaultScript,
  spawnImpl = spawn
} = {}) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hermes-rapidocr-'));
  const manifestPath = path.join(directory, 'manifest.json');
  const outputPath = path.join(directory, 'results.jsonl');
  const started = process.hrtime.bigint();
  const manifest = images.map((image, index) => ({
    job_id: image.jobId || `image-${index + 1}`,
    event_id: image.eventId || null,
    asset_id: image.assetId || image.localPath || `image-${index + 1}`,
    local_path: image.localPath || null,
    image_path: image.imagePath
  }));
  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await runProcess(pythonPath, [scriptPath, '--manifest', manifestPath, '--output-jsonl', outputPath], spawnImpl);
    const raw = (await readFile(outputPath, 'utf8')).trim();
    const records = raw ? raw.split(/\r?\n/).map((line) => JSON.parse(line)) : [];
    if (records.length !== images.length) throw new Error(`RapidOCR 返回 ${records.length}/${images.length} 条结果`);
    const batchElapsedSeconds = Number(process.hrtime.bigint() - started) / 1e9;
    return records.map((record, index) => {
      if (record.job_id !== manifest[index].job_id) throw new Error(`RapidOCR 第 ${index + 1} 条结果顺序或任务编号不匹配`);
      return { ...record.result, batch_elapsed_seconds: Number(batchElapsedSeconds.toFixed(3)) };
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
