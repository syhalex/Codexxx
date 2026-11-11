import { open, opendir, stat } from 'node:fs/promises';
import { basename, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { roots } from './providers.mjs';
import { UserError } from './storage.mjs';
import { protoField, protoFields } from './protobuf.mjs';

const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sessionLimit = 300;
let index = new Map();
let cacheUntil = 0;
let scanning;

async function entries(directory) {
  const entries = [];
  try {
    for await (const entry of await opendir(directory)) entries.push(entry);
  } catch (error) {
    if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
  }
  return entries;
}

async function readSlice(path, limit, tail = false) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const position = tail ? Math.max(0, size - limit) : 0;
    const buffer = Buffer.alloc(Math.min(limit, size));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    return buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/).slice(position ? 1 : 0);
  } finally { await file.close(); }
}

function records(lines) {
  return lines.flatMap(line => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' ? [value] : [];
    } catch { return []; }
  });
}

function textContent(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter(item => item && ['text', 'input_text', 'output_text'].includes(item.type))
    .map(item => item.text).filter(Boolean).join('\n').trim();
}

function extractMessages(provider, rows, limit = 18_000) {
  return rows.flatMap(row => {
    if (provider === 'antigravity') {
      const role = { USER_INPUT: 'user', PLANNER_RESPONSE: 'assistant' }[row.type];
      const text = textContent(row.content);
      return role && text && row.status === 'DONE' ? [{ role, text: text.slice(0, limit) }] : [];
    }
    const message = row.type === 'response_item' && row.payload?.type === 'message' ? row.payload : null;
    if (!message || !['user', 'assistant'].includes(message.role)) return [];
    const text = textContent(message.content);
    if (!text || /^(<environment_context>|<local-command-caveat>|# AGENTS\.md instructions)/.test(text)) return [];
    return [{ role: message.role, text: text.slice(0, limit) }];
  });
}

async function candidates(directory, depth, expression, limit = sessionLimit, since = 0) {
  const output = [];
  async function visit(path, level) {
    if (output.length >= limit * 8) return;
    const children = (await entries(path)).sort((a, b) => b.name.localeCompare(a.name));
    for (const item of children) {
      if (output.length >= limit * 8) break;
      const full = join(path, item.name);
      if (item.isDirectory() && level > 0) await visit(full, level - 1);
      else if (item.isFile()) {
        const id = item.name.match(expression)?.[1];
        if (id) output.push({ id, path: full });
      }
    }
  }
  await visit(directory, depth);
  const enriched = [];
  for (let start = 0; start < output.length; start += 50) {
    const batch = await Promise.all(output.slice(start, start + 50).map(async item => {
      const meta = await stat(item.path).catch(() => null);
      return meta?.isFile() && meta.mtimeMs >= since ? { ...item, updatedAt: meta.mtimeMs, size: meta.size } : null;
    }));
    enriched.push(...batch.filter(Boolean));
  }
  return enriched.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

const uuidPattern = validId.source.slice(1, -1);
const codexFile = new RegExp('(' + uuidPattern + ')\\.jsonl$', 'i');
const conversationLog = new RegExp('^' + codexFile.source, 'i');
const conversationDb = new RegExp('^(' + uuidPattern + ')\\.db$', 'i');
const antigravityFile = new RegExp('^(' + uuidPattern + ')\\.(?:pb|pbtxt|db|jsonl)$', 'i');
const antigravityClients = ['antigravity-cli', 'antigravity', 'antigravity-ide'];

async function listCodexSessions() {
  const base = roots.codex;
  const [current, archived, titleLines] = await Promise.all([
    candidates(join(base, 'sessions'), 3, codexFile),
    candidates(join(base, 'archived_sessions'), 0, codexFile),
    readSlice(join(base, 'session_index.jsonl'), 768_000, true).catch(() => [])
  ]);
  const files = [...current, ...archived.map(item => ({ ...item, nativeArchived: true }))];
  const titles = new Map(records(titleLines).filter(item => typeof item.thread_name === 'string').map(item => [item.id, item.thread_name]));
  const output = [];
  for (let start = 0; start < files.length; start += 18) {
    const batch = await Promise.all(files.slice(start, start + 18).map(async ({ id, path, updatedAt, nativeArchived }) => {
      const rows = records(await readSlice(path, 112_000).catch(() => []));
      const cwd = rows.find(row => row.type === 'session_meta')?.payload?.cwd ?? rows.find(row => row.cwd)?.cwd;
      const first = extractMessages('codex', rows).find(row => row.role === 'user')?.text;
      const title = titles.get(id) || rows.find(row => row.customTitle)?.customTitle || first || basename(cwd || '') || '未命名会话';
      return { id, provider: 'codex', path, updatedAt, nativeArchived, title: String(title).replace(/\s+/g, ' ').slice(0, 140), cwd: typeof cwd === 'string' ? cwd : '' };
    }));
    output.push(...batch);
  }
  return output;
}

function agySummaries(path) {
  let database;
  try {
    database = new DatabaseSync(path, { readOnly: true, timeout: 400 });
    const columns = new Set(database.prepare('select name from pragma_table_info(?)').all('conversation_summaries').map(row => row.name));
    const id = ['cascade_id', 'conversation_id', 'id'].find(key => columns.has(key));
    const title = ['summary', 'title', 'display_title'].find(key => columns.has(key));
    const time = ['updated_at_ms', 'updated_at', 'last_modified', 'updated_unix_ms', 'last_modified_time', 'last_modified_at_ms'].find(key => columns.has(key));
    const workspace = ['workspace_uri', 'project_directory', 'workspace_directory'].find(key => columns.has(key));
    if (!id) return new Map();
    const sql = 'select ' + id + ' as id, ' + (title || "''") + ' as title, ' + (time || '0') +
      ' as time, ' + (workspace || "''") + ' as cwd, ' + (columns.has('workspace_uris') ? 'workspace_uris' : "''") + ' as workspaceUris, ' +
      (columns.has('project_id') ? 'project_id' : "''") + ' as projectId from conversation_summaries ' +
      (time ? 'order by ' + time + ' desc ' : '') + 'limit 600';
    return new Map(database.prepare(sql).all().filter(row => validId.test(row.id)).map(row => [row.id, row]));
  } catch { return new Map(); }
  finally { database?.close(); }
}

function workspaceList(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  const text = value.trim();
  if (!text.startsWith('[')) return [text];
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function workspaceProject(uris) {
  const folders = new Map();
  for (const uri of uris) {
    const project = sessionProject(uri);
    if (project && !folders.has(project.key)) folders.set(project.key, project);
  }
  const ordered = [...folders.values()].sort((a, b) => a.key.localeCompare(b.key));
  if (ordered.length < 2) return ordered[0] || null;
  return {
    ...ordered[0], key: 'workspaces/' + JSON.stringify(ordered.map(folder => folder.key)),
    name: ordered[0].name + ' 等 ' + ordered.length + ' 个目录', paths: ordered.map(folder => folder.path)
  };
}

async function antigravityProjects() {
  const folder = join(roots.antigravity, 'config', 'projects');
  const files = (await entries(folder)).filter(file => file.isFile() && file.name.endsWith('.json'));
  const configs = await Promise.all(files.map(async file => {
    try {
      const raw = (await readSlice(join(folder, file.name), 256_000)).join('\n');
      const project = JSON.parse(raw);
      const id = typeof project.id === 'string' ? project.id.trim() : '';
      if (!id || id === 'outside-of-project') return null;
      const resources = project.projectResources?.resources;
      const paths = workspaceProject(Array.isArray(resources) ? resources.map(resource => resource?.folderUri) : []);
      const name = typeof project.name === 'string' ? project.name.trim() : '';
      return [id, { ...paths, path: paths?.path || '', name: name || paths?.name || 'Antigravity 项目', key: 'antigravity-project/' + id }];
    } catch { return null; }
  }));
  return new Map(configs.filter(Boolean));
}

export function readLegacyAntigravitySummaries(path) {
  const summaries = new Map();
  let db;
  const text = value => Buffer.isBuffer(value) ? value.toString('utf8').trim() : '';
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: 400 });
    const row = db.prepare('select value from ItemTable where key = ? and length(value) <= 12000000')
      .get('antigravityUnifiedStateSync.trajectorySummaries');
    if (typeof row?.value !== 'string') return summaries;
    for (const [field, entry] of protoFields(Buffer.from(row.value, 'base64'))) {
      if (field !== 1) continue;
      try {
        const id = text(protoField(entry, 1));
        if (!validId.test(id)) continue;
        const payload = Buffer.from(text(protoField(protoField(entry, 2), 1)), 'base64');
        const workspace = protoField(payload, 9);
        const session = protoField(payload, 17);
        const uris = [protoField(workspace, 1), protoField(workspace, 2), protoField(session, 7)].map(text)
          .filter(uri => uri && uri !== 'file:///');
        const seconds = protoField(protoField(payload, 7), 1);
        summaries.set(id, { title: text(protoField(payload, 1)), uris, time: typeof seconds === 'number' ? seconds * 1000 : 0 });
      } catch {}
    }
  } catch {}
  finally { db?.close(); }
  return summaries;
}

async function antigravityTranscripts(base, limit = 1500) {
  const folders = (await entries(join(base, 'brain'))).filter(entry => entry.isDirectory() && validId.test(entry.name)).slice(0, limit);
  const output = new Map();
  for (let start = 0; start < folders.length; start += 32) {
    await Promise.all(folders.slice(start, start + 32).map(async ({ name }) => {
      const logs = join(base, 'brain', name, '.system_generated', 'logs');
      for (const file of ['transcript_full.jsonl', 'transcript.jsonl']) {
        const path = join(logs, file);
        const info = await stat(path).catch(() => null);
        if (info?.isFile()) {
          output.set(name, { id: name, path, updatedAt: info.mtimeMs, size: info.size });
          break;
        }
      }
    }));
  }
  return output;
}

async function listAntigravity() {
  const result = [];
  const projects = await antigravityProjects();
  const legacy = new Map();
  if (process.env.APPDATA && !process.env.LOCAL_WORKSPACE_GEMINI_HOME) {
    for (const app of ['Antigravity', 'Antigravity IDE']) {
      for (const [id, row] of readLegacyAntigravitySummaries(join(process.env.APPDATA, app, 'User', 'globalStorage', 'state.vscdb'))) {
        if (!legacy.has(id) || row.time >= legacy.get(id).time) legacy.set(id, row);
      }
    }
  }
  for (const client of antigravityClients) {
    const base = join(roots.antigravity, client);
    const summary = agySummaries(join(base, 'conversation_summaries.db'));
    const [files, transcripts] = await Promise.all([
      candidates(join(base, 'conversations'), 0, antigravityFile),
      antigravityTranscripts(base)
    ]);
    const filesById = new Map(files.map(file => [file.id, file]));
    const group = [];
    for (const id of new Set([...filesById.keys(), ...summary.keys(), ...transcripts.keys()])) {
      const info = summary.get(id);
      const previous = legacy.get(id);
      const file = filesById.get(id);
      const transcript = transcripts.get(id);
      const time = info?.time;
      const update = typeof time === 'number' && time > 0 ? (time < 1e11 ? time * 1000 : time) : Date.parse(time) || 0;
      const updatedAt = Math.max(update, previous?.time || 0, transcript?.updatedAt || 0, file?.updatedAt || 0);
      const workspace = workspaceProject(info ? [...workspaceList(info.workspaceUris), info.cwd] : previous?.uris || []);
      const native = projects.get(info?.projectId);
      const project = native ? { ...workspace, ...native, path: native.path || workspace?.path || '' } : workspace;
      group.push({ id, provider: 'antigravity', client, updatedAt, title: (typeof info?.title === 'string' ? info.title : '') || previous?.title || '',
        path: transcript?.path || (file?.path.endsWith('.jsonl') ? file.path : ''), cwd: workspace?.path || native?.path || '', project });
    }
    const recent = group.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, sessionLimit);
    for (let start = 0; start < recent.length; start += 18) {
      await Promise.all(recent.slice(start, start + 18).map(async item => {
        if (!item.title && item.path) {
          const rows = records(await readSlice(item.path, 64_000).catch(() => []));
          item.title = extractMessages(item.provider, rows).find(message => message.role === 'user')?.text || '';
        }
        item.title = item.title.replace(/\s+/g, ' ').slice(0, 140) || '会话 ' + item.id.slice(0, 8);
      }));
    }
    result.push(...recent);
  }
  return result;
}

