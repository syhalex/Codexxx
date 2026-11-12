import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rm, stat } from 'node:fs/promises';
import { atomicWrite, optionalFile, parseJson, UserError, windows } from './storage.mjs';

export const providers = ['codex', 'antigravity'];
export const roots = {
  codex: process.env.CODEX_HOME || join(homedir(), '.codex'),
  antigravity: process.env.LOCAL_WORKSPACE_GEMINI_HOME || join(homedir(), '.gemini'),
};
const config = {
  codex: join(roots.codex, 'auth.json'),
  antigravity: join(roots.antigravity, 'jetski-standalone-oauth-token')
};
const antigravityCliDir = join(roots.antigravity, 'antigravity-cli');
const antigravityCliCredential = join(antigravityCliDir, 'antigravity-oauth-token');
const codexClient = 'app_EMoamEEZ73f0CkXaXp7hrann';
const string = value => typeof value === 'string' ? value.trim() : '';

export class AntigravityOAuthConfigError extends UserError {
  constructor() {
    super('缺少这个 Antigravity 账号的原 OAuth 客户端配置', 401);
  }
}

function jwt(value) {
  try {
    return JSON.parse(Buffer.from(string(value).split('.')[1], 'base64url').toString('utf8')) ?? {};
  } catch { return {}; }
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e11 ? value : value * 1000;
  }
  return typeof value === 'string' ? Date.parse(value) || null : null;
}

function hash(value) {
  return createHash('sha256').update(value).digest('base64url');
}

function tokenData(native) {
  const token = native.tokens ?? native.token ?? native;
  const access = string(token.access_token ?? token.accessToken);
  const claims = jwt(access);
  const idToken = string(token.id_token ?? token.idToken ?? native.id_token ?? native.idToken);
  const identity = jwt(idToken);
  const auth = claims['https://api.openai.com/auth'] ?? identity['https://api.openai.com/auth'] ?? {};
  return {
    access, refresh: string(token.refresh_token ?? token.refreshToken), idToken,
    expires: timestamp(token.expiry ?? token.expiry_date ?? token.expires_at ?? token.expiresAt ?? token.expiry_timestamp ?? claims.exp),
    accountId: string(token.account_id ?? native.account_id ?? auth.chatgpt_account_id),
    subject: string(auth.chatgpt_user_id ?? identity.sub ?? claims.sub),
    email: string(native.email || token.email || identity.email || native.id_token_email || claims['https://api.openai.com/profile']?.email),
    name: string(native.name || native.display_name || identity.name),
    plan: string(native.plan_type ?? auth.chatgpt_plan_type),
    project: string(token.project_id ?? native.project_id),
    gcpTos: Boolean(token.is_gcp_tos ?? native.is_gcp_tos)
  };
}

