import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { machine, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { antigravityCloud, readAntigravityDesktopQuota } from './providers.mjs';
import { UserError, windows } from './storage.mjs';
import { protoField } from './protobuf.mjs';

const service = '/exa.language_server_pb.LanguageServerService/';

function varint(value) {
  const bytes = [];
  while (value >= 128) {
    bytes.push(value % 128 + 128);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function bytesField(number, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

const numberField = (number, value) => Buffer.concat([varint(number * 8), varint(value)]);

function frame(bytes) {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

function firstFrame(bytes) {
  if (bytes.length < 5 || bytes[0] !== 0 || bytes.readUInt32BE(1) > bytes.length - 5) {
    throw new Error('Invalid Connect frame');
  }
  return bytes.subarray(5, 5 + bytes.readUInt32BE(1));
}

async function readBody(stream, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw new Error('Response is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function loginUpdate(token) {
  const expiry = Math.max(0, Math.floor((token.expires || 0) / 1000));
  const oauth = Buffer.concat([
    bytesField(1, token.access), bytesField(2, 'Bearer'), bytesField(3, token.refresh || ''),
    ...(expiry ? [bytesField(4, numberField(1, expiry))] : []),
    ...(token.idToken ? [bytesField(5, token.idToken)] : []),
    ...(token.gcpTos ? [numberField(6, 1)] : [])
  ]);
  const row = bytesField(1, oauth.toString('base64'));
  const entry = Buffer.concat([bytesField(1, 'oauthTokenInfoSentinelKey'), bytesField(2, row)]);
  return bytesField(1, bytesField(1, entry));
}

function createExtension(token, secret, ready, loginSent) {
  return createServer(async (req, res) => {
    if (req.method !== 'POST' || req.headers['x-codeium-csrf-token'] !== secret) {
      res.writeHead(403).end();
      return;
    }
    try {
      const method = req.url.split('/').at(-1);
      const raw = await readBody(req, 512_000);
      const content = req.headers['content-type'] || 'application/proto';
      const framed = content.startsWith('application/connect+proto');
      const body = framed ? firstFrame(raw) : raw;
      let reply = Buffer.alloc(0);
      if (method === 'LanguageServerStarted') {
        const port = protoField(body, 1);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid language server port');
        ready(port);
      } else if (method === 'SubscribeToUnifiedStateSyncTopic') {
        const topic = protoField(body, 1)?.toString();
        reply = topic === 'uss-oauth' ? loginUpdate(token) : bytesField(1, Buffer.alloc(0));
        res.writeHead(200, { 'content-type': 'application/connect+proto' });
        res.write(frame(reply), error => {
          if (!error && topic === 'uss-oauth') loginSent();
        });
        return;
      } else if (method === 'IsAgentManagerEnabled') reply = numberField(1, 1);
      res.writeHead(200, { 'content-type': content }).end(framed ? frame(reply) : reply);
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
}

function languageError(code, message) {
  const reason = typeof message === 'string' ? message : '';
  if (code === 401 || code === 16 || /UNAUTHENTICATED/i.test(reason)) {
    return new UserError('Antigravity 桌面服务需要重新登录，请重新导入该账号', 401);
  }
  if (code === 403 || code === 7 || /PERMISSION_DENIED|VALIDATION_REQUIRED|\b403\b/i.test(reason)) {
    const next = /VALIDATION_REQUIRED/i.test(reason) ? '请在官方客户端完成账号验证后重试' : '请在客户端确认账号或模型权限';
    return new UserError('Antigravity 拒绝了桌面唤醒（403），' + next, 403);
  }
  if (code === 429 || code === 8 || /RESOURCE_EXHAUSTED|\b429\b/i.test(reason)) {
    return new UserError('Antigravity 模型额度不足或请求过于频繁（429）', 429);
  }
  return new UserError('Antigravity 桌面服务未能完成模型请求', 502);
}

function rpc(port, secret, method, payload, timeout = 15_000) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request({
      // The port comes from our own child's authenticated loopback callback.
      hostname: '127.0.0.1', port, path: service + method, method: 'POST', agent: false,
      rejectUnauthorized: false, signal: AbortSignal.timeout(timeout),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        'connect-protocol-version': '1', 'x-codeium-csrf-token': secret }
    }, async res => {
      try {
        const raw = await readBody(res, 4_000_000);
        const data = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        if (res.statusCode >= 400) throw languageError(res.statusCode, data?.message || data?.error?.message);
        resolve(data);
      } catch (error) {
        reject(error instanceof UserError ? error : languageError(res.statusCode));
      }
    });
    req.on('error', () => reject(new UserError('Antigravity 桌面服务连接失败或超时', 502)));
    req.end(body);
  });
}

function stepValue(step, key) {
  return step?.[key] ?? (step?.step?.case === key ? step.step.value : undefined);
}

async function awaitModelReply(call, cascadeId) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    const result = await call('GetCascadeTrajectory', { cascadeId });
    const running = /RUNNING|PENDING/i.test(result?.status ?? '');
    const steps = Array.isArray(result?.trajectory?.steps) ? result.trajectory.steps : [];
    const reply = steps.map(step => stepValue(step, 'plannerResponse')).filter(Boolean).findLast(value => {
      const text = value.modifiedResponse ?? value.response?.text ?? value.response;
      if (typeof text === 'string' && text.trim()) return true;
      const parts = value.response?.candidates?.[0]?.content?.parts;
      return Array.isArray(parts) && parts.some(part => typeof part?.text === 'string' && part.text.trim());
    });
    if (reply) return;
    const error = steps.map(step => stepValue(step, 'errorMessage')).filter(Boolean).at(-1);
    if (error) {
      const code = Number(error.code ?? error.error?.code ?? error.errorCode ?? error.statusCode);
      const detail = error.message ?? error.error?.message ?? JSON.stringify(error).slice(0, 2000);
      lastError = languageError(code, detail);
      if (!running) throw lastError;
    }
    if (/FAILED|CANCELED|CANCELLED|ERROR/i.test(result?.status ?? '')) throw lastError || languageError();
    await delay(700);
  }
  throw lastError || new UserError('等待 Antigravity 模型回复超时', 504);
}

async function findRuntime() {
  const architecture = /arm64|aarch64/i.test(machine()) ? 'arm64' : 'x64';
  const bases = [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.ProgramFiles].filter(Boolean);
  for (const base of bases) {
    for (const name of ['Antigravity', 'Antigravity IDE']) {
      const root = join(base, name);
      let app;
      for (const executable of new Set(['Antigravity.exe', name + '.exe'])) {
        const candidate = join(root, executable);
        if ((await stat(candidate).catch(() => null))?.isFile()) { app = candidate; break; }
      }
      if (!app) continue;
      const extension = join(root, 'resources', 'app', 'extensions', 'antigravity');
      const bin = join(extension, 'bin');
      const entries = await readdir(bin, { withFileTypes: true }).catch(() => []);
      const alternatives = entries.filter(entry => entry.isFile() && /^language_server_windows.*\.exe$/i.test(entry.name))
        .map(entry => entry.name)
        .sort((a, b) => Number(b.toLowerCase().includes(architecture)) - Number(a.toLowerCase().includes(architecture)) || a.localeCompare(b));
      for (const binary of [join(root, 'resources', 'bin', 'language_server.exe'), ...alternatives.map(file => join(bin, file))]) {
        if (!(await stat(binary).catch(() => null))?.isFile()) continue;
        const version = await windows('file-version', app);
        return { binary, extension: (await stat(extension).catch(() => null))?.isDirectory() ? extension : root, version, name };
      }
    }
  }
  throw new UserError('未找到 Antigravity 桌面应用的 Language Server，请检查桌面应用安装', 422);
}

export async function fetchAntigravityDesktopQuota(account, expectedEmail) {
  const runtime = await findRuntime();
  const temp = tmpdir();
  const profile = await mkdtemp(join(temp, 'local-workspace-antigravity-'));
  const csrf = randomUUID();
  const started = Promise.withResolvers();
  let child;
  let stopped;
  try {
    // Standalone mode reads the current Windows shared login. Keep its workspace files in a temporary profile.
    child = spawn(runtime.binary, ['--standalone', '--override_ide_name', 'antigravity', '--subclient_type', 'hub',
      '--override_ide_version', runtime.version, '--override_user_agent_name', 'antigravity',
      '--https_server_port', '0', '--csrf_token', csrf, '--gemini_dir', profile, '--app_data_dir', 'quota',
      '--api_server_url', 'https://generativelanguage.googleapis.com', '--cloud_code_endpoint', antigravityCloud(account)],
    { windowsHide: true, cwd: profile, stdio: ['ignore', 'pipe', 'pipe'] });
    stopped = new Promise(resolve => {
      child.once('close', resolve);
      child.once('error', resolve);
    });
    for (const input of [child.stdout, child.stderr]) {
      createInterface({ input }).on('line', line => {
        const port = Number(line.match(/listening on \w+ port at (\d+) for HTTPS\b/i)?.[1]);
        if (Number.isInteger(port) && port > 0 && port <= 65535) started.resolve(port);
      });
    }
    const port = await Promise.race([
      started.promise,
      stopped.then(() => { throw new UserError('Antigravity 桌面额度服务启动失败，请检查客户端版本', 502); }),
      delay(15_000, null, { ref: false }).then(() => { throw new UserError('Antigravity 桌面额度服务启动超时', 504); })
    ]);
    const call = (method, body, timeout) => rpc(port, csrf, method, body, timeout);
    const deadline = Date.now() + 12_000;
    let connectionError;
    do {
      const auth = await call('GetAuthStatus', {}, 4000).catch(error => {
        if (error.status !== 502) throw error;
        connectionError = error;
        return null;
      });
      if (auth) connectionError = null;
      if (auth?.authResult?.hasValidAuth === true) return await readAntigravityDesktopQuota(account, expectedEmail, call);
      await delay(350);
    } while (Date.now() < deadline);
    throw connectionError || new UserError('Antigravity 桌面登录不可用，请在客户端重新登录后刷新额度', 401);
  } finally {
    await stopRuntime(child, stopped, temp, profile);
  }
}

async function stopRuntime(child, stopped, temp, profile) {
  child?.kill();
  if (stopped) await Promise.race([stopped, delay(2000, null, { ref: false })]);
  if (/^local-workspace-antigravity-[a-zA-Z0-9]+$/.test(relative(temp, profile))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => {});
  }
}

export async function wakeAntigravity(account, model) {
  const runtime = await findRuntime();
  const temp = tmpdir();
  const profile = await mkdtemp(join(temp, 'local-workspace-antigravity-'));
  const extensionSecret = randomUUID();
  const csrf = randomUUID();
  const started = Promise.withResolvers();
  const loginSent = Promise.withResolvers();
  const extension = createExtension(account.token, extensionSecret, started.resolve, loginSent.resolve);
  let child;
  let stopped;
  try {
    extension.listen(0, '127.0.0.1');
    await once(extension, 'listening');
    child = spawn(runtime.binary, ['--enable_lsp', '--csrf_token', csrf,
      '--extension_server_port', String(extension.address().port), '--extension_server_csrf_token', extensionSecret,
      '--cloud_code_endpoint', antigravityCloud(account), '--gemini_dir', profile, '--app_data_dir', 'wake'],
    { windowsHide: true, cwd: profile, stdio: ['pipe', 'ignore', 'ignore'] });
    stopped = new Promise(resolve => {
      child.once('close', resolve);
      child.once('error', resolve);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.concat([
      bytesField(1, runtime.name), bytesField(4, 'zh-CN'), bytesField(7, runtime.version || ''),
      bytesField(12, 'antigravity'), bytesField(17, runtime.extension)
    ]));
    const port = await Promise.race([
      Promise.all([started.promise, loginSent.promise]).then(([port]) => port),
      stopped.then(() => { throw new UserError('Antigravity Language Server 提前退出，请检查桌面版本', 502); }),
      delay(60_000, null, { ref: false }).then(() => { throw new UserError('Antigravity Language Server 启动超时', 504); })
    ]);
    const call = (method, body, timeout) => rpc(port, csrf, method, body, timeout);
    const { cascadeId } = await call('StartCascade', { source: 'CORTEX_TRAJECTORY_SOURCE_INTERACTIVE_CASCADE' });
    if (typeof cascadeId !== 'string' || !cascadeId) throw languageError();
    try {
      await call('SendUserCascadeMessage', {
        cascadeId, items: [{ text: 'Reply only with OK. Do not use any tools.' }],
        cascadeConfig: { plannerConfig: { requestedModel: { model }, maxOutputTokens: 256 },
          checkpointConfig: { maxOutputTokens: 256 } }
      });
      await awaitModelReply(call, cascadeId);
    } finally {
      await call('DeleteCascadeTrajectory', { cascadeId }, 4000).catch(() => {});
    }
  } finally {
    extension.close();
    extension.closeAllConnections();
    await stopRuntime(child, stopped, temp, profile);
  }
}
