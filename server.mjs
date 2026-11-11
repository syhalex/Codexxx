import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createVault, parseJson, UserError } from './lib/storage.mjs';
import { canSwitch, codexSubscriptionExpiry, exportCredential, fetchCodexSubscription, fetchModels, fetchQuota, makeAccount, providers, readLocal, refreshToken, resolveAntigravityModel, updateAccountIdentity, validModelId, writeLocal } from './lib/providers.mjs';
import { getSession, scanSessions, sessionSummary } from './lib/sessions.mjs';
import { sessionUsage } from './lib/session-usage.mjs';
import { createPricingCatalog } from './lib/model-pricing.mjs';
import { normalizeTotp, openTotpBackup, sealTotp, totpIdentity, totpSnapshot } from './lib/totp.mjs';
import { createRelay, readJson, sendJson, wakeModel } from './lib/relay.mjs';
import { canLaunch, openCli, prepareCli } from './lib/cli.mjs';
import { wakeAntigravity } from './lib/antigravity-wake.mjs';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本');

const desktop = process.argv.includes('--desktop');
const port = Number(process.env.LOCAL_WORKSPACE_PORT || 4812);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('工作台端口无效');
const origin = 'http://127.0.0.1:' + port;
const dataPath = process.env.LOCAL_WORKSPACE_DATA || join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'LocalWorkspace');
const loadPrices = createPricingCatalog(dataPath);
const staticTypes = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/platforms/codex-desktop.png': ['platforms/codex-desktop.png', 'image/png'],
  '/platforms/antigravity.svg': ['platforms/antigravity.svg', 'image/svg+xml']
};
const assets = new Map(await Promise.all(Object.entries(staticTypes).map(async ([path, [file, type]]) =>
  [path, { type, body: await readFile(new URL('public/' + file, import.meta.url)) }])));
const sources = (await readdir(new URL('lib/', import.meta.url))).filter(file => file.endsWith('.mjs')).sort();
const build = createHash('sha256').update(import.meta.url).update('\0').update(resolve(dataPath));
for (const file of ['server.mjs', ...sources.map(file => 'lib/' + file)]) {
  build.update('\0' + file + '\0').update(await readFile(new URL(file, import.meta.url)));
}
for (const [path, asset] of assets) build.update('\0' + path + '\0').update(asset.body);
const buildId = build.digest('hex');
let vault;
const switchingProviders = new Set();
const quotaRefreshes = new Map();
const quotaRefreshInterval = 30 * 60_000;

function findAccount(state, id) {
  const account = state.accounts.find(item => item.id === id);
  if (!account) throw new UserError('找不到该账号', 404);
  return account;
}

function sameAccount(left, right) {
  if (!right || left.provider !== right.provider || left.kind !== right.kind) return false;
  return left.fingerprint === right.fingerprint || Boolean(
    left.token.refresh && left.token.refresh === right.token.refresh ||
    left.token.access && left.token.access === right.token.access ||
    left.provider === 'antigravity' && left.token.subject && left.token.subject === right.token.subject &&
      (left.native.auth_method || 'consumer') === (right.native.auth_method || 'consumer')
  );
}

function putAccount(state, account, explicitLabel) {
  if (explicitLabel) account.customLabel = true;
  const existing = state.accounts.find(item => sameAccount(item, account));
  if (!existing) {
    state.accounts.push(account);
    return account;
  }
  account.token.project ||= existing.token.project;
  let token = account.token;
  if (account.provider === 'antigravity') {
    account.native.client_id ||= existing.native.client_id;
    account.native.client_secret ||= existing.native.client_secret;
    account.token.gcpTos ||= existing.token.gcpTos;
    if (existing.token.access && existing.token.expires && (!account.token.access ||
        account.token.expires && existing.token.expires > account.token.expires)) token = existing.token;
  }
  updateAccountIdentity(existing, account);
  if (explicitLabel) {
    existing.label = account.label;
    existing.customLabel = true;
  }
  token.subject ||= existing.token.subject;
  Object.assign(existing, {
    key: account.key, native: account.native, token,
    profile: account.profile || existing.profile, plan: account.plan || existing.plan
  });
  return existing;
}

