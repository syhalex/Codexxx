import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { antigravityCloud, cloudProject, codexHeaders } from './providers.mjs';
import { UserError } from './storage.mjs';

export function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}

export async function readJson(request, limit = 1_000_000) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new UserError('请求需要 JSON 内容', 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > limit) {
      request.resume();
      throw new UserError('请求内容过大', 413);
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new UserError('请求内容格式无效'); }
}

function identify(path) {
  if (['/v1/responses', '/v1/chat/completions'].includes(path)) return 'codex';
  if (/^\/v1beta\/models\/[a-zA-Z0-9._-]+:(?:generateContent|streamGenerateContent)$/.test(path)) return 'antigravity';
  throw new UserError('找不到该接口', 404);
}

async function upstream(account, url, body) {
  const { provider, kind, key, token } = account;
  const headers = { 'content-type': 'application/json' };
  let target;
  if (provider === 'codex') {
    if (kind === 'key') {
      headers.authorization = 'Bearer ' + key;
      target = 'https://api.openai.com' + url.pathname;
    } else {
      if (url.pathname !== '/v1/responses') throw new UserError('Codex 登录账号使用 Responses 接口', 422);
      if (body.previous_response_id) throw new UserError('Codex 登录账号需要提交完整会话上下文', 422);
      Object.assign(headers, codexHeaders(account), { accept: 'text/event-stream', originator: 'codex_cli_rs' });
      target = 'https://chatgpt.com/backend-api/codex/responses';
      if (body.stream !== true) throw new UserError('Codex 登录账号需要 stream=true', 422);
      body.store = false;
      body.instructions ??= '';
      if (typeof body.input === 'string') {
        body.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }];
      }
    }
  } else if (kind === 'key') {
    headers['x-goog-api-key'] = key;
    target = 'https://generativelanguage.googleapis.com' + url.pathname + (url.searchParams.get('alt') === 'sse' ? '?alt=sse' : '');
  } else {
    const [, model, action] = url.pathname.match(/\/models\/([^:]+):(.*)$/);
    const project = await cloudProject(account);
    if (!project) throw new UserError('该账号没有可用的 Google Cloud 项目', 422);
    headers.authorization = 'Bearer ' + token.access;
    target = antigravityCloud(account) + '/v1internal:' + action + (action === 'streamGenerateContent' ? '?alt=sse' : '');
    body = { project, model, request: body };
  }
  return { target, headers, body: JSON.stringify(body) };
}

export async function wakeModel(account, model) {
  const prompt = 'Reply only with OK.';
  const requests = {
    codex: ['/v1/responses', { model, input: prompt, stream: true }],
    antigravity: ['/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 16 }
    }]
  };
  const [path, body] = requests[account.provider];
  const options = await upstream(account, new URL(path, 'http://127.0.0.1'), body);
  let result;
  let output;
  try {
    result = await fetch(options.target, { method: 'POST', headers: options.headers, body: options.body,
      redirect: 'error', signal: AbortSignal.timeout(45_000) });
    output = await result.text();
  } catch { throw new UserError('唤醒请求超时或连接失败', 502); }
  if (!result.ok) throw new UserError('模型服务返回 HTTP ' + result.status, result.status);
  if (result.headers.get('content-type')?.includes('text/event-stream')) {
    if (!/"type"\s*:\s*"response\.completed"/.test(output) || /"type"\s*:\s*"(?:error|response\.failed)"/.test(output)) {
      throw new UserError('模型没有完成测试请求', 502);
    }
  }
}

async function* geminiEvents(chunks) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  for await (const chunk of chunks) {
    pending += decoder.write(chunk);
    const lines = pending.split('\n');
    pending = lines.pop();
    if (pending.length > 4_000_000) throw new UserError('上游事件过大', 502);
    for (const line of lines) {
      if (line.startsWith('data:')) {
        let event;
        try { event = JSON.parse(line.slice(5)); }
        catch { event = null; }
        if (event?.response) {
          yield 'data: ' + JSON.stringify(event.response) + '\n';
          continue;
        }
      }
      yield line + '\n';
    }
  }
  if (pending) yield pending + decoder.end();
}