export async function usageFiles(provider, since) {
  const base = roots[provider];
  let files;
  if (provider === 'codex') {
    files = (await Promise.all([
      candidates(join(base, 'sessions'), 3, codexFile, Infinity, since),
      candidates(join(base, 'archived_sessions'), 0, codexFile, Infinity, since)
    ])).flat();
  } else {
    files = (await Promise.all(antigravityClients.map(async client => {
      const folder = join(base, client);
      const conversationDir = join(folder, 'conversations');
      const [transcripts, conversations, databases] = await Promise.all([
        antigravityTranscripts(folder, Infinity),
        candidates(conversationDir, 0, conversationLog, Infinity, since),
        candidates(conversationDir, 0, conversationDb, Infinity)
      ]);
      for (const file of conversations) if (!transcripts.has(file.id)) transcripts.set(file.id, file);
      await Promise.all(databases.map(async database => {
        const wal = await stat(database.path + '-wal').catch(() => null);
        const transcript = transcripts.get(database.id);
        const updatedAt = Math.max(database.updatedAt, wal?.mtimeMs || 0, transcript?.updatedAt || 0);
        transcripts.set(database.id, { ...(transcript || database), database, updatedAt,
          walSize: wal?.size || 0, hasTranscript: Boolean(transcript),
          revision: [database.size, database.updatedAt, wal?.size, wal?.mtimeMs, transcript?.updatedAt].join('/') });
      }));
      return [...transcripts.values()];
    }))).flat().filter(file => file.updatedAt >= since);
  }
  const unique = new Map();
  for (const file of files.sort((a, b) => b.updatedAt - a.updatedAt || b.size - a.size)) {
    if (!unique.has(file.id)) unique.set(file.id, file);
  }
  return [...unique.values()];
}

