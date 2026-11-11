import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { usageFiles } from './sessions.mjs';
import { providers } from './providers.mjs';
import { catalogCost } from './model-pricing.mjs';
import { firstPackedVarint, protoField } from './protobuf.mjs';
import { UserError } from './storage.mjs';

const dayMs = 86_400_000;
const fileCache = new Map();
const codexTypes = /"token_usage_record"|"token_count"|"turn_context"|"session_meta"/;
const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const text = value => typeof value === 'string' ? value.trim() : '';

function time(value) {
  return typeof value === 'number' ? value * (value < 1e11 ? 1000 : 1) : Date.parse(value);
}

function codexTokens(row) {
  const input = tokenCount(row?.input_tokens);
  const cached = Math.min(input, tokenCount(row?.cached_input_tokens));
  const output = tokenCount(row?.output_tokens);
  const write = Math.min(input - cached, tokenCount(row?.cache_write_input_tokens));
  return { input, cached, output, write, total: tokenCount(row?.total_tokens) || input + output };
}

function delta(after, before) {
  if (!before || after.total <= before.total) return null;
  return Object.fromEntries(Object.keys(after).map(key => [key, Math.max(0, after[key] - before[key])]));
}

async function* jsonLines(file, filter) {
  if (!file.size) return;
  const input = createReadStream(file.path, { end: file.size - 1, encoding: 'utf8' });
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!filter.test(line)) continue;
      let row;
      try { row = JSON.parse(line); }
      catch { continue; }
      if (row && typeof row === 'object') yield row;
    }
  } finally { input.destroy(); }
}

async function codexEvents(file) {
  const modern = [];
  const legacy = [];
  const turnModels = new Map();
  let model = '';
  let previous;
  let branchStart = 0;
  for await (const row of jsonLines(file, codexTypes)) {
    const payload = row.payload;
    if (!payload) continue;
    if (row.type === 'session_meta') {
      if (payload.forked_from_id || payload.parent_thread_id || payload.source?.subagent) {
        branchStart ||= time(payload.timestamp || row.timestamp) || 0;
      }
      model = text(payload.model) || model;
    } else if (row.type === 'turn_context') {
      model = text(payload.model || payload.info?.model) || model;
      if (payload.turn_id && model) turnModels.set(payload.turn_id, model);
    } else if (row.type === 'token_usage_record') {
      const tokens = codexTokens(payload.usage);
      if (tokens.total && (!payload.thread_id || text(payload.thread_id).toLowerCase() === file.id.toLowerCase())) {
        modern.push({ ...tokens, at: time(row.timestamp), key: text(payload.response_id),
          model: text(payload.model || payload.model_slug) || turnModels.get(payload.turn_id) || turnModels.get(payload.root_turn_id) || model });
      }
    } else if (row.type === 'event_msg' && payload.type === 'token_count' && payload.info?.total_token_usage) {
      const at = time(row.timestamp);
      const totals = codexTokens(payload.info.total_token_usage);
      if (at < branchStart) continue;
      const last = codexTokens(payload.info.last_token_usage);
      const usage = last.total ? last : delta(totals, previous);
      if (usage?.total && (!previous || totals.total > previous.total)) {
        legacy.push({ ...usage, at, model: text(payload.info.model) || model });
      }
      if (!previous || totals.total > previous.total) previous = totals;
    }
  }
  // Modern rollouts also emit cumulative UI snapshots for the same responses.
  // Legacy events preceding the first modern request may come from an older client.
  const firstModern = modern.find(event => Number.isFinite(event.at));
  return firstModern ? [...legacy.filter(event => event.at < firstModern.at), ...modern] : legacy;
}

function antigravityTokens(input, cached, output, write) {
  const hits = tokenCount(cached);
  const writes = tokenCount(write);
  const prompt = tokenCount(input) + hits + writes;
  const completion = tokenCount(output);
  return { input: prompt, cached: hits, output: completion, write: writes, total: prompt + completion };
}

function protoText(value) {
  return value instanceof Uint8Array && value.length <= 128 ? Buffer.from(value).toString('utf8').trim() : '';
}

