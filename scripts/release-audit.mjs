import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const listed = (args) => git(...args).split('\0').filter(Boolean);
const paths = [...new Set([
  ...listed(['ls-files', '-z']),
  ...listed(['ls-files', '--others', '--exclude-standard', '-z'])
])];
const failures = [];
const warnings = [];
const forbiddenPath = /(^|\/)(?:data|outputs|logs|node_modules|\.gradle|build|fixtures|local-intake-media|__pycache__|\.venv)(\/|$)|\.(?:apk|aab|mp4|wav|gguf|pem|key|pyc|sqlite(?:-wal|-shm)?)$/i;
const vendorRoot = 'runtime/f2-capture-spike/_vendor/f2/';
const textTypes = /\.(?:mjs|js|json|kt|kts|py|md|txt|html|css|xml|yaml|yml|toml|sh|gradle|properties|example)$/i;
const checks = [
  ['个人绝对路径', /\/Users\/[^\s'"`]+|\/home\/ubuntu\//g],
  ['疑似密钥', /(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{40,})/g],
  ['个人服务地址', /(?:meowtask\.top|trycloudflare\.com)/gi]
];
for (const file of paths) {
  if (forbiddenPath.test(file) || (file.startsWith('runtime/') && !file.startsWith(vendorRoot)) || file === '.env') {
    failures.push(`${file}: 不允许的发布路径`); continue;
  }
  if (!textTypes.test(file) && !['Dockerfile', 'LICENSE', 'NOTICE', '.gitignore', '.dockerignore'].includes(path.basename(file))) continue;
  let body;
  try { body = await readFile(path.join(root, file), 'utf8'); }
  catch { failures.push(`${file}: 无法读取`); continue; }
  for (const [label, regex] of checks) if (regex.test(body)) failures.push(`${file}: ${label}`);
  if (!file.startsWith(vendorRoot) && /\b\d{19}\b/.test(body)) warnings.push(`${file}: 19 位数字需人工判断是否真实作品 ID`);
  if (file.endsWith('.yaml') || file.endsWith('.yml')) {
    for (const line of body.split(/\r?\n/)) {
      const match = /^\s*(?:cookie|Authorization|api[_-]?key|secret|token):\s*(.*)$/i.exec(line);
      if (!match) continue;
      const value = match[1].split('#')[0].trim();
      if (value && !['""', "''", 'null', '~'].includes(value)) warnings.push(`${file}: YAML 中疑似凭据字段需人工核对`);
    }
  }
}
const commits = git('rev-list', '--all').trim().split('\n').filter(Boolean);
const seenBlobs = new Set();
for (const commit of commits) {
  const entries = listed(['ls-tree', '-rz', '--full-tree', commit]);
  for (const entry of entries) {
    const match = /^[0-7]+ blob ([a-f0-9]+)\t(.+)$/.exec(entry);
    if (!match) continue;
    const [, hash, file] = match;
    if (forbiddenPath.test(file) || (file.startsWith('runtime/') && !file.startsWith(vendorRoot)) || file === '.env') {
      failures.push(`Git 历史 ${commit.slice(0, 12)}: ${file} 曾被提交`);
    }
    if (seenBlobs.has(hash) || (!textTypes.test(file) && !['Dockerfile', 'LICENSE', 'NOTICE', '.gitignore', '.dockerignore'].includes(path.basename(file)))) continue;
    seenBlobs.add(hash);
    const body = git('cat-file', 'blob', hash);
    for (const [label, regex] of checks) if (regex.test(body)) failures.push(`Git 历史 ${commit.slice(0, 12)}: ${file}: ${label}`);
    if (!file.startsWith(vendorRoot) && /\b\d{19}\b/.test(body)) warnings.push(`Git 历史 ${commit.slice(0, 12)}: ${file}: 19 位数字需人工核对`);
  }
}
console.log(`待发布文件：${paths.length}；历史提交：${commits.length}；阻断项：${failures.length}；待人工核对：${warnings.length}`);
for (const line of failures) console.log(`FAIL ${line}`);
for (const line of warnings) console.log(`REVIEW ${line}`);
if (failures.length) process.exitCode = 1;