export async function scanSessions(force = false) {
  if (!force && Date.now() < cacheUntil) return [...index.values()];
  if (!scanning) scanning = Promise.all([listCodexSessions(), listAntigravity()])
    .then(groups => {
      const sorted = groups.flat().sort((a, b) => b.updatedAt - a.updatedAt);
      const found = new Map();
      for (const session of sorted) {
        const key = session.provider + '/' + session.id;
        const existing = found.get(key);
        if (!existing) found.set(key, { ...session, key });
        else if (!existing.project && session.project) {
          existing.project = session.project;
          existing.cwd ||= session.cwd;
        }
      }
      index = found;
      cacheUntil = Date.now() + 20_000;
      return [...index.values()];
    }).finally(() => { scanning = null; });
  return scanning;
}

function sessionProject(cwd) {
  if (typeof cwd !== 'string') return null;
  let path = cwd.trim();
  if (!path) return null;
  if (/^file:/i.test(path)) {
    try { path = fileURLToPath(path, { windows: /^file:\/\/(?:[^/]|\/[a-z](?::|%3a)\/)/i.test(path) }); }
    catch { return null; }
  }
  const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(path);
  const paths = windows ? win32 : posix;
  if (!paths.isAbsolute(path)) return null;
  path = paths.normalize(path).replace(/[\\/]$/, '') || path;
  if (/^[a-z]:$/i.test(path)) path += '\\';
  return { path, name: paths.basename(path) || path, key: windows ? path.toLowerCase() : path };
}