function antigravityDatabaseEvents(file) {
  const url = pathToFileURL(file.database.path);
  // Closed databases in WAL mode can lack the sidecars SQLite needs for a normal read-only open.
  if (!file.walSize) url.searchParams.set('immutable', '1');
  const db = new DatabaseSync(url, { readOnly: true });
  try {
    const models = new Map();
    // Each generation links to its planner step followed by any tool steps.
    for (const { data } of db.prepare('SELECT data FROM gen_metadata ORDER BY idx').iterate()) {
      const idx = firstPackedVarint(protoField(data, 2));
      const generation = protoField(data, 1);
      const model = protoText(protoField(generation, 21)) || protoText(protoField(generation, 19));
      if (Number.isSafeInteger(idx) && model) models.set(idx, model);
    }
    const events = new Map();
    for (const { idx, metadata } of db.prepare('SELECT idx, metadata FROM steps WHERE step_type = 15 AND status = 3').iterate()) {
      const usage = protoField(metadata, 9);
      const tokens = antigravityTokens(protoField(usage, 2), protoField(usage, 5), protoField(usage, 3), protoField(usage, 4));
      const createdAt = protoField(metadata, 1);
      const seconds = protoField(createdAt, 1);
      const at = seconds * 1000 + (protoField(createdAt, 2) || 0) / 1_000_000;
      if (tokens.total || models.has(idx)) events.set(file.id + '/' + idx, { ...tokens, at, model: models.get(idx) || '' });
    }
    return events;
  } finally { db.close(); }
}

async function antigravityEvents(file) {
  let database = new Map();
  if (file.database) {
    try { database = antigravityDatabaseEvents(file); }
    catch (error) { if (!file.hasTranscript) throw error; }
  }
  const events = [];
  if (file.hasTranscript !== false) {
    for await (const row of jsonLines(file, /"PLANNER_RESPONSE"/)) {
      if (row.type !== 'PLANNER_RESPONSE' || row.status !== 'DONE') continue;
      const key = Number.isSafeInteger(row.step_index) ? file.id + '/' + row.step_index : '';
      const recorded = database.get(key);
      database.delete(key);
      const tokens = recorded?.total ? recorded : antigravityTokens(row.input_tokens, row.cache_read_tokens,
        row.output_tokens, row.cache_write_tokens);
      if (!tokens.total) continue;
      const at = time(row.created_at || row.timestamp);
      events.push({ ...tokens, at: Number.isFinite(at) ? at : recorded?.at,
        model: recorded?.model || text(row.model || row.model_id), key });
    }
  }
  for (const [key, row] of database) {
    if (row.total) events.push({ ...row, key });
  }
  return events;
}

const readEvents = { codex: codexEvents, antigravity: antigravityEvents };

function fileEvents(provider, file) {
  const previous = fileCache.get(file.path);
  if (previous?.size === file.size && previous.updatedAt === file.updatedAt && previous.revision === file.revision) return previous.events;
  const events = readEvents[provider](file).catch(() => {
    if (fileCache.get(file.path)?.events === events) fileCache.delete(file.path);
    return null;
  });
  fileCache.set(file.path, { size: file.size, updatedAt: file.updatedAt, revision: file.revision, events });
  return events;
}

// Offline reference prices in USD per million tokens.
const codexRates = new Map(Object.entries({
  'gpt-6-astra': [10, 1, 50, 12.5, 272_000],
  'gpt-6.1-sol': [2, 0.10, 10, 2.5, 272_000],
  'gpt-6.1-terra': [1, 0.05, 5, 1.25, 272_000],
  'gpt-6-sol': [2, 0.20, 10, 2.5, 272_000],
  'gpt-6-luna': [0.10, 0.01, 0.50, 0.125, 272_000],
  'gpt-5.6-luna': [0.20, 0.02, 1.20, 0.25, 272_000],
  'gpt-5.3-codex': [1.75, 0.175, 14],
  'gpt-5.2-codex': [1.75, 0.175, 14],
  'gpt-5.1-codex': [1.25, 0.125, 10],
  'gpt-5-codex': [1.25, 0.125, 10]
}));
const antigravityRates = new Map(Object.entries({
  'gemini-4-argon': [4, 0.20, 20],
  'gemini-4-carbon': [7.20, 0.36, 36],
  'gemini-3.8-flash': [1.50, 0.15, 7.50],
  'gemini-3.7-flash': [1.50, 0.15, 7.50],
  'gemini-3.6-flash': [1.50, 0.15, 7.50],
  'gemini-3.5-flash': [1.50, 0.15, 9],
  'gemini-3.5-flash-lite': [0.30, 0.03, 2.50],
  'gemini-3.1-pro': [2, 0.20, 12, 0, 200_000],
  'gemini-3.1-flash-lite': [0.25, 0.025, 1.50],
  'gemini-2.5-pro': [1.25, 0.125, 10, 0, 200_000],
  'gemini-2.5-flash': [0.30, 0.03, 2.50],
  'gemini-2.5-flash-lite': [0.10, 0.01, 0.40],
  'claude-sonnet-5-5': [2, 0.10, 10, 2.50],
  'claude-opus-5-5': [4, 0.20, 20, 5],
  'claude-sonnet-4-6': [3, 0.30, 15, 3.75],
  'claude-opus-4-6': [5, 0.50, 25, 6.25],
  'gpt-oss-120b': [0.09, 0.09, 0.36]
}));