export function makeAccount(provider, input, label = '', profile = null) {
  if (!providers.includes(provider)) throw new UserError('请选择平台');
  if (typeof input === 'string') input = parseJson(input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UserError('凭据格式无效');
  const token = tokenData(input);
  const key = string(input.apiKey ?? input.api_key ?? (input.auth_mode === 'chatgpt' || token.access ? '' : input.OPENAI_API_KEY));
  if (!key && !token.access && !(provider === 'antigravity' && token.refresh)) throw new UserError('未找到可用的登录凭据');
  if (key && (/[^\x21-\x7e]/.test(key) || key.length > 4096)) throw new UserError('API 密钥格式无效');
  const email = token.email || string(input.email || profile?.emailAddress);
  const name = token.name || string(input.name || input.display_name || profile?.displayName || profile?.name);
  const stable = key || [token.accountId, token.subject || profile?.accountUuid || email].filter(Boolean).join('/') || token.refresh || token.access;
  return {
    id: randomUUID(), provider, kind: key ? 'key' : 'oauth', key, native: input, token, profile,
    fingerprint: hash(stable), email, name, customLabel: Boolean(string(label)),
    label: (string(label) || name || email || (key ? 'API 密钥' : '本机账号')).slice(0, 80),
    plan: key ? 'API Key' : token.plan, quota: [], quotaAt: null, quotaError: '', addedAt: Date.now()
  };
}

function decodeCredential(encoded) {
  const buffer = Buffer.from(encoded, 'base64');
  return parseJson(buffer.toString(buffer[1] === 0 ? 'utf16le' : 'utf8').replace(/\0+$/, ''));
}

function compatibleAntigravityLogin(left, right) {
  return Boolean(left.refresh && left.refresh === right.refresh ||
    left.subject && left.subject === right.subject ||
    left.email && left.email.toLowerCase() === right.email.toLowerCase());
}

async function checkCodexFileMode(targetKind) {
  const config = await optionalFile(join(roots.codex, 'config.toml'));
  if (!config) return;
  // Only inspect root authentication settings, excluding comments and multiline strings.
  const root = config.replace(/^\uFEFF/, '').replace(/"""(?:\\[\s\S]|(?!""")[\s\S])*"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*'|#[^\r\n]*/g,
    token => token.startsWith('#') ? '' : token.startsWith('"""') || token.startsWith("'''") ? '""' : token)
    .split(/^[ \t]*\[/m, 1)[0];
  const settings = new Map();
  for (const [, bare, doubleQuoted, singleQuoted, , value] of root.matchAll(
    /^[ \t]*(?:([\w-]+)|"([\w-]+)"|'([\w-]+)')[ \t]*=[ \t]*(["'])([\w-]+)\4[ \t\r]*$/gm
  )) settings.set(bare || doubleQuoted || singleQuoted, value);
  const store = settings.get('cli_auth_credentials_store');
  if (store && store !== 'file') throw new UserError('Codex 配置使用 ' + store + ' 凭据模式，工作台仅支持文件模式', 409);
  const method = settings.get('forced_login_method');
  if (targetKind && method && method !== (targetKind === 'key' ? 'api' : 'chatgpt')) {
    throw new UserError('Codex 配置限制了登录方式，无法切换到所选账号', 409);
  }
}

export async function readLocal(provider, targetKind) {
  const path = config[provider];
  if (provider === 'antigravity') {
    let readError;
    const recover = error => { readError ||= error; return null; };
    const raw = await optionalFile(path).catch(recover);
    const saved = process.platform === 'win32' && !process.env.LOCAL_WORKSPACE_GEMINI_HOME
      ? await windows('agy-read').catch(recover) : '';
    let input = null;
    if (saved) {
      try { input = decodeCredential(saved); }
      catch (error) { recover(error); }
    }
    const keyring = input;
    const cli = await optionalFile(antigravityCliCredential).catch(recover);
    for (const source of [raw, cli]) {
      if (!source) continue;
      let alternative;
      try { alternative = parseJson(source); }
      catch (error) { recover(error); continue; }
      if (!alternative) continue;
      if (!input) { input = alternative; continue; }
      const current = tokenData(input);
      const candidate = tokenData(alternative);
      if (candidate.access && candidate.expires > (current.expires || 0) && compatibleAntigravityLogin(current, candidate)) input = alternative;
    }
    if (!input && readError) throw readError;
    return { raw, input, credential: saved, cli, usesKeyring: Boolean(input && input === keyring) };
  }
  await checkCodexFileMode(targetKind);
  const raw = await optionalFile(path);
  return raw ? { raw, input: parseJson(raw) } : { raw: null, input: null };
}

export function canSwitch(account) {
  if (account.kind === 'key') return account.provider === 'codex';
  if (account.provider === 'codex') return Boolean(account.token.access && account.token.idToken && account.token.refresh);
  return Boolean(account.token.refresh);
}

export function exportCredential(account) {
  if (account.kind === 'key') return { apiKey: account.key };
  const { access, refresh, idToken, accountId, expires, project } = account.token;
  return {
    email: account.email || undefined, name: account.name || undefined, plan_type: account.plan || undefined,
    client_id: account.native.client_id, client_secret: account.native.client_secret,
    last_refresh: account.provider === 'codex' ? account.native.last_refresh : undefined,
    tokens: {
      access_token: access, refresh_token: refresh, id_token: idToken || undefined,
      account_id: accountId || undefined, expires_at: expires || undefined, project_id: project || undefined,
      is_gcp_tos: account.token.gcpTos || undefined
    }
  };
}

export async function writeLocal(account, current) {
  const { provider, kind, token, key, native } = account;
  const path = config[provider];
  if (provider === 'codex') {
    await checkCodexFileMode(kind);
    if (kind === 'oauth') {
      const workspace = value => string(jwt(value)?.['https://api.openai.com/auth']?.chatgpt_account_id);
      const identities = new Set([token.accountId, workspace(token.access), workspace(token.idToken)].filter(Boolean));
      if (identities.size > 1) throw new UserError('Codex 登录凭据指向不同工作区，请重新登录并导入', 409);
    }
    const lastRefresh = timestamp(native.last_refresh);
    const auth = kind === 'key' ? { auth_mode: 'apikey', OPENAI_API_KEY: key } : {
      auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: lastRefresh ? new Date(lastRefresh).toISOString() : undefined,
      tokens: { id_token: token.idToken, access_token: token.access, refresh_token: token.refresh, account_id: token.accountId || undefined }
    };
    await atomicWrite(path, JSON.stringify(auth, null, 2), current.raw);
  } else {
    const payload = {
      token: {
        access_token: token.access, token_type: 'Bearer', refresh_token: token.refresh,
        expiry: token.expires ? new Date(token.expires).toISOString() : undefined
      },
      auth_method: native.auth_method || 'consumer',
      id_token: token.idToken || undefined
    };
    const encoded = JSON.stringify(payload);
    const useSystem = process.platform === 'win32' && !process.env.LOCAL_WORKSPACE_GEMINI_HOME;
    const original = useSystem ? await windows('agy-read') : '';
    if (original !== (current.credential || '')) throw new UserError('Antigravity 刚刚更新了登录凭据，请重试', 409);
    const cliDir = await stat(antigravityCliDir).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const syncCli = cliDir?.isDirectory();
    const systemPayload = Buffer.from(encoded).toString('base64');
    let wroteDesktop = false;
    let wroteCli = false;
    let wroteSystem = false;
    try {
      if (useSystem) {
        await windows('agy-write', systemPayload);
        wroteSystem = true;
      }
      await atomicWrite(path, encoded, current.raw);
      wroteDesktop = true;
      if (syncCli) {
        await atomicWrite(antigravityCliCredential, encoded, current.cli);
        wroteCli = true;
      }
      const checks = [optionalFile(path).then(raw => raw === encoded)];
      if (syncCli) checks.push(optionalFile(antigravityCliCredential).then(raw => raw === encoded));
      if (useSystem) checks.push(windows('agy-read').then(raw => raw === systemPayload));
      if (!(await Promise.all(checks)).every(Boolean)) {
        throw new UserError('Antigravity 凭据写入后未能核对，请关闭客户端后重试', 409);
      }
    } catch (error) {
      const restores = [];
      if (wroteDesktop) restores.push(restoreFile(path, current.raw, encoded));
      if (wroteCli) restores.push(restoreFile(antigravityCliCredential, current.cli, encoded));
      if (wroteSystem) {
        restores.push(windows('agy-read').then(raw => {
          if (raw === systemPayload) return original ? windows('agy-write', original) : windows('agy-clear');
        }));
      }
      if ((await Promise.allSettled(restores)).some(result => result.status === 'rejected')) {
        throw new UserError('Antigravity 凭据同步失败，部分凭据无法恢复，请检查客户端登录', 409);
      }
      if (error instanceof UserError) throw error;
      const code = error.code ? ' (' + error.code + ')' : '';
      throw new UserError('Antigravity 凭据同步失败' + code, 500);
    }
  }
}

async function restoreFile(path, previous, expected) {
  if (await optionalFile(path) !== expected) return;
  if (previous !== null) await atomicWrite(path, previous, expected);
  else await rm(path);
}

export async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(16_000) });
  } catch {
    throw new UserError('无法连接平台，请检查网络', 502);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const message = response.status === 401 || response.status === 403
      ? '平台拒绝了凭据，请重新登录' : '平台返回 HTTP ' + response.status;
    throw new UserError(message, response.status);
  }
  try { return await response.json(); }
  catch { throw new UserError('平台返回了无效的数据', 502); }
}

