import { join } from 'node:path';
import { atomicWrite, optionalFile, parseJson } from './storage.mjs';

const catalogUrl = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const day = 86_400_000;
const retryDelay = 15 * 60_000;
const vendors = new Set(['openai', 'vertex_ai', 'gemini', 'anthropic']);
const textModes = new Set(['chat', 'responses', 'completion']);
const columns = ['input_cost_per_token', 'cache_read_input_token_cost', 'output_cost_per_token', 'cache_creation_input_token_cost'];
const rate = value => Number.isFinite(value) && value >= 0 && value < 1;

function standardRates(row) {
  const base = columns.map(key => rate(row[key]) ? row[key] : null);
  if (base[0] === null || base[2] === null || !(base[0] || base[2])) return null;
  const tiers = new Map();
  for (const key of Object.keys(row)) {
    const match = key.match(/^(.+)_above_(\d+)k_tokens$/);
    if (!match || !columns.includes(match[1]) || !rate(row[key])) continue;
    const threshold = Number(match[2]) * 1000;
    if (!Number.isSafeInteger(threshold) || threshold <= 0) continue;
    const column = tiers.get(threshold) || {};
    column[match[1]] = row[key];
    tiers.set(threshold, column);
  }
  let previous = base;
  const longContext = [...tiers].sort(([a], [b]) => a - b).map(([threshold, values]) => {
    previous = columns.map((key, i) => values[key] ?? previous[i]);
    return [threshold, previous];
  });
  return { base, tiers: longContext };
}

function normalize(entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Invalid pricing catalog');
  const rates = new Map();
  const rows = {};
  for (const [key, row] of Object.entries(entries)) {
    const vendor = row?.litellm_provider;
    if (!vendors.has(vendor) || !textModes.has(row.mode)) continue;
    const model = key.startsWith(vendor + '/') ? key.slice(vendor.length + 1) : key;
    if (!/^[a-z0-9][a-z0-9._:-]{0,150}$/i.test(model)) continue;
    const value = standardRates(row);
    if (!value) continue;
    const id = vendor + '/' + model.toLowerCase();
    if (rates.has(id) && key.includes('/')) continue;
    rows[key] = row;
    rates.set(id, value);
  }
  if (!rates.size) throw new Error('Empty pricing catalog');
  return { rates, rows };
}

export function createPricingCatalog(directory) {
  const file = join(directory, 'model-pricing.json');
  let current = { rates: new Map(), updatedAt: null };
  let nextCheck = 0;
  let pending;
  const readCache = (async () => {
    try {
      const raw = await optionalFile(file);
      if (!raw) return;
      const { updatedAt, rows } = parseJson(raw);
      if (!Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > Date.now()) return;
      current = { rates: normalize(rows).rates, updatedAt };
      nextCheck = updatedAt + day;
    } catch {}
  })();

  return async () => {
    await readCache;
    if (pending) return pending;
    if (Date.now() < nextCheck) return current;
    pending = (async () => {
      try {
        const response = await fetch(catalogUrl, { redirect: 'error', signal: AbortSignal.timeout(8000) });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('Pricing catalog request failed');
        }
        const { rates, rows } = normalize(await response.json());
        const updatedAt = Date.now();
        current = { rates, updatedAt };
        nextCheck = updatedAt + day;
        await atomicWrite(file, JSON.stringify({ updatedAt, rows })).catch(() => {});
      } catch {
        nextCheck = Date.now() + retryDelay;
      }
      return current;
    })().finally(() => { pending = undefined; });
    return pending;
  };
}

export function catalogCost(rates, sources, models, { input, cached, write, output }) {
  if (!rates?.size) return null;
  for (const model of new Set(models)) {
    for (const vendor of sources) {
      const found = rates.get(vendor + '/' + model);
      if (!found) continue;
      const selected = found.tiers.findLast(([threshold]) => input > threshold)?.[1] || found.base;
      const [promptRate, readRate, outputRate, writeRate] = selected;
      return (input - cached - write) * promptRate + cached * (readRate ?? promptRate) +
        write * (writeRate ?? promptRate) + output * outputRate;
    }
  }
  return null;
}