function antigravityRateId(model) {
  return model.replace(/[()]/g, '').trim().replace(/\s+/g, '-')
    .replace(/(?:-(?:minimal|low|medium|high|max|thinking))+$/, '')
    .replace(/^(claude-[a-z]+-\d+)\.(\d+)(?=-|$)/, '$1-$2');
}

function costOf(provider, event, prices) {
  if (event.total && !event.input && !event.output) return null;
  const codex = provider === 'codex';
  const recorded = event.model.toLowerCase();
  const id = codex ? recorded : antigravityRateId(recorded);
  const model = id.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  const alias = model === 'gemini-4-argon-trial' ? 'gemini-4-argon' :
    model === 'gemini-3.1-pro-preview' ? 'gemini-3.1-pro' :
    model === 'gemini-3.1-pro' ? 'gemini-3.1-pro-preview' : model;
  const vendors = codex ? ['openai'] : model.startsWith('claude-') ? ['anthropic', 'vertex_ai'] : ['vertex_ai', 'gemini'];
  const current = catalogCost(prices?.rates, vendors, [id, model, alias], event);
  if (current !== null) return current;
  const rate = codex ? codexRates.get(model) : antigravityRates.get(model) || antigravityRates.get(alias);
  if (!rate) return null;
  const [input, cached, output, write, threshold] = rate;
  const long = threshold && event.input > threshold;
  const promptScale = long ? 2 : 1;
  const outputScale = long ? 1.5 : 1;
  const writeCost = event.write * (write ?? input) * promptScale;
  return ((event.input - event.cached - event.write) * input * promptScale +
    event.cached * cached * promptScale + event.output * output * outputScale + writeCost) / 1_000_000;
}

function emptyTotals() {
  return { input: 0, cached: 0, output: 0, total: 0, requests: 0, cost: null, unpriced: 0 };
}

function add(totals, event, cost) {
  for (const key of ['input', 'cached', 'output', 'total']) totals[key] += event[key];
  totals.requests++;
  if (cost === null) totals.unpriced++;
  else totals.cost = (totals.cost ?? 0) + cost;
}

export async function sessionUsage(days = 7, provider = 'all', loadPrices) {
  if (![1, 7, 30].includes(days) || provider !== 'all' && !providers.includes(provider)) {
    throw new UserError('请选择有效的用量范围');
  }
  const to = Date.now();
  const from = to - days * dayMs;
  for (const [path, info] of fileCache) if (info.updatedAt < to - 31 * dayMs) fileCache.delete(path);
  const totals = emptyTotals();
  const models = new Map();
  const seen = new Set();
  const sources = provider === 'all' ? providers : [provider];
  const [groups, prices] = await Promise.all([
    Promise.all(sources.map(async source => (await usageFiles(source, from)).map(file => ({ ...file, provider: source })))),
    loadPrices?.()
  ]);
  const files = groups.flat();
  let unreadable = 0;
  for (let start = 0; start < files.length; start += 8) {
    const batch = files.slice(start, start + 8);
    const rows = await Promise.all(batch.map(file => fileEvents(file.provider, file)));
    rows.forEach((events, index) => {
      const source = batch[index].provider;
      if (!events) { unreadable++; return; }
      for (const event of events) {
        if (!Number.isFinite(event.at) || event.at < from || event.at > to) continue;
        const id = event.key ? source + '/' + event.key : '';
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const key = source + '/' + event.model;
        if (!models.has(key)) models.set(key, { provider: source, model: event.model, ...emptyTotals() });
        const cost = costOf(source, event, prices);
        add(totals, event, cost);
        add(models.get(key), event, cost);
      }
    });
  }
  return { from, to, totals, unreadable, pricingUpdatedAt: prices?.updatedAt ?? null,
    byModel: [...models.values()].sort((a, b) => b.total - a.total) };
}