function post(body, headers = {}) {
  return { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

export async function refreshToken(account, force = false) {
  const { provider, token, native } = account;
  if (account.kind === 'key' || !force && token.access && (!token.expires || token.expires > Date.now() + 30_000)) return false;
  if (!token.refresh) throw new UserError('登录已过期，请重新导入账号', 401);
  const body = { grant_type: 'refresh_token', refresh_token: token.refresh };
  let result;
  if (provider === 'codex') {
    result = await requestJson('https://auth.openai.com/oauth/token', post({ ...body, client_id: codexClient }));
  } else {
    const clientId = string(native.client_id || process.env.LOCAL_WORKSPACE_GOOGLE_CLIENT_ID);
    const clientSecret = string(native.client_secret || process.env.LOCAL_WORKSPACE_GOOGLE_CLIENT_SECRET);
    if (!clientId || !clientSecret) throw new AntigravityOAuthConfigError();
    try {
      result = await requestJson('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'user-agent': 'vscode/1.X.X (Antigravity/4.3.0)' },
        body: new URLSearchParams({ ...body, client_id: clientId, client_secret: clientSecret })
      });
    } catch (error) {
      if ([400, 401].includes(error.status)) throw new UserError('Google 拒绝了 Antigravity 续期，请在客户端重新登录后再导入', 401);
      throw error;
    }
  }
  if (!string(result.access_token)) throw new UserError('平台没有返回新的访问凭据');
  token.access = result.access_token;
  token.refresh = result.refresh_token || token.refresh;
  token.idToken = result.id_token || token.idToken;
  token.expires = result.expires_in ? Date.now() + Number(result.expires_in) * 1000 : timestamp(jwt(token.access).exp);
  if (provider === 'codex') native.last_refresh = new Date().toISOString();
  if (provider === 'antigravity' && result.id_token) {
    const profile = jwt(result.id_token);
    updateAccountIdentity(account, profile);
  }
  return true;
}

export function updateAccountIdentity(account, profile) {
  const defaultLabel = !account.customLabel && ['本机账号', account.email, account.name].includes(account.label);
  account.name = string(profile.name) || account.name;
  account.email = string(profile.email) || account.email;
  account.token.subject ||= string(profile.sub || profile.id);
  if (defaultLabel) account.label = (account.name || account.email || account.label).slice(0, 80);
}

function windowData(label, remaining, resetAt) {
  if (remaining === null || remaining === undefined || !Number.isFinite(Number(remaining))) return [];
  return [{ label, remaining: Math.min(100, Math.max(0, Math.round(Number(remaining)))), resetAt: timestamp(resetAt) }];
}

export function codexHeaders(account) {
  return { authorization: 'Bearer ' + account.token.access,
    ...(account.token.accountId ? { 'ChatGPT-Account-Id': account.token.accountId } : {}) };
}

function subscriptionTime(value) {
  const date = typeof value === 'string' && /^\d+$/.test(value) ? timestamp(Number(value)) : timestamp(value);
  return Number.isFinite(date) && date > 0 ? date : null;
}

export function codexSubscriptionExpiry(account) {
  if (account.provider !== 'codex' || account.kind !== 'oauth') return null;
  if (Object.hasOwn(account, 'subscriptionExpiresAt')) return account.subscriptionExpiresAt;
  const auth = 'https://api.openai.com/auth';
  return subscriptionTime(jwt(account.token.idToken)[auth]?.chatgpt_subscription_active_until ??
    jwt(account.token.access)[auth]?.chatgpt_subscription_active_until);
}

function subscriptionRequest(account, path, query) {
  const url = new URL('https://chatgpt.com' + path);
  url.search = new URLSearchParams(query);
  return requestJson(url, { headers: {
    authorization: 'Bearer ' + account.token.access, accept: 'application/json',
    referer: 'https://chatgpt.com/', 'x-openai-target-path': path, 'x-openai-target-route': path,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
  } });
}

export async function fetchCodexSubscription(account) {
  const preferred = account.token.accountId;
  const checked = await subscriptionRequest(account, '/backend-api/accounts/check/v4-2023-04-27',
    { timezone_offset_min: new Date().getTimezoneOffset() });
  const records = Object.entries(checked.accounts ?? {});
  const accountIdOf = value => {
    const details = value?.account ?? value;
    return string(details?.account_id || details?.id || details?.chatgpt_account_id || details?.workspace_id);
  };
  const match = records.find(([key, value]) => preferred && (key === preferred || accountIdOf(value) === preferred));
  const distinct = records.filter(([key]) => key !== 'default');
  const record = (match || (!preferred && distinct.length === 1 ? distinct[0] : null))?.[1];
  const details = record?.account ?? record;
  const entitlement = record?.entitlement;
  const accountId = preferred || accountIdOf(record);
  const checkedExpiry = subscriptionTime(entitlement?.expires_at ?? details?.expires_at);
  const checkedPlan = string(entitlement?.subscription_plan || details?.plan_type || details?.planType);
  if (!accountId) return { expiresAt: checkedExpiry, plan: checkedPlan };
  try {
    const subscription = await subscriptionRequest(account, '/backend-api/subscriptions', { account_id: accountId });
    return { expiresAt: subscriptionTime(subscription.active_until) ?? subscriptionTime(subscription.expires_at) ?? checkedExpiry,
      plan: string(subscription.subscription_plan || subscription.plan_type) || checkedPlan };
  } catch (error) {
    if (checkedExpiry) return { expiresAt: checkedExpiry, plan: checkedPlan };
    throw error;
  }
}

export function antigravityCloud(account) {
  return account.token.gcpTos && account.token.project && account.token.project !== 'aicode-consumers'
    ? 'https://cloudcode-pa.googleapis.com' : 'https://daily-cloudcode-pa.googleapis.com';
}

const cloudCodeHeaders = account => ({
  authorization: 'Bearer ' + account.token.access,
  'user-agent': 'antigravity/2.25.0 (aidev_client; os_type=' + (process.platform === 'win32' ? 'windows' : 'linux') +
    '; arch=' + (process.arch === 'arm64' ? 'arm64' : 'amd64') + '; cl=1003475615)'
});

function creditsFrom(tier) {
  const amount = value => typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
    ? String(value).slice(0, 40) : '';
  return Array.isArray(tier?.availableCredits) ? tier.availableCredits.flatMap(credit => {
    const balance = amount(credit?.creditAmount);
    return balance ? [{ type: string(credit.creditType), balance, minimum: amount(credit.minimumCreditAmountForUsage) }] : [];
  }) : [];
}

export async function cloudProject(account, refresh = false) {
  if (account.token.project && !refresh) return account.token.project;
  const windowsHost = process.platform === 'win32';
  const preferred = account.token.project && account.token.project !== 'aicode-consumers' ? account.token.project : undefined;
  const data = await requestJson(antigravityCloud(account) + '/v1internal:loadCodeAssist', post({
    cloudaicompanionProject: preferred,
    metadata: {
      ideName: 'antigravity', ideType: 'ANTIGRAVITY', ideVersion: '2.25.0', updateChannel: 'stable',
      pluginType: 'GEMINI', platform: windowsHost ? 'WINDOWS_AMD64' : 'LINUX_AMD64', duetProject: preferred
    }
  }, {
    ...cloudCodeHeaders(account), 'x-goog-api-client': 'gl-node/22.21.1',
    'user-agent': 'antigravity/2.25.0 ' + (windowsHost ? 'windows' : 'linux') + '/amd64 google-api-nodejs-client/10.3.0'
  }));
  const project = data.cloudaicompanionProject;
  account.token.project = string(project?.id ?? project?.projectId ?? project) || account.token.project;
  const tier = data.paidTier ?? data.currentTier;
  if (typeof tier?.usesGcpTos === 'boolean') account.token.gcpTos = tier.usesGcpTos;
  account.plan = string(tier?.name ?? tier?.id) || account.plan;
  account.quotaCredits = creditsFrom(tier);
  return account.token.project;
}

const bucketNames = {
  '3p-5h': 'claude:short', 'claude:5h': 'claude:short',
  '3p-weekly': 'claude:week', 'claude:weekly': 'claude:week',
  'gemini-5h': 'gemini:short', 'gemini:5h': 'gemini:short',
  'gemini-weekly': 'gemini:week', 'gemini:weekly': 'gemini:week',
  'gemini-argon-5h': 'argon:short', 'argon:5h': 'argon:short',
  'gemini-argon-wtu-weekly': 'argon:week', 'argon:weekly': 'argon:week'
};
const bucketFamilies = { claude: 'Claude', gemini: 'Gemini', argon: 'Gemini 4 Argon' };

function parseQuotaBuckets(data) {
  if (!Array.isArray(data.groups) || data.groups.some(group => !Array.isArray(group?.buckets))) {
    throw new UserError('共享额度返回格式有误', 502);
  }
  const rows = new Map();
  const buckets = data.groups.flatMap(group => group.buckets);
  for (const bucket of buckets) {
    const id = string(bucket?.bucketId);
    if (!id || typeof bucket.remainingFraction !== 'number') continue;
    const canonical = Object.hasOwn(bucketNames, id) ? bucketNames[id] : '';
    const [family, window] = canonical.split(':');
    const label = canonical ? bucketFamilies[family] + ' ' + (window === 'short' ? '5 小时' : '每周') : string(bucket.displayName) || id;
    const quota = windowData(label, bucket.remainingFraction * 100, bucket.resetTime)[0];
    if (quota && !rows.has(canonical || id)) rows.set(canonical || id, { ...quota, id: canonical || id, kind: 'bucket', family, window });
  }
  if (buckets.length && !rows.size) throw new UserError('平台未返回有效的共享窗口', 502);
  return [...rows.values()];
}

function parseModelQuotas(data) {
  return [...antigravityMenuModels(data)].flatMap(([key, model]) => {
    const quota = model?.quotaInfo;
    const remaining = quota?.remainingFraction ?? (quota?.resetTime ? 0 : null);
    return windowData(string(model?.displayName) || key, remaining == null ? null : remaining * 100, quota?.resetTime)
      .map(row => ({ ...row, id: key, kind: 'model' }));
  });
}

function antigravityModels(data) {
  const models = data?.payload?.models ?? data?.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) throw new UserError('Antigravity 模型目录返回格式有误', 502);
  return Object.entries(models);
}