async function nativeAccount(provider, targetKind) {
  const local = await readLocal(provider, targetKind);
  return { local, account: local.input ? makeAccount(provider, local.input) : null };
}

async function ensureToken(state, account) {
  if (account.kind === 'key') return;
  const { account: local } = await nativeAccount(account.provider).catch(error => {
    if (state.active[account.provider] === account.id) throw error;
    return { account: null };
  });
  const active = state.accounts.find(item => sameAccount(item, local));
  if (active) state.active[account.provider] = active.id;
  else delete state.active[account.provider];
  if (active?.id === account.id) {
    putAccount(state, local);
    if (account.provider !== 'antigravity') {
      if (account.token.access && (!account.token.expires || account.token.expires > Date.now() + 15_000)) return;
      throw new UserError('请在客户端续登后重试', 401);
    }
  }
  await refreshToken(account);
}

const relay = createRelay({
  state: () => vault.get(),
  resolveAccount: (id, provider) => vault.change(async state => {
    if (!state.routes[provider]?.includes(id)) throw new UserError('账号已移出服务', 404);
    const account = findAccount(state, id);
    await ensureToken(state, account);
    return account;
  }),
  log: item => vault.change(state => {
    state.relayLogs.unshift(item);
    state.relayLogs.length = Math.min(state.relayLogs.length, 80);
  })
});

function publicAccount(account, active) {
  const { id, provider, kind, label, name, email, plan, quota, quotaAt, quotaError, deletedAt, lastSwitchedAt, lastWakeAt, addedAt } = account;
  return { id, provider, kind, label, name, email, plan, quota, quotaAt, quotaError, deletedAt, lastSwitchedAt, lastWakeAt, addedAt,
    subscriptionExpiresAt: codexSubscriptionExpiry(account), subscriptionCheckedAt: account.subscriptionCheckedAt || null,
    subscriptionError: account.subscriptionError || '',
    tags: account.tags || [], quotaCredits: account.quotaCredits || [], quotaWarning: account.quotaWarning || '',
    switchable: canSwitch(account), launchable: canLaunch(account) && (kind === 'key' || canSwitch(account)),
    active: active[provider] === id };
}

function publicState(active = vault.get().active) {
  const state = vault.get();
  return {
    accounts: state.accounts.map(account => publicAccount(account, active)),
    trash: state.trash.map(account => publicAccount(account, {})),
    relay: { ...relay.status(), routes: state.routes, revision: state.relayRevision,
      strategy: state.relayStrategy, logs: state.relayLogs }
  };
}

async function detectedAccounts() {
  const state = vault.get();
  const active = { ...state.active };
  await Promise.all(providers.filter(provider => state.accounts.some(account => account.provider === provider)).map(async provider => {
    try {
      const { account: local } = await nativeAccount(provider);
      const match = state.accounts.find(account => sameAccount(account, local));
      if (match) active[provider] = match.id;
      else delete active[provider];
    } catch {
      delete active[provider];
    }
  }));
  return active;
}

async function importAccount(body) {
  if (!providers.includes(body.provider)) throw new UserError('请选择平台');
  const provider = body.provider;
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
  const local = body.source === 'local';
  const value = body.source === 'json' && typeof body.value === 'string' ? parseJson(body.value) : body.value;
  const backup = body.source === 'json' && value?.format === 'local-workspace-account' ? value : null;
  if (backup && (backup.version !== 1 || backup.provider !== provider || !backup.credential)) {
    throw new UserError('请选择对应的平台和包含登录凭据的备份');
  }
  const { account } = local ? await nativeAccount(provider) : {
    account: makeAccount(provider, body.source === 'key' ? { apiKey: value } : backup?.credential ?? value,
      label || backup?.label, backup?.profile)
  };
  if (!account) throw new UserError('未找到本机登录，请先在客户端完成登录');
  if (label) account.label = label;
  return vault.change(state => {
    const saved = putAccount(state, account, Boolean(label || backup?.label));
    if (backup) saved.tags = cleanTags(backup.tags);
    if (local) state.active[provider] = saved.id;
    return saved.id;
  });
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.filter(tag => typeof tag === 'string').map(tag => tag.replace(/\u00B7/g, ' ').trim().slice(0, 24)).filter(Boolean))].slice(0, 10);
}

