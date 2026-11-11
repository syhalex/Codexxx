import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function optionalFile(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function parseJson(value) {
  try {
    return JSON.parse(value?.replace(/^\uFEFF/, ''));
  } catch {
    throw new UserError('JSON 格式无效');
  }
}

export async function atomicWrite(path, value, expected) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
  try {
    if (expected !== undefined && await optionalFile(path) !== expected) {
      throw new UserError('客户端刚刚更新了登录凭据，请重试', 409);
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

const helper = fileURLToPath(new URL('../runtime/LocalWorkspace.Windows.exe', import.meta.url));
export function windows(action, input = '', options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [action], {
      ...options, windowsHide: true, timeout: 15_000, stdio: ['pipe', 'pipe', 'ignore']
    });
    const chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stdin.on('error', () => {});
    child.on('error', () => reject(new UserError('Windows 凭据工具不可用')));
    child.on('close', code => {
      if (code !== 0) reject(new UserError('无法访问 Windows 凭据存储'));
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
    child.stdin.end(input);
  });
}

function partition(items, keep) {
  const included = [];
  const excluded = [];
  for (const item of items) (keep(item) ? included : excluded).push(item);
  return [included, excluded];
}

export async function createVault(directory, providers) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const windowsHost = process.platform === 'win32';
  const keyPath = join(directory, windowsHost ? 'vault.dpapi' : 'vault.key');
  const statePath = join(directory, 'workspace.enc');
  let sealed = await optionalFile(keyPath);
  if (sealed === null) {
    if (await optionalFile(statePath) !== null) throw new Error('凭据库密钥缺失');
    const generated = randomBytes(32).toString('base64');
    const encoded = windowsHost ? await windows('protect', generated) : generated;
    try {
      await writeFile(keyPath, encoded, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    sealed = await optionalFile(keyPath);
  }
  const key = Buffer.from(windowsHost ? await windows('unprotect', sealed) : sealed, 'base64');
  if (key.length !== 32) throw new Error('凭据库密钥无效');
  let state = { accounts: [], trash: [], active: {}, sessions: {}, totp: [], routes: {}, relayRevision: 0,
    relayStrategy: 'round-robin', relayKey: '', relayPort: 8317, relayLogs: [] };
  const encrypted = await optionalFile(statePath);
  if (encrypted) {
    const bytes = Buffer.from(encrypted, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    const plaintext = Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
    state = { ...state, ...JSON.parse(plaintext) };
    for (const account of [...state.accounts, ...state.trash]) {
      delete account.note;
      if (account.provider === 'antigravity' && !account.quotaModelsFiltered && Array.isArray(account.quota) &&
          account.quota.some(item => item.kind !== 'bucket')) {
        account.quota = account.quota.filter(item => item.kind === 'bucket');
        account.quotaWarning = '请刷新额度以加载客户端模型明细';
      }
    }
  }
  const supported = provider => providers.includes(provider);
  const supportedAccount = item => supported(item.provider);
  const supportedEntry = ([provider]) => supported(provider);
  const [accounts, legacyAccounts] = partition(state.accounts, supportedAccount);
  const [trash, legacyTrash] = partition(state.trash, supportedAccount);
  const [active, legacyActive] = partition(Object.entries(state.active), supportedEntry);
  const [routes, legacyRoutes] = partition(Object.entries(state.routes), supportedEntry);
  const [relayLogs, legacyLogs] = partition(state.relayLogs, supportedAccount);
  const [sessions, legacySessions] = partition(Object.entries(state.sessions), ([key]) => supported(key.split('/')[0]));
  state = { ...state, accounts, trash, relayLogs, active: Object.fromEntries(active), sessions: Object.fromEntries(sessions) };
  state.routes = Object.fromEntries(routes.map(([provider, members]) =>
    [provider, Array.isArray(members) ? members : members ? [members] : []]));
  let queue = Promise.resolve();
  return {
    get: () => state,
    change(update) {
      const task = queue.then(async () => {
        const next = structuredClone(state);
        const result = await update(next);
        // Preserve old provider records in the encrypted file without making them available to the running app.
        const persisted = {
          ...next,
          accounts: [...next.accounts, ...legacyAccounts],
          trash: [...next.trash, ...legacyTrash],
          active: { ...Object.fromEntries(legacyActive), ...next.active },
          routes: { ...Object.fromEntries(legacyRoutes), ...next.routes },
          relayLogs: [...next.relayLogs, ...legacyLogs],
          sessions: { ...Object.fromEntries(legacySessions), ...next.sessions }
        };
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const body = Buffer.concat([cipher.update(JSON.stringify(persisted)), cipher.final()]);
        await atomicWrite(statePath, Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64'));
        state = next;
        return result;
      });
      queue = task.catch(() => {});
      return task;
    }
  };
}