function antigravityRequest(account, method, project) {
  const body = project && project !== 'aicode-consumers' ? { project } : {};
  return requestJson(antigravityCloud(account) + '/v1internal:' + method, post(body, cloudCodeHeaders(account)));
}

export const validModelId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,120}$/.test(id);

function modelOptions(entries) {
  const models = new Map();
  for (const [id, label] of entries) {
    if (validModelId(id) && !models.has(id)) models.set(id, { id, label: string(label).slice(0, 128) || id });
  }
  return [...models.values()];
}

async function codexModelVersion() {
  const cache = await optionalFile(join(roots.codex, 'models_cache.json'))
    .then(raw => raw ? parseJson(raw) : null).catch(() => null);
  const version = cache?.client_version;
  return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : '0.167.0';
}

async function codexModels(account) {
  if (account.kind === 'key') {
    const data = await requestJson('https://api.openai.com/v1/models', { headers: { authorization: 'Bearer ' + account.key } });
    if (!Array.isArray(data.data)) throw new UserError('模型列表返回格式有误', 502);
    // The API returns basic metadata, so exclude known non-text endpoints by category.
    const textModels = data.data.map(row => row?.id).filter(id => validModelId(id) &&
      !/(?:^|-)(?:audio|realtime|transcri\w*|tts|image|dall-e|embedding|moderation|whisper|sora|instruct)(?:-|$)/i.test(id));
    return modelOptions(textModels.sort((a, b) => b.localeCompare(a, 'en', { numeric: true })).map(id => [id]));
  }
  const url = new URL('https://chatgpt.com/backend-api/codex/models');
  url.searchParams.set('client_version', await codexModelVersion());
  const data = await requestJson(url, { headers: { ...codexHeaders(account), originator: 'codex_cli_rs' } });
  if (!Array.isArray(data.models)) throw new UserError('模型列表返回格式有误', 502);
  const priority = row => Number.isFinite(row.priority) ? row.priority : Number.MAX_SAFE_INTEGER;
  return modelOptions(data.models.filter(row => row && !['hide', 'none'].includes(row.visibility) &&
    (!Array.isArray(row.input_modalities) || row.input_modalities.includes('text')))
    .sort((a, b) => priority(a) - priority(b)).map(row => [row.slug, row.display_name]));
}