function accountExport(account, includeCredential) {
  const file = {
    format: 'local-workspace-account', version: 1, provider: account.provider,
    label: account.label, name: account.name, email: account.email, plan: account.plan,
    tags: account.tags || []
  };
  if (includeCredential === true) {
    file.credential = exportCredential(account);
    if (account.profile) file.profile = account.profile;
  }
  return file;
}

function matchesLocalCredential(target, current) {
  if (!current || target.kind !== current.kind) return false;
  if (target.kind === 'key') return target.key === current.key;
  const { access, refresh, idToken, accountId } = target.token;
  return access === current.token.access && refresh === current.token.refresh && idToken === current.token.idToken &&
    (target.provider !== 'codex' || accountId === current.token.accountId);
}

async function switchAccount(id, terminal) {
  const target = findAccount(vault.get(), id);
  const { provider } = target;
  if (switchingProviders.has(provider)) throw new UserError('该平台正在切换账号，请稍后重试', 409);
  switchingProviders.add(provider);
  let confirmed = false;
  try {
    const { local, before, renewalError } = await vault.change(async state => {
      const account = findAccount(state, id);
      if (!canSwitch(account)) throw new UserError('该凭据不支持切换客户端');
      const { local, account: before } = await nativeAccount(provider, account.kind);
      if (before) {
        const saved = state.accounts.find(item => sameAccount(item, before));
        const savedIsNewer = before.token.expires && saved?.token.expires > before.token.expires;
        if (!savedIsNewer) putAccount(state, before);
      }
      // Persist a rotated refresh token before touching the client files.
      const renewalError = await refreshToken(account).then(() => null, error => error);
      return { local, before, renewalError };
    });
    if (renewalError) throw renewalError;
    await vault.change(async state => {
      const account = findAccount(state, id);
      if (provider === 'antigravity' || !matchesLocalCredential(account, before)) await writeLocal(account, local);
      const { account: current } = await nativeAccount(provider, account.kind).catch(() => ({ account: null }));
      if (!matchesLocalCredential(account, current)) {
        throw new UserError('客户端凭据核对失败，请关闭客户端后重试', 409);
      }
      if (!sameAccount(account, before)) account.lastSwitchedAt = Date.now();
      state.active[provider] = id;
      confirmed = true;
    }).catch(error => {
      if (confirmed) throw new UserError('客户端凭据已切换，但工作台未能保存当前账号，请重试', 500);
      throw error;
    });
    if (terminal) {
      await openCli(terminal).catch(() => { throw new UserError('客户端账号已切换，但终端启动失败', 502); });
    }
  } finally {
    switchingProviders.delete(provider);
  }
}

async function refreshQuota(id) {
  if (quotaRefreshes.has(id)) return quotaRefreshes.get(id);
  const request = vault.change(async state => {
    const account = findAccount(state, id);
    try {
      if (account.kind === 'key') throw new UserError('API 密钥没有订阅额度');
      await ensureToken(state, account);
      try {
        account.quota = await fetchQuota(account);
      } catch (error) {
        if (error.status !== 401 || !account.token.refresh ||
            account.provider !== 'antigravity' && state.active[account.provider] === account.id) throw error;
        await refreshToken(account, true);
        account.quota = await fetchQuota(account);
      }
      account.quotaAt = Date.now();
      account.quotaError = '';
      return true;
    } catch (error) {
      account.quotaError = error instanceof UserError ? error.message : '额度查询失败';
      return false;
    } finally {
      account.quotaCheckedAt = Date.now();
    }
  }).finally(() => quotaRefreshes.delete(id));
  quotaRefreshes.set(id, request);
  return request;
}