function usesStoredContext(body) {
  return Boolean(body.previous_response_id || body.conversation ||
    Array.isArray(body.input) && body.input.some(item => item?.type === 'item_reference'));
}

function codexQuota(account, now) {
  if (!account.quotaAt || now - account.quotaAt > 30 * 60_000) return 0.5;
  const windows = account.quota.filter(item => /^(每周|\d+ (周|天|小时|分钟))窗口$/.test(item.label) &&
    Number.isFinite(item.remaining) && (!item.resetAt || item.resetAt > now));
  return windows.length ? Math.min(...windows.map(item => item.remaining)) : 0.5;
}

function cooldownEnd(status, retryAfter) {
  const now = Date.now();
  const retryAt = /^\d+$/.test(retryAfter || '') ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
  return Math.max(now + 1000, Number.isFinite(retryAt) ? retryAt : now + (status === 401 ? 120_000 : 60_000));
}

export function createRelay({ state, resolveAccount, log }) {
  let listener;
  let actualPort;
  const rotations = new Map();
  const sessions = new Map();
  const health = new Map();

  function remember(session, id, confirmed = true) {
    if (!session) return;
    const now = Date.now();
    if (!confirmed && sessions.get(session)?.expires > now) return;
    sessions.delete(session);
    sessions.set(session, { id, confirmed, expires: now + (confirmed ? 60 * 60_000 : 30_000) });
    if (sessions.size > 500) sessions.delete(sessions.keys().next().value);
  }

  function selectAccounts(config, provider, pathname, body, session, storedContext, accountBound) {
    const ids = config.routes[provider] || [];
    if (!ids.length) throw new UserError('请先将该平台的账号加入 API 服务', 503);
    let candidates = ids.map(id => config.accounts.find(item => item.id === id)).filter(Boolean);
    if (provider === 'codex' && (pathname === '/v1/chat/completions' || body.stream !== true || storedContext)) {
      candidates = candidates.filter(item => item.kind === 'key');
      if (!candidates.length) throw new UserError('Codex 登录账号需要使用流式 Responses，并提交完整的输入上下文', 422);
    }
    const now = Date.now();
    const binding = sessions.get(session);
    const pinned = binding?.expires > now && (!accountBound || binding.confirmed) ? binding.id : null;
    if (accountBound) {
      if (pinned) candidates = candidates.filter(item => item.id === pinned);
      if (candidates.length !== 1) throw new UserError('此请求引用已存储的会话，请沿用原会话标识或提交完整上下文', 409);
    }
    candidates = candidates.filter(item => !(health.get(item.id)?.until > now));
    if (!candidates.length) throw new UserError('账号池暂无可用成员，请等待冷却结束或检查账号登录', 503);
    const slot = pathname.startsWith('/v1/') ? pathname : provider;
    const offset = (rotations.get(slot) || 0) % candidates.length;
    const ordered = [...candidates.slice(offset), ...candidates.slice(0, offset)];
    if (provider === 'codex' && config.relayStrategy === 'quota-first') {
      ordered.sort((a, b) => codexQuota(b, now) - codexQuota(a, now));
    }
    const preferred = ordered.findIndex(item => item.id === pinned);
    if (preferred >= 0) ordered.unshift(...ordered.splice(preferred, 1));
    else rotations.set(slot, offset + 1);
    return ordered.slice(0, accountBound ? 1 : 3);
  }

  async function serve(request, response) {
    const start = Date.now();
    const stop = new AbortController();
    response.on('close', () => stop.abort());
    let pathname = '';
    let provider;
    let account;
    let status = 500;
    const attempts = [];
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      pathname = url.pathname;
      if (!['127.0.0.1:' + actualPort, 'localhost:' + actualPort].includes(request.headers.host) || request.headers.origin) {
        throw new UserError('本机中转仅接受本地客户端请求', 403);
      }
      if (request.method === 'GET' && pathname === '/health') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }
      const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /i, '') ||
        request.headers['x-api-key'] || request.headers['x-goog-api-key'] || '');
      const expected = Buffer.from(state().relayKey);
      if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) throw new UserError('中转密钥无效', 401);
      if (request.method !== 'POST') throw new UserError('该接口仅接受 POST', 405);
      provider = identify(pathname);
      const body = await readJson(request, 8_000_000);
      const identifier = request.headers.session_id || request.headers['x-session-id'] || request.headers['x-codex-session-id'];
      const session = provider === 'codex' && typeof identifier === 'string' && identifier.length <= 128 ? pathname + '/' + identifier : null;
      const storedContext = provider === 'codex' && usesStoredContext(body);
      const accountBound = storedContext || provider === 'codex' && Array.isArray(body.input) && body.input.some(item => item?.encrypted_content);
      const candidates = selectAccounts(state(), provider, pathname, body, session, storedContext, accountBound);
      if (!accountBound) remember(session, candidates[0].id, false);
      let result;
      let prepareError;
      for (const member of candidates) {
        if (stop.signal.aborted) break;
        if (health.get(member.id)?.until > Date.now()) continue;
        let options;
        let resolved;
        try {
          resolved = await resolveAccount(member.id, provider);
          options = await upstream(resolved, url, { ...body });
        } catch (error) {
          prepareError = error;
          attempts.push({ account: member.label, status: error.status || 502 });
          if (error.status === 404) continue;
          if (error.status !== 401 && error.status !== 429) break;
          health.set(member.id, { status: error.status, until: cooldownEnd(error.status) });
          continue;
        }
        if (stop.signal.aborted) break;
        if (result) { await result.body?.cancel().catch(() => {}); result = null; }
        account = resolved;
        try {
          result = await fetch(options.target, {
            method: 'POST', headers: options.headers, body: options.body, redirect: 'error',
            signal: AbortSignal.any([stop.signal, AbortSignal.timeout(600_000)])
          });
        } catch {
          attempts.push({ account: account.label, status: 502 });
          throw new UserError('无法连接上游服务', 502);
        }
        attempts.push({ account: account.label, status: result.status });
        if (result.status !== 401 && result.status !== 429) {
          if (result.ok) remember(session, account.id);
          break;
        }
        health.set(member.id, { status: result.status, until: cooldownEnd(result.status, result.headers.get('retry-after')) });
      }
      if (!result) throw prepareError || new UserError('账号池暂无可用成员', 503);
      status = result.status;
      const type = result.headers.get('content-type') || 'application/json';
      const translateGemini = result.ok && provider === 'antigravity' && account.kind === 'oauth';
      if (translateGemini && type.includes('application/json')) {
        const data = await result.json();
        sendJson(response, status, data.response ?? data);
        return;
      }
      response.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
      });
      if (result.body) {
        const stream = Readable.fromWeb(result.body);
        if (translateGemini && type.includes('text/event-stream')) await pipeline(stream, geminiEvents, response);
        else await pipeline(stream, response);
      }
      else response.end();
    } catch (error) {
      status = error.status || 502;
      if (!response.headersSent && !response.destroyed) sendJson(response, status, { error: { message: error instanceof UserError ? error.message : '中转请求失败' } });
      else if (!response.writableEnded) response.destroy();
    } finally {
      if (provider) await log({ provider, account: account?.label || attempts.at(-1)?.account || '', attempts,
        endpoint: pathname, status, duration: Date.now() - start, time: start }).catch(() => {});
    }
  }

  return {
    status: () => ({ running: Boolean(listener?.listening), port: actualPort || state().relayPort,
      health: Object.fromEntries(Object.values(state().routes).flat().filter(id => health.get(id)?.until > Date.now())
        .map(id => [id, health.get(id)])) }),
    async start(port) {
      if (listener) throw new UserError('请先停止当前服务');
      const server = createServer((request, response) => void serve(request, response));
      listener = server;
      actualPort = port;
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolve);
        });
      } catch {
        listener = null;
        actualPort = null;
        throw new UserError('无法监听端口，请换一个端口', 409);
      }
    },
    async stop() {
      const server = listener;
      if (!server) return;
      listener = null;
      actualPort = null;
      sessions.clear();
      rotations.clear();
      health.clear();
      const closing = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closing;
    }
  };
}