async function geminiModels(account) {
  const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
  url.searchParams.set('pageSize', '1000');
  const entries = [];
  const seen = new Set();
  for (;;) {
    const data = await requestJson(url, { headers: { 'x-goog-api-key': account.key } });
    if (!Array.isArray(data.models ?? [])) throw new UserError('模型列表返回格式有误', 502);
    for (const model of data.models ?? []) {
      if (Array.isArray(model?.supportedGenerationMethods) && model.supportedGenerationMethods.includes('generateContent')) {
        const id = string(model.name);
        if (id.startsWith('models/')) entries.push([id.slice('models/'.length), model.displayName]);
      }
    }
    const next = string(data.nextPageToken);
    if (!next) return modelOptions(entries);
    if (seen.has(next)) throw new UserError('平台返回了重复的模型列表分页', 502);
    seen.add(next);
    url.searchParams.set('pageToken', next);
  }
}

function antigravityMenuModels(data) {
  const models = new Map(antigravityModels(data));
  const rawSorts = data.payload?.agentModelSorts ?? data.agentModelSorts;
  const sorts = Array.isArray(rawSorts) ? rawSorts.filter(sort => Array.isArray(sort?.groups)) : [];
  const menu = sorts.find(sort => /^recommended$/i.test(string(sort.name))) || sorts[0];
  const groupedIds = menu?.groups.flatMap(group => Array.isArray(group?.modelIds) ? group.modelIds : []) ?? [];
  const ids = menu ? groupedIds : [...models.keys()].filter(id => models.get(id)?.recommended === true);
  const deprecated = data.payload?.deprecatedModelIds ?? data.deprecatedModelIds ?? {};
  const isDeprecated = id => Array.isArray(deprecated) ? deprecated.includes(id) : Object.hasOwn(deprecated, id);
  return new Map(ids.flatMap(id => {
    const model = models.get(id);
    if (!validModelId(id) || !model || model.available === false || model.isAvailable === false || model.disabled === true ||
        isDeprecated(id)) return [];
    return [[id, model]];
  }));
}