async function refreshDueQuotas() {
  try {
    for (const { id } of vault.get().accounts) {
      const account = vault.get().accounts.find(item => item.id === id);
      if (account?.kind !== 'oauth' || switchingProviders.has(account.provider) ||
          Date.now() - (account.quotaCheckedAt || account.quotaAt || 0) < quotaRefreshInterval) continue;
      await refreshQuota(id).catch(() => {});
    }
  } finally {
    setTimeout(refreshDueQuotas, 60_000).unref();
  }
}

async function modelAccount(id) {
  const account = findAccount(vault.get(), id);
  if (account.kind === 'key') return account;
  return vault.change(async state => {
    const selected = findAccount(state, id);
    await ensureToken(state, selected);
    return structuredClone(selected);
  });
}

async function changeAccount(body) {
  if (body.action === 'switch') return switchAccount(body.id);
  if (body.action === 'quota') return refreshQuota(body.id);
  if (body.action === 'subscription') return vault.change(async state => {
    const account = findAccount(state, body.id);
    if (account.provider !== 'codex' || account.kind !== 'oauth') throw new UserError('该账号没有可查询的 Codex 订阅信息');
    try {
      await ensureToken(state, account);
      const { expiresAt, plan } = await fetchCodexSubscription(account);
      if (plan) account.plan = plan;
      if (!expiresAt && plan.toLowerCase() !== 'free') {
        account.subscriptionError = '平台暂未提供订阅有效期';
        return false;
      }
      account.subscriptionExpiresAt = expiresAt;
      account.subscriptionCheckedAt = Date.now();
      account.subscriptionError = '';
      return true;
    } catch (error) {
      account.subscriptionError = error instanceof UserError ? error.message : '订阅查询失败';
      return false;
    }
  });
  if (body.action === 'export') {
    return accountExport(findAccount(vault.get(), body.id), body.includeCredential);
  }
  if (body.action === 'launch') {
    const account = findAccount(vault.get(), body.id);
    const terminal = await prepareCli(account, body.directory);
    if (account.kind === 'oauth') await switchAccount(account.id, terminal);
    else await openCli(terminal);
    return;
  }
  if (body.action === 'wake') {
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!validModelId(model)) throw new UserError('请选择模型或输入有效的模型 ID');
    const account = await modelAccount(body.id);
    if (account.provider === 'antigravity' && account.kind === 'oauth') {
      await wakeAntigravity(account, await resolveAntigravityModel(account, model));
    } else await wakeModel(account, model);
    await vault.change(state => {
      const current = state.accounts.find(item => item.id === account.id);
      if (current) current.lastWakeAt = Date.now();
    });
    if (account.kind === 'oauth' && vault.get().accounts.some(item => item.id === account.id)) await refreshQuota(account.id);
    return;
  }
  return vault.change(state => {
    if (body.action === 'restore' || body.action === 'purge') {
      const account = state.trash.find(item => item.id === body.id);
      if (!account) throw new UserError('回收站中找不到该账号', 404);
      if (body.action === 'restore') {
        if (state.accounts.some(item => sameAccount(item, account))) throw new UserError('该账号已重新导入');
        delete account.deletedAt;
        state.accounts.push(account);
      }
      state.trash = state.trash.filter(item => item.id !== account.id);
      return;
    }
    const account = findAccount(state, body.id);
    if (body.action === 'rename') {
      if (typeof body.label !== 'string' || !body.label.trim()) throw new UserError('请输入账号名称');
      account.label = body.label.trim().slice(0, 80);
      account.customLabel = true;
    } else if (body.action === 'tags') account.tags = cleanTags(body.tags);
    else if (body.action === 'delete') {
      state.trash.unshift({ ...account, deletedAt: Date.now() });
      state.accounts = state.accounts.filter(item => item.id !== account.id);
      if (state.active[account.provider] === account.id) delete state.active[account.provider];
      const members = state.routes[account.provider];
      if (members?.includes(account.id)) {
        state.routes[account.provider] = members.filter(id => id !== account.id);
        state.relayRevision++;
      }
    } else throw new UserError('未知账号操作');
  });
}

