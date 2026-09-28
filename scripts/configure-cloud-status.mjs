import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../app/cloud-status.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, '..');
const configPath = path.join(projectDirectory, 'runtime', 'cloud-status.local.json');
let hideInput = false;
const safeOutput = new Writable({
  write(chunk, encoding, callback) {
    if (!hideInput) process.stdout.write(chunk, encoding);
    callback();
  }
});
const prompt = readline.createInterface({ input: process.stdin, output: safeOutput, terminal: true });

try {
  console.log('配置只保存在这台 Mac，不会写入网页或上传到云端。');
  const baseUrl = await prompt.question('云端基础地址（例如 https://hermes.example.com）：');
  process.stdout.write('接收密钥（输入不会显示）：');
  hideInput = true;
  const token = await prompt.question('');
  hideInput = false;
  process.stdout.write('\n');
  process.stdout.write('Mac 发布凭据（输入不会显示）：');
  hideInput = true;
  const mobilePublishToken = await prompt.question('');
  hideInput = false;
  process.stdout.write('\n');
  if (mobilePublishToken.trim().length < 24) throw new Error('Mac 发布凭据至少需要 24 个字符');
  const config = validateConfig({ baseUrl, token, mobilePublishToken });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  console.log(`配置完成：${configPath}`);
  console.log('密钥不会发送到浏览器。现在运行 npm run doctor -- --mode mac，再启动 Mac 处理器。');
} catch (error) {
  console.error(`配置失败：${error.message}`);
  process.exitCode = 1;
} finally {
  hideInput = false;
  prompt.close();
}