export function sessionSummary(session, state) {
  const { path, nativeArchived, ...metadata } = session;
  const local = state.sessions[session.key];
  return { ...metadata, project: metadata.project || sessionProject(session.cwd), title: local?.title || metadata.title, archived: Boolean(local?.archived ?? nativeArchived),
    pinned: Boolean(local?.pinned), hasTranscript: Boolean(path) };
}

function codexUsage(session, rows) {
  if (session.provider !== 'codex') return undefined;
  const totals = rows.findLast(row => row.type === 'event_msg' && row.payload?.type === 'token_count' && row.payload?.info?.total_token_usage)
    ?.payload.info.total_token_usage;
  if (!totals) return undefined;
  const values = { input: totals.input_tokens, cached: totals.cached_input_tokens, output: totals.output_tokens, total: totals.total_tokens };
  const valid = Object.entries(values).filter(([, value]) => Number.isSafeInteger(value) && value >= 0);
  return valid.length ? Object.fromEntries(valid) : undefined;
}

export async function getSession(key, state, transcript = false, full = false) {
  await scanSessions();
  const session = index.get(key);
  if (!session) throw new UserError('本机找不到这个会话', 404);
  const summary = sessionSummary(session, state);
  if (!transcript) return summary;
  const command = { codex: 'codex resume ', antigravity: 'agy --conversation ' }[session.provider] + session.id;
  if (full && session.path) {
    const { size } = await stat(session.path);
    if (size > 24_000_000) throw new UserError('会话文件超过 24 MB', 413);
    const rows = records(await readSlice(session.path, size));
    return { ...summary, command, usage: codexUsage(session, rows), messages: extractMessages(session.provider, rows, Infinity) };
  }
  const lines = session.path ? await readSlice(session.path, 1_250_000, true).catch(() => []) : [];
  const rows = records(lines);
  return { ...summary, command, usage: codexUsage(session, rows), messages: extractMessages(session.provider, rows).slice(-60) };
}