async function changeSession(body) {
  const session = await getSession(body.key, vault.get());
  return vault.change(state => {
    const details = state.sessions[session.key] ??= {};
    if (body.action === 'title') {
      if (typeof body.title !== 'string' || !body.title.trim()) throw new UserError('请输入会话名称');
      details.title = body.title.trim().slice(0, 140);
    } else if (body.action === 'archive') details.archived = Boolean(body.value);
    else if (body.action === 'pin') details.pinned = Boolean(body.value);
    else throw new UserError('未知会话操作');
  });
}

function listTotp() {
  const now = Date.now();
  return { entries: vault.get().totp.map(entry => totpSnapshot(entry, now)), now };
}

async function changeTotp(body) {
  if (body.action === 'list') return listTotp();
  if (body.action === 'export') {
    const entries = vault.get().totp;
    if (!entries.length) throw new UserError('暂无可备份的验证码');
    return { backup: await sealTotp(entries, body.password) };
  }
  if (body.action === 'import') {
    const entries = await openTotpBackup(body.backup, body.password);
    const added = await vault.change(state => {
      const identities = new Set(state.totp.map(totpIdentity));
      let count = 0;
      for (const item of entries) {
        const key = totpIdentity(item);
        if (identities.has(key)) continue;
        if (state.totp.length >= 500) throw new UserError('最多保存 500 个验证码');
        identities.add(key);
        state.totp.push({ ...item, id: randomUUID() });
        count++;
      }
      return count;
    });
    return { ...listTotp(), added };
  }
  await vault.change(state => {
    const index = state.totp.findIndex(item => item.id === body.id);
    if (body.action === 'save') {
      if (body.id && index < 0) throw new UserError('找不到该验证码', 404);
      const entry = normalizeTotp(body, state.totp[index]);
      if (state.totp.some((item, i) => i !== index && totpIdentity(item) === totpIdentity(entry))) {
        throw new UserError('该验证码已保存');
      }
      if (index >= 0) state.totp[index] = { ...entry, id: body.id };
      else {
        if (state.totp.length >= 500) throw new UserError('最多保存 500 个验证码');
        state.totp.push({ ...entry, id: randomUUID() });
      }
    } else if (body.action === 'delete') {
      if (index < 0) throw new UserError('找不到该验证码', 404);
      state.totp.splice(index, 1);
    } else throw new UserError('未知 2FA 操作');
  });
  return listTotp();
}

async function changeRelay(body) {
  if (body.action === 'pool') return vault.change(state => {
    if (body.revision !== state.relayRevision) throw new UserError('账号池已在其他窗口更新，请重新打开成员列表', 409);
    if (!Array.isArray(body.ids) || !body.ids.every(id => typeof id === 'string')) throw new UserError('请选择服务账号');
    const routes = {};
    for (const id of new Set(body.ids)) {
      const account = findAccount(state, id);
      (routes[account.provider] ??= []).push(id);
    }
    state.routes = routes;
    state.relayRevision++;
  });
  if (body.action === 'strategy') return vault.change(state => {
    if (!['round-robin', 'quota-first'].includes(body.strategy)) throw new UserError('请选择有效的调度策略');
    state.relayStrategy = body.strategy;
  });
  if (body.action === 'stop') return vault.change(() => relay.stop());
  if (body.action === 'start') {
    const chosen = Number(body.port);
    if (!Number.isInteger(chosen) || chosen < 1024 || chosen > 65535 || chosen === port) throw new UserError('请输入有效的服务端口');
    let started = false;
    try {
      await vault.change(async state => {
        if (!Object.values(state.routes).some(members => members.length)) throw new UserError('请先向账号池添加成员');
        await relay.start(chosen);
        started = true;
        state.relayPort = chosen;
        state.relayKey ||= randomBytes(30).toString('base64url');
      });
    } catch (error) {
      if (started) await relay.stop();
      throw error;
    }
    return;
  }
  if (body.action === 'key') {
    const key = vault.get().relayKey;
    if (!key) throw new UserError('请先启动服务');
    return { key };
  }
  throw new UserError('未知中转操作');
}

