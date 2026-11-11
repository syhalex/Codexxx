import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { UserError } from './storage.mjs';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const algorithms = new Set(['SHA1', 'SHA256', 'SHA512']);
const deriveKey = promisify(scrypt);
const backupKdf = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
const format = 'local-workspace-totp';
const clean = value => typeof value === 'string' ? value.trim() : '';

function base32(value) {
  const secret = clean(value).toUpperCase().replace(/[\s-]+/g, '').replace(/=+$/, '');
  if (!/^[A-Z2-7]{16,205}$/.test(secret)) throw new UserError('请输入有效的 Base32 密钥');
  const bytes = Buffer.alloc(Math.floor(secret.length * 5 / 8));
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const char of secret) {
    accumulator = accumulator << 5 | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = accumulator >> bits;
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits >= 5 || accumulator) throw new UserError('Base32 密钥的长度或末尾编码无效');
  return { secret, bytes };
}

export function normalizeTotp(input, existing) {
  let label = clean(input.label);
  let issuer = clean(input.issuer);
  let secret = clean(input.value);
  let algorithm = clean(existing?.algorithm ?? input.algorithm) || 'SHA1';
  let digits = Number(existing?.digits ?? input.digits ?? 6);
  let period = Number(existing?.period ?? input.period ?? 30);
  if (/^otpauth:/i.test(secret)) {
    let uri;
    let name;
    try {
      uri = new URL(secret);
      name = decodeURIComponent(uri.pathname.slice(1)).trim();
    } catch { throw new UserError('验证器链接格式无效'); }
    if (uri.hostname !== 'totp' || uri.username || uri.password || uri.port || !name) throw new UserError('请选择 TOTP 验证器链接');
    const separator = name.indexOf(':');
    label ||= separator < 0 ? name : name.slice(separator + 1).trim();
    issuer ||= uri.searchParams.get('issuer')?.trim() || (separator < 0 ? '' : name.slice(0, separator).trim());
    secret = uri.searchParams.get('secret') || '';
    algorithm = uri.searchParams.get('algorithm') || 'SHA1';
    digits = Number(uri.searchParams.get('digits') ?? 6);
    period = Number(uri.searchParams.get('period') ?? 30);
    if (!secret) throw new UserError('验证器链接缺少密钥');
  }
  if (!label || label.length > 120 || issuer.length > 80 || /[\r\n]/.test(label + issuer)) {
    throw new UserError('请输入有效的账号名称和服务名称');
  }
  algorithm = algorithm.toUpperCase().replace(/^SHA-/, 'SHA');
  if (!algorithms.has(algorithm) || ![6, 8].includes(digits) || !Number.isInteger(period) || period < 5 || period > 120) {
    throw new UserError('该验证码的算法、位数或周期不受支持');
  }
  return { label, issuer, secret: base32(secret || existing?.secret).secret, algorithm, digits, period };
}

export function totpSnapshot(entry, now = Date.now()) {
  const counter = Math.floor(now / (entry.period * 1000));
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(entry.algorithm.toLowerCase(), base32(entry.secret).bytes).update(buffer).digest();
  const offset = digest.at(-1) & 15;
  const code = String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** entry.digits).padStart(entry.digits, '0');
  const { id, label, issuer, period } = entry;
  return { id, label, issuer, period, code, expiresAt: (counter + 1) * period * 1000 };
}

export function totpIdentity(entry) {
  return JSON.stringify([entry.label.toLowerCase(), entry.issuer.toLowerCase(), entry.secret, entry.algorithm, entry.digits, entry.period]);
}

function backupPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 256) throw new UserError('备份口令需要 8 至 256 个字符');
  return value;
}

export async function sealTotp(entries, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(backupPassword(password), salt, 32, backupKdf);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(entries)), cipher.final()]);
  return { format, version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export async function openTotpBackup(backup, password) {
  if (backup?.format !== format || backup.version !== 1 ||
      !['salt', 'iv', 'tag', 'data'].every(key => typeof backup[key] === 'string')) {
    throw new UserError('请选择工作台的 2FA 加密备份');
  }
  const [salt, iv, tag, data] = ['salt', 'iv', 'tag', 'data'].map(key => Buffer.from(backup[key], 'base64'));
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || !data.length) throw new UserError('备份文件格式无效');
  const key = await deriveKey(backupPassword(password), salt, 32, backupKdf);
  let entries;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    entries = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
  } catch { throw new UserError('备份口令不正确或文件已损坏'); }
  if (!Array.isArray(entries) || !entries.length || entries.length > 500) throw new UserError('备份条目数量无效');
  return entries.map(entry => normalizeTotp({ ...entry, value: entry?.secret }));
}
