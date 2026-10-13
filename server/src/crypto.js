// 密码哈希、AES-256-GCM 加密、Cookie 签名、Key 脱敏
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// 开发环境未配置密钥时，生成一次并保存在数据目录，避免每次重启都让会话和已加密的 Key 失效
function devSecret(name) {
  if (config.isProd) throw new Error(`缺少必需的环境变量：${name}`);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, 'dev-secrets.json');
  let saved = {};
  if (fs.existsSync(file)) {
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { saved = {}; }
  }
  if (!saved[name]) {
    saved[name] = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  }
  return saved[name];
}

const sessionSecret = config.sessionSecret || devSecret('SESSION_SECRET');
const encKey = crypto.createHash('sha256').update(config.keyEncSecret || devSecret('KEY_ENC_SECRET')).digest();

// ---------- 密码 ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [algo, saltHex, hashHex] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

// ---------- AES-256-GCM ----------
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

export function decrypt(blob) {
  if (!blob) return '';
  try {
    const [v, ivB, tagB, dataB] = String(blob).split(':');
    if (v !== 'v1') return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

// ---------- 会话 Cookie 签名 ----------
export function sign(value) {
  const mac = crypto.createHmac('sha256', sessionSecret).update(value).digest('base64url');
  return `${value}.${mac}`;
}

export function unsign(signed) {
  const i = String(signed || '').lastIndexOf('.');
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const expected = Buffer.from(sign(value));
  const actual = Buffer.from(signed);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return value;
}

// ---------- Key 脱敏 ----------
/** 只显示 sk-**** 与末4位 */
export function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  return `sk-****${s.slice(-4)}`;
}

/** 把任意文本中疑似 Key 的片段替换为 sk-****，用于日志与错误信息 */
export function redact(text) {
  return String(text ?? '')
    .replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-****')
    .replace(/(Bearer\s+)[A-Za-z0-9_\-.]{8,}/gi, '$1****');
}