async function handle(request, response) {
  if (request.headers.host !== '127.0.0.1:' + port) throw new UserError('请通过本机地址打开工作台', 403);
  const url = new URL(request.url, origin);
  const path = url.pathname;
  if (request.method === 'GET' && path === '/ready') {
    return sendJson(response, vault ? 200 : 503, { app: 'local-workspace', build: buildId });
  }
  const asset = assets.get(path);
  if (request.method === 'GET' && asset) {
    const { type, body } = asset;
    response.writeHead(200, {
      'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin',
      'content-security-policy': "default-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    });
    response.end(body);
    return;
  }
  if (!path.startsWith('/api/')) throw new UserError('找不到该页面', 404);
  if (!vault) throw new UserError('工作台正在启动', 503);
  if (request.headers.origin && request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') {
    throw new UserError('请求来源无效', 403);
  }
  if (request.method === 'GET') {
    if (path === '/api/state') return sendJson(response, 200, publicState(await detectedAccounts()));
    if (path === '/api/relay') return sendJson(response, 200, publicState());
    if (path === '/api/sessions') {
      const sessions = await scanSessions(url.searchParams.has('refresh'));
      return sendJson(response, 200, { sessions: sessions.map(session => sessionSummary(session, vault.get())) });
    }
    if (path === '/api/session-usage') {
      return sendJson(response, 200, await sessionUsage(Number(url.searchParams.get('days') ?? 7),
        url.searchParams.get('provider') ?? 'all', loadPrices));
    }
    if (path === '/api/session') {
      return sendJson(response, 200, await getSession(url.searchParams.get('key'), vault.get(), true, url.searchParams.has('export')));
    }
  }
  if (request.method === 'POST' && request.headers['x-local-workspace'] === '1') {
    const body = await readJson(request);
    if (path === '/api/import') return sendJson(response, 200, { id: await importAccount(body), ...publicState() });
    if (path === '/api/models') return sendJson(response, 200, { models: await fetchModels(await modelAccount(body.id)) });
    if (path === '/api/account') return sendJson(response, 200, { result: await changeAccount(body), ...publicState() });
    if (path === '/api/totp') return sendJson(response, 200, await changeTotp(body));
    if (path === '/api/session') {
      await changeSession(body);
      return sendJson(response, 200, { session: await getSession(body.key, vault.get(), true) });
    }
    if (path === '/api/relay') return sendJson(response, 200, { result: await changeRelay(body), ...publicState() });
  }
  throw new UserError('找不到该操作', 404);
}

function openBrowser() {
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', origin] : [origin];
  const command = { win32: 'rundll32.exe', darwin: 'open' }[process.platform] || 'xdg-open';
  const child = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

const server = createServer((request, response) => {
  handle(request, response).catch(error => {
    if (!response.headersSent) sendJson(response, error.status || 500, {
      error: error instanceof UserError ? error.message : '本机操作失败' + (error.code ? ' (' + error.code + ')' : '')
    });
  });
});
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
} catch (error) {
  if (error.code !== 'EADDRINUSE') throw error;
  const ready = await fetch(origin + '/ready', { signal: AbortSignal.timeout(1000) })
    .then(result => result.ok ? result.json() : null).catch(() => null);
  if (ready?.app !== 'local-workspace') throw new Error('工作台端口已被占用');
  if (ready.build !== buildId) throw new Error('端口上正在运行另一版本或目录的工作台，请先关闭原来的命令行窗口，再运行 Start.cmd');
  if (desktop) console.log(origin);
  if (process.argv.includes('--open')) openBrowser();
  process.exit(0);
}
try { vault = await createVault(dataPath, providers); }
catch (error) { server.close(); throw error; }
console.log(origin);
void refreshDueQuotas();
void loadPrices();
setInterval(loadPrices, 60 * 60_000).unref();
if (process.argv.includes('--open')) openBrowser();