async function antigravityMenu(account) {
  const project = await cloudProject(account).catch(error => {
    if (error.status === 401 || error.status === 403) throw error;
    return account.token.project;
  });
  const data = await antigravityRequest(account, 'fetchAvailableModels', project);
  return antigravityMenuModels(data);
}

export async function fetchModels(account) {
  if (account.provider === 'codex') return codexModels(account);
  if (account.kind === 'key') return geminiModels(account);
  return modelOptions([...await antigravityMenu(account)].map(([id, model]) => [id, model.displayName]));
}

export async function resolveAntigravityModel(account, id) {
  const model = (await antigravityMenu(account)).get(id);
  if (!model) throw new UserError('这个模型已不在 Antigravity 客户端菜单中，请重新加载模型', 422);
  const value = typeof model.model === 'number' ? String(model.model) : string(model.model);
  if (/^\d{1,9}$/.test(value)) return Number(value);
  const placeholder = value.match(/^(?:MODEL_)?PLACEHOLDER_M(\d{1,6})$/);
  if (placeholder) return 1000 + Number(placeholder[1]);
  if (/^MODEL_[A-Z0-9_]+$/.test(value)) return value;
  throw new UserError('Antigravity 模型目录缺少客户端模型标识，请重新加载模型', 422);
}

async function fetchAntigravityQuota(account) {
  let project = account.token.project;
  let planWarning = '';
  try { project = await cloudProject(account, true); }
  catch (error) {
    if (error.status === 401) throw error;
    planWarning = '套餐信息暂未更新';
  }
  const results = await Promise.allSettled([
    antigravityRequest(account, 'retrieveUserQuotaSummary', project).then(parseQuotaBuckets),
    antigravityRequest(account, 'fetchAvailableModels', project).then(parseModelQuotas)
  ]);
  return applyAntigravityQuota(account, results, planWarning);
}

