import { constants, createDecipheriv, createHash, createPublicKey, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PRIVATE_KEY_FILE = 'mobile-control-private.pem';
const PUBLIC_KEY_FILE = 'mobile-control-public.pem';

export async function mobileCommandKeyPair(projectDirectory) {
  const directory = path.join(projectDirectory, 'runtime');
  const privatePath = path.join(directory, PRIVATE_KEY_FILE);
  const publicPath = path.join(directory, PUBLIC_KEY_FILE);
  try {
    const privateKey = await readFile(privatePath, 'utf8');
    let publicKey;
    try { publicKey = await readFile(publicPath, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
      await writeFile(publicPath, publicKey, { flag: 'wx', mode: 0o644 });
    }
    return { privateKey, publicKey, fingerprint: createHash('sha256').update(publicKey).digest('hex') };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(directory, { recursive: true });
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  await writeFile(privatePath, pair.privateKey, { flag: 'wx', mode: 0o600 });
  await chmod(privatePath, 0o600);
  await writeFile(publicPath, pair.publicKey, { flag: 'wx', mode: 0o644 });
  return { privateKey: pair.privateKey, publicKey: pair.publicKey,
    fingerprint: createHash('sha256').update(pair.publicKey).digest('hex') };
}

export function decryptMobileCommand(payload, privateKey) {
  if (!payload || typeof payload !== 'object') throw new Error('加密命令无效');
  const encoded = [payload.encryptedKey, payload.iv, payload.ciphertext];
  if (encoded.some((value) => typeof value !== 'string' || value.length > 40_000 || !/^[A-Za-z0-9+/=]+$/.test(value))) throw new Error('加密命令格式无效');
  const encryptedKey = Buffer.from(payload.encryptedKey, 'base64');
  const iv = Buffer.from(payload.iv, 'base64');
  const ciphertext = Buffer.from(payload.ciphertext, 'base64');
  if (iv.length !== 12 || ciphertext.length < 17) throw new Error('加密命令长度无效');
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, encryptedKey);
  if (key.length !== 32) throw new Error('加密密钥长度无效');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  if (plain.length > 32_000) throw new Error('命令内容过大');
  return JSON.parse(plain.toString('utf8'));
}