export async function readAntigravityDesktopQuota(account, expectedEmail, call) {
  const { userStatus } = await call('GetUserStatus', {});
  if (string(userStatus?.email).toLowerCase() !== expectedEmail.toLowerCase()) {
    throw new UserError('Antigravity 桌面登录与所选账号不一致，请确认客户端账号后重试', 409);
  }
  const results = await Promise.allSettled([
    call('RetrieveUserQuotaSummary', {}).then(data => parseQuotaBuckets(data.response)),
    call('GetAvailableModels', {}).then(data => parseModelQuotas(data.response))
  ]);
  const tier = userStatus.userTier;
  const plan = string(tier?.name || userStatus.planStatus?.planInfo?.planName);
  const rows = applyAntigravityQuota(account, results, plan ? '' : '套餐信息暂未更新');
  updateAccountIdentity(account, userStatus);
  account.plan = plan || account.plan;
  if (tier) account.quotaCredits = creditsFrom(tier);
  return rows;
}

function applyAntigravityQuota(account, [buckets, models], planWarning) {
  if (buckets.status === 'rejected' && models.status === 'rejected') throw buckets.reason;
  const cached = (kind, result) => result.status === 'fulfilled' ? result.value :
    account.quota.filter(item => (item.kind || 'model') === kind).map(item => ({ ...item, cached: true }));
  const bucketRows = cached('bucket', buckets);
  const modelRows = cached('model', models);
  if (models.status === 'fulfilled') account.quotaModelsFiltered = true;
  account.quotaWarning = [
    buckets.status === 'rejected' && (bucketRows.length ? '共享窗口沿用上次记录' : '共享窗口暂不可用'),
    models.status === 'rejected' && (modelRows.length ? '模型明细沿用上次记录' : '模型明细暂不可用'),
    planWarning
  ].filter(Boolean).join('，');
  return [...bucketRows, ...modelRows];
}

function codexWindow(row, fallback) {
  const seconds = Number(row?.limit_window_seconds);
  const units = [[604800, '周'], [86400, '天'], [3600, '小时'], [60, '分钟']];
  const unit = units.find(([size]) => seconds >= size && seconds % size === 0);
  const label = seconds === 604800 ? '每周窗口' : unit ? seconds / unit[0] + ' ' + unit[1] + '窗口' : fallback;
  const remaining = row?.used_percent == null ? null : 100 - row.used_percent;
  const resetAt = row?.reset_at ?? (row?.reset_after_seconds == null ? null : Date.now() + row.reset_after_seconds * 1000);
  return { label, remaining, resetAt };
}

function codexWindows(limits, prefix = '') {
  return [[limits?.primary_window, '5 小时窗口'], [limits?.secondary_window, '每周窗口']].flatMap(([row, fallback]) => {
    const { label, remaining, resetAt } = codexWindow(row, fallback);
    return windowData(prefix + label, remaining, resetAt);
  });
}

export async function fetchQuota(account) {
  if (account.kind === 'key') throw new UserError('API 密钥没有订阅额度');
  const headers = { authorization: 'Bearer ' + account.token.access };
  if (account.provider === 'codex') {
    const data = await requestJson('https://chatgpt.com/backend-api/wham/usage', { headers: codexHeaders(account) });
    account.plan = string(data.plan_type) || account.plan;
    const modelWindows = Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits.flatMap(entry => {
      const name = string(entry?.limit_name ?? entry?.metered_feature);
      return name ? codexWindows(entry.rate_limit, name + ' ') : [];
    }) : [];
    return [...codexWindows(data.rate_limit), ...codexWindows(data.code_review_rate_limit, '代码审查 '), ...modelWindows];
  }
  const profile = account.name && account.email ? null : requestJson('https://www.googleapis.com/oauth2/v2/userinfo', { headers })
    .then(info => updateAccountIdentity(account, info));
  const [quota] = await Promise.allSettled([fetchAntigravityQuota(account), profile]);
  if (quota.status === 'rejected') throw quota.reason;
  return quota.value;
}
